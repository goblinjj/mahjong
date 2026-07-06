/**
 * 麻将出牌分析器
 *
 * 基于 mahjong-engine.js 的核心算法，提供手牌分析功能:
 *   - 3k+2 张牌 (2/5/8/11/14): 出牌分析 —— 每张牌打出后的听牌情况
 *   - 3k+1 张牌 (1/4/7/10/13): 听牌分析 —— 直接给出可胡的牌
 *   - 已胡牌: 识别并返回
 *
 * 手牌数量小于 14 通常意味着已经副露(碰/杠/吃)了若干组。
 * 纯算法模块，不依赖 DOM。
 */

import {
  isWinningHand,
  getTenpaiTiles,
  getShanten,
  getUkeire,
  resetShantenCache,
  WILD_TILE,
  TILE_NAMES,
  TILE_COUNT,
  getTotalTiles
} from './mahjong-engine.js';

/** 向听数分析上限。超过则判为"距离听牌较远",不再精确计算。 */
const MAX_SHANTEN_DEPTH = 2;

/**
 * 分析手牌，根据牌数自动判断场景
 *
 * @param {Uint8Array} tiles - 牌数组(不含百搭，tiles[WILD_TILE]必须为0)
 * @param {number} wildCount - 百搭牌(红中)数量
 * @returns {Object} 分析结果，结构取决于 type 字段:
 *
 *   type='already_won':
 *     手牌已经胡了，无需操作
 *
 *   type='discard':
 *     { type, total, shanten, discards: Array<{
 *         tileIndex, tileName, isWild, shanten,
 *         ukeire: number[],   // 有效进张牌索引数组(shanten=0 时即"可胡的牌")
 *       }> }
 *     3k+2 状态。shanten 是打出后可达到的最小向听数:
 *       0 —— 存在打出令手牌听牌(discards 全部都能进入听牌)
 *       1 —— 一向听打法(ukeire 为让手牌进入听牌的牌种)
 *       2 —— 二向听打法(ukeire 为让手牌进入一向听的牌种)
 *     discards 按 ukeire.length 降序,排在前面是更优出牌。
 *
 *   type='far_from_tenpai':
 *     { type, total, minShanten }
 *     3k+2 状态但即使二向听层也无进展,通常是三向听及以上,不给出具体推荐。
 *
 *   type='tenpai':
 *     { type, total, tenpaiTiles: number[] }
 *     3k+1 状态的听牌情况(tenpaiTiles 为可胡的牌索引数组)
 *
 *   type='invalid':
 *     { type, message: string }
 */
export function analyzeHand(tiles, wildCount) {
  const total = getTotalTiles(tiles, wildCount);

  if (total <= 0 || total > 14) {
    return {
      type: 'invalid',
      message: `手牌数量不合法: ${total} 张。需要 1~14 张。`,
    };
  }

  const mod = total % 3;

  // 3k+2 状态 (2/5/8/11/14): 判胡或分析出牌
  if (mod === 2) {
    if (isWinningHand(tiles, wildCount)) {
      return { type: 'already_won' };
    }
    // 向听数递归会重复访问许多 3k+1 手状态,清空并复用记忆化缓存显著提升性能
    resetShantenCache();
    return analyzeDiscard(tiles, wildCount, total);
  }

  // 3k+1 状态 (1/4/7/10/13): 听牌分析
  if (mod === 1) {
    const tenpaiTiles = getTenpaiTiles(tiles, wildCount);
    return { type: 'tenpai', total, tenpaiTiles };
  }

  // total 为 3、6、9、12 —— 不是任何合法麻将进程状态
  return {
    type: 'invalid',
    message: `手牌数量不正确: 当前 ${total} 张。合法状态为 3k+1(1/4/7/10/13,听牌)或 3k+2(2/5/8/11/14,出牌)。`,
  };
}

/**
 * 3k+2 手牌打出推荐: 遍历所有可能的打出选择,找到最小向听数,
 * 收集所有达到该向听数的打出方案并计算进张。
 *
 * 使用自适应 maxDepth 剪枝:
 *   - 每次调用 getShanten 只需检查"是否 ≤ 当前最佳向听数"
 *   - 一旦发现打出后可听牌(shanten=0),后续调用只需极浅检查
 *   - 常见的听牌可分析情况下几乎不会触发 shanten=2 的昂贵递归
 */
function analyzeDiscard(tiles, wildCount, total) {
  const candidates = [];
  let bestShanten = MAX_SHANTEN_DEPTH;

  for (let i = 0; i < TILE_COUNT; i++) {
    if (i === WILD_TILE) continue;
    if (tiles[i] <= 0) continue;

    tiles[i]--;
    const s = getShanten(tiles, wildCount, bestShanten);
    tiles[i]++;

    if (s <= bestShanten) {
      if (s < bestShanten) {
        bestShanten = s;
        candidates.length = 0;
      }
      candidates.push({ tileIndex: i, isWild: false, shanten: s });
    }
  }

  // 打出百搭牌
  if (wildCount > 0) {
    const s = getShanten(tiles, wildCount - 1, bestShanten);
    if (s <= bestShanten) {
      if (s < bestShanten) {
        bestShanten = s;
        candidates.length = 0;
      }
      candidates.push({ tileIndex: WILD_TILE, isWild: true, shanten: s });
    }
  }

  if (candidates.length === 0 || bestShanten > MAX_SHANTEN_DEPTH) {
    return { type: 'far_from_tenpai', total, minShanten: MAX_SHANTEN_DEPTH + 1 };
  }

  // 对最优向听数下的所有打出计算有效进张
  const discards = candidates.map((c) => {
    let ukeire;
    if (c.isWild) {
      ukeire = getUkeire(tiles, wildCount - 1, bestShanten);
    } else {
      tiles[c.tileIndex]--;
      ukeire = getUkeire(tiles, wildCount, bestShanten);
      tiles[c.tileIndex]++;
    }
    return {
      tileIndex: c.tileIndex,
      tileName: TILE_NAMES[c.tileIndex],
      isWild: c.isWild,
      shanten: c.shanten,
      ukeire,
    };
  });

  discards.sort((a, b) => b.ukeire.length - a.ukeire.length);
  return { type: 'discard', total, shanten: bestShanten, discards };
}
