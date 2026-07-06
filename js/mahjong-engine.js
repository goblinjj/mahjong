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
 * 检查两种胡牌形式:
 *   1. 标准胡: 4组面子(顺子/刻子) + 1个雀头(对子)
 *   2. 七对子: 7组对子
 *
 * @param {Uint8Array} tiles - 牌数组(不含百搭，tiles[WILD_TILE]必须为0)
 * @param {number} wildCount - 百搭牌数量
 * @returns {boolean} 是否胡牌
 */
export function isWinningHand(tiles, wildCount) {
  return checkStandardWin(tiles, wildCount) || checkSevenPairs(tiles, wildCount);
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
 * @returns {boolean}
 */
function checkStandardWin(tiles, wildCount) {
  // 枚举每种牌作为雀头
  for (let p = 0; p < TILE_COUNT; p++) {
    // 情况A: 雀头由2张实牌组成
    if (tiles[p] >= 2) {
      tiles[p] -= 2;
      if (canFormMelds(tiles, wildCount, 4)) {
        tiles[p] += 2;
        return true;
      }
      tiles[p] += 2;
    }

    // 情况B: 雀头由1张实牌 + 1张百搭组成
    if (tiles[p] >= 1 && wildCount >= 1) {
      tiles[p] -= 1;
      if (canFormMelds(tiles, wildCount - 1, 4)) {
        tiles[p] += 1;
        return true;
      }
      tiles[p] += 1;
    }
  }

  // 情况C: 雀头由2张百搭组成(不对应任何特定牌型)
  if (wildCount >= 2) {
    if (canFormMelds(tiles, wildCount - 2, 4)) {
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
 * 给定13张手牌(不含百搭) + wildCount张百搭，
 * 逐一尝试加入每种牌，检查是否能组成胡牌。
 *
 * @param {Uint8Array} tiles13 - 13张手牌数组(不含百搭)
 * @param {number} wildCount - 百搭数量
 * @returns {Array<{tileIndex: number, count: number}>} 听牌列表
 *   tileIndex: 能胡的牌索引
 *   count: 该牌在牌山中的剩余数量
 */
export function getTenpaiTiles(tiles13, wildCount) {
  const results = [];

  for (let i = 0; i < TILE_COUNT; i++) {
    if (i === WILD_TILE) {
      // 摸到百搭牌: 百搭数+1，检查14张牌能否胡
      if (canWinWith14(tiles13, wildCount + 1)) {
        const remaining = 4 - wildCount; // 牌山中剩余的百搭数
        if (remaining > 0) {
          results.push({ tileIndex: i, count: remaining });
        }
      }
    } else {
      // 摸到普通牌: 对应牌数+1，检查14张牌能否胡
      if (tiles13[i] < 4) { // 不可能摸到第5张
        tiles13[i] += 1;
        if (isWinningHand(tiles13, wildCount)) {
          const remaining = 4 - tiles13[i]; // 牌山中剩余数量(已包含刚加的那张)
          if (remaining > 0) {
            results.push({ tileIndex: i, count: remaining });
          }
        }
        tiles13[i] -= 1;
      }
    }
  }

  return results;
}

/**
 * 辅助函数: 检查摸到百搭后能否胡牌
 * 摸百搭不改变 tiles 数组，只增加 wildCount
 *
 * @param {Uint8Array} tiles - 牌数组
 * @param {number} newWildCount - 增加后的百搭数量
 * @returns {boolean}
 */
function canWinWith14(tiles, newWildCount) {
  return isWinningHand(tiles, newWildCount);
}
