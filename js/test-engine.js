/**
 * 麻将引擎单元测试
 * 运行: node js/test-engine.js
 */

// 由于我们使用 ES 模块，需要在 package.json 加 "type": "module"
// 或使用 .mjs 扩展名。这里直接内联核心逻辑进行测试。

import { createHand, isWinningHand, getTenpaiTiles, TILE_NAMES, WILD_TILE } from './mahjong-engine.js';
import { analyzeHand } from './analyzer.js';

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
  const tileNames = tenpai.map(t => TILE_NAMES[t.tileIndex]);
  console.log(`  听牌: ${tileNames.join(', ')} (共${tenpai.reduce((s,t)=>s+t.count,0)}张)`);
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
  if (result.type === 'discard' && result.discards.length > 0) {
    const best = result.discards[0];
    console.log(`  最优: 打「${best.tileName}」→ 听 ${best.totalCount} 张`);
    best.tenpaiTiles.forEach(t => {
      console.log(`    可胡: ${TILE_NAMES[t.tileIndex]} ×${t.count}`);
    });
    assert(best.totalCount > 0, `最优出牌有听牌: ${best.tileName} → ${best.totalCount}张`);
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
    console.log(`  共 ${result.discards.length} 种出牌方案`);
    result.discards.slice(0, 3).forEach(d => {
      console.log(`  打「${d.tileName}」→ 听 ${d.totalCount} 张`);
    });
  }
}

// ============================================================
console.log('\n=== 测试结果 ===');
console.log(`通过: ${passed}, 失败: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ 所有测试通过!\n');
}
