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
console.log('\n=== 测试8: 检测融合 - 出现率分档与类别投票 ===');
// ============================================================

// 假阳:一个只在第 1 帧出现的框。出现率随窗口滑动衰减到 0.2 后被老化删除。
// 中间几帧它会处于「待定」区间并计入 pending —— 这是设计使然,不是 bug。
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 6; f++) {
    const frame = makeFrame(HAND13);
    // 假阳与真牌同高、同基线,确保它能通过离群剔除,真正考验出现率逻辑
    if (f === 0) frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.tiles.length === 13, `单帧假阳不进入输出, 实际=${snap.tiles.length}`);
  assert(snap.pending === 0, `假阳老化后 pending 归零, 实际=${snap.pending}`);
}

// 待定:某轨迹在 5 帧中只出现 2 帧(出现率 0.4),应计入 pending 且不进输出
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) {
    const frame = makeFrame(HAND13);
    if (f === 0 || f === 2) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.tiles.length === 13, `待定轨迹不进入输出, 实际=${snap.tiles.length}`);
  assert(snap.pending === 1, `待定轨迹计入 pending, 实际=${snap.pending}`);
}

// 类别投票:第 7 张前 4 帧判 5万(idx 4)、末帧判 6万(idx 5) → 应收敛到 5万。
// 占比 0.8,与阈值 0.6 拉开距离,避免断言卡在浮点边界上。
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 5; f++) {
    const hand = [...HAND13];
    hand[6] = f < 4 ? 4 : 5;
    snap = fuser.push(makeFrame(hand), f * 400);
  }
  assert(snap.tiles.length === 13, `类别跳变不影响张数, 实际=${snap.tiles.length}`);
  assert(snap.tiles[6].tileIndex === 4, `类别投票收敛到多数类 5万, 实际=${snap.tiles[6].tileIndex}`);
}

// 类别僵持:某轨迹两类各占一半(占比 0.6 < voteRatio 0.7) → 未收敛,计入 pending。
// 这正是用户报告的失败模式:5万/6万 反复跳,不该静默选一个。
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 6; f++) {
    const hand = [...HAND13];
    hand[6] = f % 2 === 0 ? 4 : 5;   // 交替,票重接近 1:1
    snap = fuser.push(makeFrame(hand), f * 400);
  }
  assert(snap.pending === 1, `类别未收敛的轨迹计入 pending, 实际=${snap.pending}`);
  assert(snap.tiles.length === 12, `类别未收敛的轨迹不进输出, 实际=${snap.tiles.length}`);
}

// ============================================================
console.log('\n=== 测试9: 检测融合 - 状态机 ===');
// ============================================================

// 帧数不足 → COLLECTING;攒够且判据满足 → STABLE
{
  const fuser = new DetectionFuser();
  const first = fuser.push(makeFrame(HAND13), 0);
  assert(first.state === 'collecting', `首帧为 collecting, 实际=${first.state}`);
  let snap = first;
  for (let f = 1; f < 6; f++) snap = fuser.push(makeFrame(HAND13), f * 400);
  assert(snap.state === 'stable', `稳定输入 6 帧后进入 stable, 实际=${snap.state}`);
  assert(snap.progress === 1, `stable 时 progress 为 1, 实际=${snap.progress}`);
}

// 存在待定轨迹 → 永远不进 stable,且 progress 封顶 0.99
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 6; f++) {
    const frame = makeFrame(HAND13);
    if (f % 2 === 0) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.pending === 1, `半数帧出现的框记为待定, 实际=${snap.pending}`);
  assert(snap.state !== 'stable', `有待定时不得进入 stable, 实际=${snap.state}`);
  assert(snap.progress <= 0.99, `有待定时 progress 封顶 0.99, 实际=${snap.progress}`);
}

// 张数持续变化 → 输出不连续一致,不得进入 stable
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 6; f++) {
    // 每帧真的换一副牌(整体换类别),投票无法收敛
    const hand = HAND13.map((t, i) => (i === 6 ? (f % 3) : t));
    snap = fuser.push(makeFrame(hand), f * 400);
  }
  assert(snap.state !== 'stable', `类别持续跳变不得进入 stable, 实际=${snap.state}`);
}

// 场景切换:换一副牌(位置不变、类别全变)。旧票应随窗口自然过期,
// 收敛到新牌;过渡期间不得报 stable(否则会绿灯给出旧手牌)。
{
  const OTHER13 = [4, 5, 6, 13, 14, 15, 22, 23, 24, 28, 28, 33, 32];
  const fuser = new DetectionFuser();
  for (let f = 0; f < 5; f++) fuser.push(makeFrame(HAND13), f * 400);

  // 换牌后第 1 帧:旧票仍占多数,但本帧存在类别冲突 → 不得 stable
  const mid = fuser.push(makeFrame(OTHER13), 2000);
  assert(mid.state !== 'stable', `换牌过渡期不得报 stable, 实际=${mid.state}`);

  // 过渡期旧新票各占一半时 ratio 达不到 0.7,轨迹全部落入 pending;
  // 需喂到旧票完全出窗(第 11 帧)才会重新稳定
  let snap = mid;
  for (let f = 6; f < 11; f++) snap = fuser.push(makeFrame(OTHER13), f * 400);
  const got = snap.tiles.map((t) => t.tileIndex).join(',');
  assert(got === OTHER13.join(','), `旧票过期后收敛到新牌, 实际=${got}`);
  assert(snap.state === 'stable', `收敛后回到 stable, 实际=${snap.state}`);
}

// 持续不稳定超过 8 秒 → 降级为 degraded,输出仍只含确认存在的轨迹。
// 幻影框隔帧出现,命中率随总帧数的奇偶在窗口内摆动(如 2/5=0.4 与
// 3/5=0.6),必须在两种奇偶下都断言,不能让通过与否取决于循环恰好停在
// 哪一奇偶——那正是 presentRate 曾经卡在 0.6 时被放过的失败模式。
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 31; f++) {
    const frame = makeFrame(HAND13);
    if (f % 2 === 0) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    snap = fuser.push(frame, f * 400);   // 30 帧 × 400ms = 11.6s > 8s
    if (f === 29) {
      assert(snap.state === 'degraded', `持续不稳定 8s 后降级(偶数帧数), 实际=${snap.state}`);
      assert(snap.tiles.length === 13, `降级时输出不含待定轨迹(偶数帧数), 实际=${snap.tiles.length}`);
    }
  }
  assert(snap.state === 'degraded', `持续不稳定 8s 后降级(奇数帧数), 实际=${snap.state}`);
  assert(snap.tiles.length === 13, `降级时输出不含待定轨迹(奇数帧数), 实际=${snap.tiles.length}`);
}

// degraded 不是终态:判据重新满足应升回 stable
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 30; f++) {
    const frame = makeFrame(HAND13);
    if (f % 2 === 0) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    snap = fuser.push(frame, f * 400);
  }
  assert(snap.state === 'degraded', `前置条件:已降级, 实际=${snap.state}`);
  for (let f = 30; f < 40; f++) snap = fuser.push(makeFrame(HAND13), f * 400);
  assert(snap.state === 'stable', `干扰消失后从 degraded 升回 stable, 实际=${snap.state}`);
}

// reset 清空超时计时器
{
  const fuser = new DetectionFuser();
  for (let f = 0; f < 30; f++) {
    const frame = makeFrame(HAND13);
    if (f % 2 === 0) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    fuser.push(frame, f * 400);
  }
  fuser.reset();
  const snap = fuser.push(makeFrame(HAND13), 99999);
  assert(snap.state === 'collecting', `reset 后重新计时,不应仍是 degraded, 实际=${snap.state}`);
}

// ============================================================
console.log('\n=== 测试结果 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 所有测试通过!\n');
}
