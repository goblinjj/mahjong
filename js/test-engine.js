/**
 * 麻将引擎单元测试
 * 运行: node js/test-engine.js
 */

// 由于我们使用 ES 模块，需要在 package.json 加 "type": "module"
// 或使用 .mjs 扩展名。这里直接内联核心逻辑进行测试。

import { createHand, isWinningHand, getTenpaiTiles, getShanten, TILE_NAMES, WILD_TILE } from './mahjong-engine.js';
import { analyzeHand } from './analyzer.js';
import { DetectionFuser } from './detection-fuser.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

// ============================================================
console.log('\n=== 测试1: 基本胡牌判定 ===');
// ============================================================

// 标准胡牌: 111万 222万 333万 44万 55万 → 不对，这是4面子+1雀头
// 111万 222万 333万 456万 77万 → 4面子(111,222,333,456) + 雀头(77)
{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[5] = 1; // 六万×1
  hand[6] = 2; // 七万×2 (雀头)
  assert(isWinningHand(hand, 0) === true, '标准胡牌 111万222万333万456万77万');
}

// 非胡牌
{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[5] = 1; // 六万×1
  hand[27] = 1; // 东×1
  hand[28] = 1; // 南×1
  assert(isWinningHand(hand, 0) === false, '非胡牌 111万222万333万456万东南 (无雀头对子)');
}

// 七对子
{
  const hand = createHand();
  hand[0] = 2; // 一万×2
  hand[1] = 2; // 二万×2
  hand[9] = 2; // 一条×2
  hand[10] = 2; // 二条×2
  hand[18] = 2; // 一筒×2
  hand[27] = 2; // 东×2
  hand[33] = 2; // 白×2
  assert(isWinningHand(hand, 0) === true, '七对子 11万22万11条22条11筒东东白白');
}

// ============================================================
console.log('\n=== 测试2: 红中百搭 ===');
// ============================================================

// 1张百搭补成胡牌
{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[6] = 2; // 七万×2 (雀头)
  // 缺六万，用1张百搭
  assert(isWinningHand(hand, 1) === true, '百搭补六万: 111万222万333万45万77万+1百搭');
}

// 2张百搭
{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[6] = 1; // 七万×1
  // 需要2张百搭: 1张与七万凑对子, 1张与四五万凑顺子，共14张
  assert(isWinningHand(hand, 2) === true, '2张百搭: 111万222万333万45万7万+2百搭 (14张)');
}

// 百搭补七对子
{
  const hand = createHand();
  hand[0] = 2; // 一万×2
  hand[1] = 2; // 二万×2
  hand[9] = 2; // 一条×2
  hand[10] = 2; // 二条×2
  hand[18] = 2; // 一筒×2
  hand[27] = 1; // 东×1 (缺1张)
  hand[33] = 1; // 白×1 (缺1张)
  // 用2张百搭各补1张
  assert(isWinningHand(hand, 2) === true, '百搭补七对子: 11万22万11条22条11筒东白+2百搭');
}

// ============================================================
console.log('\n=== 测试3: 听牌分析 ===');
// ============================================================

// 13张: 111万 222万 333万 456万 7万 → 听 7万(凑对子)
{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[5] = 1; // 六万×1
  hand[6] = 1; // 七万×1
  const tenpai = getTenpaiTiles(hand, 0);
  const tileNames = tenpai.map(idx => TILE_NAMES[idx]);
  console.log(`  听牌: ${tileNames.join(', ')} (共${tenpai.length}种)`);
  assert(tenpai.length > 0, `13张牌听牌分析有结果: ${tileNames.join(', ')}`);
}

// ============================================================
console.log('\n=== 测试4: 出牌分析 (14张) ===');
// ============================================================

{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[5] = 1; // 六万×1
  hand[6] = 1; // 七万×1
  hand[8] = 1; // 九万×1
  // 14张: 111万222万333万4567九万 (打九万听四七万/八万)
  const result = analyzeHand(hand, 0);
  assert(result.type === 'discard', '14张牌出牌分析返回discard类型');
  assert(result.shanten === 0, `听牌路径 shanten=0, 实际=${result.shanten}`);
  if (result.type === 'discard' && result.discards.length > 0) {
    const best = result.discards[0];
    console.log(`  最优: 打「${best.tileName}」→ 听 ${best.ukeire.length} 种`);
    best.ukeire.forEach(idx => {
      console.log(`    可胡: ${TILE_NAMES[idx]}`);
    });
    assert(best.ukeire.length > 0, `最优出牌有听牌: ${best.tileName} → ${best.ukeire.length}种`);
  }
}

// ============================================================
console.log('\n=== 测试5: 出牌分析 (含百搭) ===');
// ============================================================

{
  const hand = createHand();
  hand[0] = 3; // 一万×3
  hand[1] = 3; // 二万×3
  hand[2] = 3; // 三万×3
  hand[3] = 1; // 四万×1
  hand[4] = 1; // 五万×1
  hand[27] = 1; // 东×1
  hand[28] = 1; // 南×1
  // 13张真牌 + 1张百搭 = 14张 (不能直接胡)
  const result = analyzeHand(hand, 1);
  assert(result.type === 'discard',
    `含百搭14张牌分析: type=${result.type}`);
  if (result.type === 'discard' && result.discards.length > 0) {
    console.log(`  共 ${result.discards.length} 种出牌方案 (shanten=${result.shanten})`);
    result.discards.slice(0, 3).forEach(d => {
      console.log(`  打「${d.tileName}」→ ${result.shanten === 0 ? '听' : '进张'} ${d.ukeire.length} 种`);
    });
  }
}

// ============================================================
console.log('\n=== 测试6: 向听数分析 ===');
// ============================================================

// 13张一向听: 3副面子 + 1对子 + 2散张
// 例: 111万 222万 333万 55条 6条 7筒 (13张)
// 6条 和 7筒 都是散张; 把 7筒 换成 7条 就是 111万222万333万55条67条,
// 摸 5条 或 8条 可胡, 即为听牌 —— 只需 1 次交换就能到达听牌, 故一向听。
{
  const hand = createHand();
  hand[0] = 3; hand[1] = 3; hand[2] = 3;    // 111万 222万 333万
  hand[13] = 2;                              // 55条
  hand[14] = 1;                              // 6条 (散张)
  hand[24] = 1;                              // 7筒 (散张)
  // 总计: 3+3+3+2+1+1 = 13 张
  const s = getShanten(hand, 0, 2);
  console.log(`  向听数: ${s}`);
  assert(s === 1, `一向听手牌 shanten=1, 实际=${s}`);
}

// 14张手牌无法一步进入听牌, 但可推荐一向听打法
{
  const hand = createHand();
  hand[0] = 1; hand[2] = 1; hand[4] = 1;   // 1万3万5万 (散牌)
  hand[9] = 1; hand[10] = 1; hand[11] = 1;  // 456条
  hand[18] = 1; hand[19] = 1; hand[20] = 1; // 456筒
  hand[27] = 2;                              // 东东 (对子)
  hand[28] = 1; hand[29] = 1; hand[30] = 1;  // 南西北 (风牌散)
  const result = analyzeHand(hand, 0);
  console.log(`  分析类型: ${result.type}, shanten=${result.shanten ?? 'N/A'}`);
  assert(result.type === 'discard' || result.type === 'far_from_tenpai',
    `未听牌手牌返回 discard 或 far_from_tenpai: ${result.type}`);
  if (result.type === 'discard') {
    assert(result.shanten >= 1, `未听牌手牌 shanten ≥ 1, 实际=${result.shanten}`);
    console.log(`  最优打法: 打「${result.discards[0].tileName}」→ 进张 ${result.discards[0].ukeire.length} 种`);
  }
}

// ============================================================
console.log('\n=== 测试7: 检测融合 - 轨迹关联 ===');
// ============================================================

/**
 * 构造一帧合成检测：一行等间距、等大小的牌。
 * 中心间距 42 > 牌宽 40，确保相邻牌不会被互相匹配。
 * @param {number[]} tileIndexes
 * @param {{x0?:number, y0?:number, w?:number, h?:number, gap?:number, conf?:number}} [opts]
 */
function makeFrame(tileIndexes, opts = {}) {
  const { x0 = 100, y0 = 200, w = 40, h = 56, gap = 42, conf = 0.8 } = opts;
  return tileIndexes.map((tileIndex, i) => ({
    tileIndex,
    confidence: conf,
    bbox: { x: x0 + i * gap, y: y0, w, h },
  }));
}

/** 一副 13 张的测试手牌 */
const HAND13 = [0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 27, 32, 33];

// 连续 5 帧完全相同 → 应恰好产生 13 条轨迹，不多不少
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) snap = fuser.push(makeFrame(HAND13), f * 400);
  assert(snap.tiles.length === 13, `5 帧相同输入产生 13 条轨迹, 实际=${snap.tiles.length}`);
  assert(snap.frames === 5, `帧计数为 5, 实际=${snap.frames}`);
}

// 第 3 帧漏掉第 7 张 → 轨迹不应消失(出现率分档在任务 2,这里只验证关联)
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) {
    const frame = makeFrame(HAND13);
    if (f === 2) frame.splice(6, 1);   // 抽掉第 7 张,其余位置不变
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.tiles.length === 13, `单帧漏检不丢轨迹, 实际=${snap.tiles.length}`);
}

// 整行每帧右移 8px(手抖) → 位移补偿后不应产生新轨迹
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) {
    snap = fuser.push(makeFrame(HAND13, { x0: 100 + f * 8 }), f * 400);
  }
  assert(snap.tiles.length === 13, `整行平移不产生新轨迹, 实际=${snap.tiles.length}`);
}

// 离群框剔除:混入一个高度只有一半、且不在基线上的框
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) {
    const frame = makeFrame(HAND13);
    frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 700, y: 120, w: 40, h: 20 } });
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.tiles.length === 13, `离群框被剔除, 实际=${snap.tiles.length}`);
}

// ============================================================
console.log('\n=== 测试结果 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 所有测试通过!\n');
}
