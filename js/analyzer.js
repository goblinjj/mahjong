/**
 * 麻将出牌分析器
 *
 * 基于 mahjong-engine.js 的核心算法，提供手牌分析功能:
 *   - 14张牌时: 分析打出每张牌后的听牌情况，推荐最优出牌
 *   - 13张牌时: 直接计算听哪些牌
 *   - 已胡牌时: 识别并返回胡牌状态
 *
 * 纯算法模块，不依赖 DOM。
 */

import {
  isWinningHand,
  getTenpaiTiles,
  WILD_TILE,
  TILE_NAMES,
  TILE_COUNT,
  createHand,
  getTotalTiles
} from './mahjong-engine.js';

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
 *     { type, discards: Array<{
 *         tileIndex: number,    // 建议打出的牌索引
 *         tileName: string,     // 牌的中文名称
 *         isWild: boolean,      // 是否为百搭牌
 *         tenpaiTiles: Array<{tileIndex, count}>,  // 打出后的听牌列表
 *         totalCount: number    // 听牌总进张数
 *       }> }
 *     discards 按 totalCount 降序排列，排在前面的是更优的出牌选择
 *
 *   type='tenpai':
 *     { type, tenpaiTiles: Array<{tileIndex, count}>, totalCount: number }
 *     13张牌时的听牌状态
 *
 *   type='invalid':
 *     { type, message: string }
 *     牌数不合法(既非13也非14张)
 */
export function analyzeHand(tiles, wildCount) {
  const total = getTotalTiles(tiles, wildCount);

  // ============================================================
  // 14张牌: 分析出牌策略
  // ============================================================
  if (total === 14) {
    // 先检查是否已经胡牌
    if (isWinningHand(tiles, wildCount)) {
      return { type: 'already_won' };
    }

    const discards = [];
    // 用 Set 记录已分析过的牌型，避免重复计算
    // (同种牌有多张时只需分析一次)
    const analyzed = new Set();

    // ---- 尝试打出每种普通牌 ----
    for (let i = 0; i < TILE_COUNT; i++) {
      // 跳过百搭牌(百搭牌单独处理)
      if (i === WILD_TILE) continue;

      // 手中没有这种牌，无法打出
      if (tiles[i] <= 0) continue;

      // 去重: 同种牌只分析一次
      if (analyzed.has(i)) continue;
      analyzed.add(i);

      // 打出1张该牌
      tiles[i] -= 1;

      // 计算打出后的听牌情况
      const tenpaiTiles = getTenpaiTiles(tiles, wildCount);
      const totalCount = tenpaiTiles.reduce((sum, t) => sum + t.count, 0);

      // 还原手牌
      tiles[i] += 1;

      // 只记录打出后能听牌的选项
      if (totalCount > 0) {
        discards.push({
          tileIndex: i,
          tileName: TILE_NAMES[i],
          isWild: false,
          tenpaiTiles,
          totalCount
        });
      }
    }

    // ---- 尝试打出百搭牌(红中) ----
    if (wildCount > 0) {
      // 打出1张百搭
      const tenpaiTiles = getTenpaiTiles(tiles, wildCount - 1);
      const totalCount = tenpaiTiles.reduce((sum, t) => sum + t.count, 0);

      if (totalCount > 0) {
        discards.push({
          tileIndex: WILD_TILE,
          tileName: TILE_NAMES[WILD_TILE],
          isWild: true,
          tenpaiTiles,
          totalCount
        });
      }
    }

    // 按听牌进张数降序排列 —— 进张数越多，选择越优
    discards.sort((a, b) => b.totalCount - a.totalCount);

    return { type: 'discard', discards };
  }

  // ============================================================
  // 13张牌: 直接计算听牌
  // ============================================================
  if (total === 13) {
    const tenpaiTiles = getTenpaiTiles(tiles, wildCount);
    const totalCount = tenpaiTiles.reduce((sum, t) => sum + t.count, 0);

    return {
      type: 'tenpai',
      tenpaiTiles,
      totalCount
    };
  }

  // ============================================================
  // 牌数不合法
  // ============================================================
  return {
    type: 'invalid',
    message: `手牌数量不正确: 当前${total}张，需要13张(听牌分析)或14张(出牌分析)`
  };
}
