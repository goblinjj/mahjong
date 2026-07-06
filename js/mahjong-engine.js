/**
 * 麻将核心算法引擎
 *
 * 支持推倒胡规则，红中(31号牌)作为百搭牌(万能替代牌)。
 * 所有函数均为纯算法，不依赖 DOM。
 *
 * 牌索引约定 (Uint8Array, 长度34):
 *   0-8:   一万 ~ 九万
 *   9-17:  一条 ~ 九条
 *   18-26: 一筒 ~ 九筒
 *   27-30: 东、南、西、北 (风牌)
 *   31:    中 (百搭牌 / 红中)
 *   32-33: 发、白 (箭牌)
 */

// ============================================================
// 常量定义
// ============================================================

/** 百搭牌(红中)在牌数组中的索引 */
export const WILD_TILE = 31;

/** 牌种类总数 */
export const TILE_COUNT = 34;

/** 每种牌的中文名称，索引与牌数组对应 */
export const TILE_NAMES = [
  '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
  '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
  '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
  '东', '南', '西', '北', '中', '发', '白'
];

// ============================================================
// 工具函数
// ============================================================

/**
 * 创建一副空手牌
 * @returns {Uint8Array} 长度为34的全零数组，表示每种牌的数量
 */
export function createHand() {
  return new Uint8Array(TILE_COUNT);
}

/**
 * 获取牌的花色
 * @param {number} tileIndex - 牌索引 (0-33)
 * @returns {'wan'|'tiao'|'tong'|'feng'|'jian'} 花色标识
 */
export function getSuit(tileIndex) {
  if (tileIndex < 9) return 'wan';    // 万子
  if (tileIndex < 18) return 'tiao';  // 条子
  if (tileIndex < 27) return 'tong';  // 筒子
  if (tileIndex < 31) return 'feng';  // 风牌 (东南西北)
  return 'jian';                      // 箭牌 (中发白)
}

/**
 * 判断是否为数牌(万/条/筒)
 * 数牌可以组成顺子，字牌不行
 * @param {number} tileIndex - 牌索引
 * @returns {boolean}
 */
export function isSuitedTile(tileIndex) {
  return tileIndex < 27;
}

/**
 * 获取数牌的点数 (1-9)
 * @param {number} tileIndex - 牌索引
 * @returns {number} 数牌返回1-9，字牌返回0
 */
export function getTileRank(tileIndex) {
  if (tileIndex >= 27) return 0;
  return (tileIndex % 9) + 1;
}

/**
 * 计算手牌总数(含百搭)
 * @param {Uint8Array} tiles - 牌数组(不含百搭)
 * @param {number} wildCount - 百搭牌数量
 * @returns {number} 手牌总数
 */
export function getTotalTiles(tiles, wildCount) {
  let sum = wildCount;
  for (let i = 0; i < TILE_COUNT; i++) {
    sum += tiles[i];
  }
  return sum;
}

// ============================================================
// 胡牌判定 - 核心算法
// ============================================================

/**
 * 判断手牌是否胡牌
 *
 * 支持任意合法手牌数量(2, 5, 8, 11, 14):
 *   - 14 张 = 4 面子 + 雀头(无副露)
 *   - 11 张 = 3 面子 + 雀头(已副露 1 组)
 *   - 8 张  = 2 面子 + 雀头(已副露 2 组)
 *   - 5 张  = 1 面子 + 雀头(已副露 3 组)
 *   - 2 张  = 仅雀头(已副露 4 组)
 *
 * 七对子只在 14 张(全暗手)时适用,副露过就不能走七对子路径。
 *
 * @param {Uint8Array} tiles - 牌数组(不含百搭，tiles[WILD_TILE]必须为0)
 * @param {number} wildCount - 百搭牌数量
 * @returns {boolean} 是否胡牌
 */
export function isWinningHand(tiles, wildCount) {
  const total = getTotalTiles(tiles, wildCount);
  if (total < 2 || (total - 2) % 3 !== 0) return false;
  const meldsNeeded = (total - 2) / 3;
  if (checkStandardWin(tiles, wildCount, meldsNeeded)) return true;
  if (total === 14 && checkSevenPairs(tiles, wildCount)) return true;
  return false;
}

/**
 * 检查标准胡牌形式: 4面子 + 1雀头
 *
 * 算法思路:
 *   枚举所有可能的雀头(对子)，雀头可以由:
 *     - 2张实牌组成
 *     - 1张实牌 + 1张百搭组成
 *     - 2张百搭组成(虚拟雀头)
 *   确定雀头后，检查剩余牌能否组成4组面子。
 *
 * @param {Uint8Array} tiles - 牌数组(原地修改后会还原)
 * @param {number} wildCount - 百搭数量
 * @param {number} meldsNeeded - 需要凑齐的面子数量(0-4,取决于副露数量)
 * @returns {boolean}
 */
function checkStandardWin(tiles, wildCount, meldsNeeded) {
  // 枚举每种牌作为雀头
  for (let p = 0; p < TILE_COUNT; p++) {
    // 情况A: 雀头由2张实牌组成
    if (tiles[p] >= 2) {
      tiles[p] -= 2;
      if (canFormMelds(tiles, wildCount, meldsNeeded)) {
        tiles[p] += 2;
        return true;
      }
      tiles[p] += 2;
    }

    // 情况B: 雀头由1张实牌 + 1张百搭组成
    if (tiles[p] >= 1 && wildCount >= 1) {
      tiles[p] -= 1;
      if (canFormMelds(tiles, wildCount - 1, meldsNeeded)) {
        tiles[p] += 1;
        return true;
      }
      tiles[p] += 1;
    }
  }

  // 情况C: 雀头由2张百搭组成(不对应任何特定牌型)
  if (wildCount >= 2) {
    if (canFormMelds(tiles, wildCount - 2, meldsNeeded)) {
      return true;
    }
  }

  return false;
}

/**
 * 递归检查剩余牌能否恰好组成指定数量的面子
 *
 * 核心策略: 找到最左边(索引最小)的非零牌，该牌必须属于某个面子。
 * 穷举该牌参与的所有可能面子组合:
 *   - 刻子: 3张相同牌(可用百搭补足)
 *   - 顺子: 3张连续数牌，起始位置可以是 i-2, i-1, 或 i
 *
 * 性能优化: 原地修改 tiles 数组，递归返回后还原，避免频繁拷贝。
 *
 * @param {Uint8Array} tiles - 牌数组(原地修改)
 * @param {number} wild - 剩余百搭数量
 * @param {number} meldsNeeded - 还需组成的面子数量
 * @returns {boolean}
 */
function canFormMelds(tiles, wild, meldsNeeded) {
  // 递归终止: 不再需要更多面子
  if (meldsNeeded === 0) {
    // 所有实牌和百搭都必须恰好用完
    let sum = 0;
    for (let i = 0; i < TILE_COUNT; i++) sum += tiles[i];
    return sum === 0 && wild === 0;
  }

  // 找到最左边的非零牌 —— 该牌必须属于某个面子
  let i = -1;
  for (let j = 0; j < TILE_COUNT; j++) {
    if (tiles[j] > 0) {
      i = j;
      break;
    }
  }

  // 没有实牌了，全靠百搭凑面子(每组面子需要3张百搭)
  if (i === -1) {
    return wild === meldsNeeded * 3;
  }

  // ---- 选项A: 牌[i]参与刻子 (3张相同牌) ----
  // 用 use 张实牌 + (3-use) 张百搭组成刻子
  const maxUse = Math.min(tiles[i], 3);
  for (let use = maxUse; use >= 1; use--) {
    const need = 3 - use; // 需要的百搭数
    if (need <= wild) {
      tiles[i] -= use;
      if (canFormMelds(tiles, wild - need, meldsNeeded - 1)) {
        tiles[i] += use;
        return true;
      }
      tiles[i] += use;
    }
  }

  // ---- 以下选项仅适用于数牌(万/条/筒)，字牌不能组顺子 ----
  const rank = i % 9; // 牌在花色内的位置 (0-8 对应 1-9)

  if (isSuitedTile(i)) {
    // ---- 选项B: 顺子从位置 i 开始: (i, i+1, i+2) ----
    // 需要 rank <= 6 (即牌面 ≤ 7)，确保 i+2 不越界且同花色
    if (rank <= 6) {
      // 统计3个位置各需多少百搭
      let wildNeeded = 0;
      const realUsed = [0, 0, 0]; // 记录每个位置消耗的实牌数

      for (let k = 0; k < 3; k++) {
        if (tiles[i + k] > 0) {
          realUsed[k] = 1; // 用1张实牌
        } else {
          wildNeeded++;    // 用1张百搭替代
        }
      }

      if (wildNeeded <= wild) {
        // 执行修改
        for (let k = 0; k < 3; k++) tiles[i + k] -= realUsed[k];
        if (canFormMelds(tiles, wild - wildNeeded, meldsNeeded - 1)) {
          for (let k = 0; k < 3; k++) tiles[i + k] += realUsed[k];
          return true;
        }
        // 还原修改
        for (let k = 0; k < 3; k++) tiles[i + k] += realUsed[k];
      }
    }

    // ---- 选项C: 顺子从位置 i-1 开始: (i-1, i, i+1) ----
    // 因为 i 是最左非零位，tiles[i-1] 必然为0，需要1张百搭替代
    // 需要 rank >= 1 且 rank <= 7，确保 i-1 和 i+1 都在同花色内
    if (rank >= 1 && rank <= 7 && wild >= 1) {
      let wildNeeded = 1; // i-1 位置必须用百搭
      const useI1 = tiles[i + 1] > 0 ? 1 : 0;
      if (!useI1) wildNeeded++; // i+1 位置也需要百搭

      if (wildNeeded <= wild) {
        tiles[i] -= 1;
        tiles[i + 1] -= useI1;
        if (canFormMelds(tiles, wild - wildNeeded, meldsNeeded - 1)) {
          tiles[i] += 1;
          tiles[i + 1] += useI1;
          return true;
        }
        tiles[i] += 1;
        tiles[i + 1] += useI1;
      }
    }

    // ---- 选项D: 顺子从位置 i-2 开始: (i-2, i-1, i) ----
    // tiles[i-2] 和 tiles[i-1] 都为0(在 i 左边)，各需1张百搭
    // 需要 rank >= 2，确保 i-2 在同花色内
    if (rank >= 2 && wild >= 2) {
      tiles[i] -= 1;
      if (canFormMelds(tiles, wild - 2, meldsNeeded - 1)) {
        tiles[i] += 1;
        return true;
      }
      tiles[i] += 1;
    }
  }

  return false;
}

/**
 * 检查七对子胡牌
 *
 * 七对子要求手牌恰好由7个对子组成(14张牌)。
 * 百搭牌可以和单张牌配对，也可以两张百搭自行配对。
 *
 * @param {Uint8Array} tiles - 牌数组
 * @param {number} wildCount - 百搭数量
 * @returns {boolean}
 */
function checkSevenPairs(tiles, wildCount) {
  let totalReal = 0;
  let pairs = 0;
  let singles = 0;

  for (let i = 0; i < TILE_COUNT; i++) {
    totalReal += tiles[i];
    pairs += Math.floor(tiles[i] / 2);     // 实牌中已成对的
    singles += tiles[i] % 2;                // 实牌中落单的
  }

  // 总牌数必须为14
  if (totalReal + wildCount !== 14) return false;

  // 每个单张需要1张百搭来配对
  const wildsUsedForSingles = singles;
  if (wildsUsedForSingles > wildCount) return false;

  // 剩余百搭自行配对(每2张百搭组成1对)
  const wildsLeft = wildCount - wildsUsedForSingles;
  const totalPairs = pairs + singles + Math.floor(wildsLeft / 2);

  // 需要恰好7对，且剩余百搭必须是偶数(不能有落单的百搭)
  return totalPairs >= 7 && (wildsLeft % 2 === 0);
}

// ============================================================
// 听牌分析
// ============================================================

/**
 * 计算听牌(听哪些牌可以胡)
 *
 * 支持任意合法待摸状态手牌数量(1, 4, 7, 10, 13),即 3k+1。
 * 逐一尝试加入每种普通牌,检查是否能组成胡牌(3k+2 状态)。
 *
 * 红中(WILD_TILE)是百搭牌,不作为"可胡的目标牌"参与展示。
 * 不返回牌山剩余数量(牌桌真实剩余无法知晓)。
 *
 * @param {Uint8Array} tiles - 手牌数组(不含百搭),牌总数应为 3k+1
 * @param {number} wildCount - 百搭数量
 * @returns {number[]} 能胡的牌索引数组
 */
export function getTenpaiTiles(tiles, wildCount) {
  const total = getTotalTiles(tiles, wildCount);
  if (total < 1 || (total - 1) % 3 !== 0) return [];

  const results = [];

  for (let i = 0; i < TILE_COUNT; i++) {
    if (i === WILD_TILE) continue;   // 红中不作为可胡目标
    if (tiles[i] >= 4) continue;     // 该种牌已经全部在手,不可能再摸到

    tiles[i] += 1;
    if (isWinningHand(tiles, wildCount)) {
      results.push(i);
    }
    tiles[i] -= 1;
  }

  return results;
}

// ============================================================
// 向听数分析 (Shanten Analysis)
// ============================================================
//
// 向听数 (shanten): 距离听牌还差几张有效牌。
//   shanten=0 —— 已听牌
//   shanten=1 —— 一向听, 再摸一张有效牌 + 打一张后可进入听牌
//   shanten=2 —— 二向听, 需要两次有效摸-打调整
//
// 本模块采用"迭代加深"实现,上限 maxDepth=2:
//   - 递归结构简单,与百搭规则同一套 isWinningHand 兼容
//   - shanten > 2 时代价指数级上升,超过范围直接返回 maxDepth+1
//
// 性能: 二向听递归的最底层调用 isTenpaiFast 数百万次, 且同一 3k+1 手
// 状态会被多条路径重复访问。使用简易记忆化(下方 _tenpaiCache) 后
// 一次 14 张手牌的二向听分析从 15s 级降至 1s 级。缓存应在每次
// analyzeHand 顶层调用前用 resetShantenCache() 清空。

/** isTenpaiFast 结果缓存, key = tiles.join(',') + '|' + wildCount */
let _tenpaiCache = new Map();

/** 清空向听数分析的记忆化缓存。analyzeHand 会在入口处调用一次。 */
export function resetShantenCache() {
  _tenpaiCache = new Map();
}

/**
 * 3k+1 手牌是否听牌 —— 加了短路 + 记忆化的快速版本(不列出全部听牌)
 * 与 getTenpaiTiles(...).length > 0 等价,但找到第一张就返回
 */
function isTenpaiFast(tiles, wildCount) {
  const key = tiles.join(',') + '|' + wildCount;
  const cached = _tenpaiCache.get(key);
  if (cached !== undefined) return cached;

  let result = false;
  for (let t = 0; t < TILE_COUNT; t++) {
    if (t === WILD_TILE) continue;
    if (tiles[t] >= 4) continue;
    tiles[t]++;
    if (isWinningHand(tiles, wildCount)) {
      tiles[t]--;
      result = true;
      break;
    }
    tiles[t]--;
  }

  _tenpaiCache.set(key, result);
  return result;
}

/**
 * 3k+2 手牌是否存在"打出某张后可听牌"的选择
 */
function canDiscardToTenpai(tiles, wildCount) {
  for (let d = 0; d < TILE_COUNT; d++) {
    if (d === WILD_TILE) continue;
    if (tiles[d] === 0) continue;
    tiles[d]--;
    const ok = isTenpaiFast(tiles, wildCount);
    tiles[d]++;
    if (ok) return true;
  }
  if (wildCount > 0 && isTenpaiFast(tiles, wildCount - 1)) return true;
  return false;
}

/**
 * 3k+1 手牌是否可在"摸1张 + 打1张"一次调整内进入听牌
 * 即向听数 ≤ 1
 */
function canReachTenpaiInOneCycle(tiles, wildCount) {
  if (isTenpaiFast(tiles, wildCount)) return true;
  for (let t = 0; t < TILE_COUNT; t++) {
    if (t === WILD_TILE) continue;
    if (tiles[t] >= 4) continue;
    tiles[t]++;
    const ok = canDiscardToTenpai(tiles, wildCount);
    tiles[t]--;
    if (ok) return true;
  }
  if (wildCount < 4 && canDiscardToTenpai(tiles, wildCount + 1)) return true;
  return false;
}

/**
 * 3k+2 手牌是否存在"打出某张后向听数 ≤ 1"的选择
 */
function canDiscardToShanten1(tiles, wildCount) {
  for (let d = 0; d < TILE_COUNT; d++) {
    if (d === WILD_TILE) continue;
    if (tiles[d] === 0) continue;
    tiles[d]--;
    const ok = canReachTenpaiInOneCycle(tiles, wildCount);
    tiles[d]++;
    if (ok) return true;
  }
  if (wildCount > 0 && canReachTenpaiInOneCycle(tiles, wildCount - 1)) return true;
  return false;
}

/**
 * 计算 3k+1 手牌的向听数
 *
 * 迭代加深: 先检查是否听牌(0), 再检查一向听(1), 再检查二向听(2)。
 * 若超过 maxDepth 未确定,返回 maxDepth+1 表示"较远"。
 *
 * @param {Uint8Array} tiles - 3k+1 手牌
 * @param {number} wildCount - 百搭数量
 * @param {number} maxDepth - 检查的最大向听数(默认2)
 * @returns {number} 向听数, 或 maxDepth+1 表示超过范围
 */
export function getShanten(tiles, wildCount, maxDepth = 2) {
  if (isTenpaiFast(tiles, wildCount)) return 0;
  if (maxDepth < 1) return 1;

  // shanten 1: 摸1张 t 后,存在打出令手牌听牌
  for (let t = 0; t < TILE_COUNT; t++) {
    if (t === WILD_TILE) continue;
    if (tiles[t] >= 4) continue;
    tiles[t]++;
    const ok = canDiscardToTenpai(tiles, wildCount);
    tiles[t]--;
    if (ok) return 1;
  }
  if (wildCount < 4 && canDiscardToTenpai(tiles, wildCount + 1)) return 1;

  if (maxDepth < 2) return 2;

  // shanten 2: 摸1张 t 后,存在打出令向听数 ≤ 1
  for (let t = 0; t < TILE_COUNT; t++) {
    if (t === WILD_TILE) continue;
    if (tiles[t] >= 4) continue;
    tiles[t]++;
    const ok = canDiscardToShanten1(tiles, wildCount);
    tiles[t]--;
    if (ok) return 2;
  }
  if (wildCount < 4 && canDiscardToShanten1(tiles, wildCount + 1)) return 2;

  return 3;
}

/**
 * 计算 3k+1 手牌在已知向听数下的有效进张
 *
 * 有效进张 (ukeire) = 摸到后能让向听数下降 1 的牌种。
 *   shanten=0 时,即"可胡的牌" = getTenpaiTiles
 *   shanten=1 时,摸到后手牌变 3k+2,存在打出令其听牌
 *   shanten=2 时,摸到后手牌变 3k+2,存在打出令其向听数 ≤ 1
 *
 * 红中(百搭)始终不作为进张目标返回。
 *
 * @param {Uint8Array} tiles - 3k+1 手牌
 * @param {number} wildCount - 百搭数量
 * @param {number} shanten - 已知向听数(0/1/2)
 * @returns {number[]} 有效进张的牌索引数组
 */
export function getUkeire(tiles, wildCount, shanten) {
  if (shanten === 0) return getTenpaiTiles(tiles, wildCount);
  if (shanten !== 1 && shanten !== 2) return [];

  const ukeire = [];
  for (let t = 0; t < TILE_COUNT; t++) {
    if (t === WILD_TILE) continue;
    if (tiles[t] >= 4) continue;
    tiles[t]++;
    const useful = shanten === 1
      ? canDiscardToTenpai(tiles, wildCount)
      : canDiscardToShanten1(tiles, wildCount);
    tiles[t]--;
    if (useful) ukeire.push(t);
  }
  return ukeire;
}
