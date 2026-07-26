# 多帧检测融合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把摄像头识别的「牌」从单帧的一个检测框升级为跨帧轨迹，用出现率与类别投票聚合多帧证据，消除 13 张牌在 12/13 之间跳动、以及牌种类在相邻两张之间跳变的问题。

**Architecture:** 新增纯逻辑模块 `js/detection-fuser.js`（不依赖 DOM，可被 node 直接引入测试），维护跨帧轨迹：先用位移中位数补偿手抖导致的整行平移，再两遍贪心匹配把本帧检测关联到已有轨迹；每条轨迹按滑动窗口内的出现率分为「确认存在 / 待定 / 噪声」三档，类别按置信度加权投票。`app.js` 的 `detectionTick` 把原始检测喂给 fuser，用返回的融合结果替换 `liveDetections`——下游的 `drawOverlay`、确认流程、预览页数据结构完全不变。

**Tech Stack:** 原生 ES 模块（无构建、无 npm 运行时依赖）、`js/test-engine.js` 作为唯一测试入口（`node js/test-engine.js`）。

**设计文档:** `docs/superpowers/specs/2026-07-26-detection-fusion-design.md`

## Global Constraints

- **部署产物即仓库根目录**，Cloudflare Pages 不跑 `npm run build`。所有 `js/*.js` 必须是浏览器可直接执行的原生 ES 模块，import 只能用相对路径且带扩展名（`./xxx.js`）。**禁止引入裸模块名或任何 npm 依赖。**
- **`js/detection-fuser.js` 不得引用任何 DOM / 浏览器 API**（`document`、`window`、`performance`、`Image`、`canvas` 等）。时间由调用方以 `now` 参数传入。这是它能在 node 里被测试的前提。
- **零境外资源**：本次改动不得引入任何外部资源。
- **唯一测试入口**是 `js/test-engine.js`，用其中已有的 `assert(condition, message)` 计数，没有 test runner、没有单测过滤参数。新增测试以自包含的 `{ ... }` 块追加。
- **牌索引约定**：34 类，`0-8 万`、`9-17 条`、`18-26 筒`、`27-30 东南西北`、`31 中(百搭)`、`32 发`、`33 白`。fuser 只透传 `tileIndex`，不做任何百搭特殊处理——`wildCount` 的拆分由 `btnDetectApply` 负责，本次不动。
- **真机验证用 `npm run preview:pages`**（:8788），不要用 `npm run dev`。
- 所有参数集中在 `DEFAULT_CONFIG`，不得把魔数散落在函数体内。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `js/detection-fuser.js` | 创建 | 跨帧轨迹关联、出现率分档、类别投票、状态机。纯逻辑 |
| `js/test-engine.js` | 修改（追加） | 新增 fuser 测试块与合成检测帧的辅助函数 |
| `js/recognition.js` | 修改（1 行） | `confThreshold` 0.5 → 0.3 |
| `js/app.js` | 修改 | `detectionTick` 接线到 fuser；`updateLiveBadge` 改为按状态渲染；`stopDetectionLoop` 调 `reset()` |
| `css/style.css` | 修改 | 取相框虚线颜色随状态变；新增 `.action-btn.warn` 降级按钮样式 |

任务 1~3 建设 fuser 本体（每个任务都有 node 可跑的断言），任务 4 接线，任务 5 做 UI。

---

## Task 1: 轨迹关联——位移补偿与两遍匹配

**Files:**
- Create: `js/detection-fuser.js`
- Test: `js/test-engine.js`（在末尾「测试结果」汇总块**之前**追加）

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `export const FuserState = { COLLECTING: 'collecting', UNSTABLE: 'unstable', STABLE: 'stable', DEGRADED: 'degraded' }`
  - `export const DEFAULT_CONFIG` — 见下方代码，任务 2、3 会读取其中更多字段
  - `export class DetectionFuser`，方法 `push(detections, now)` / `reset()` / `snapshot()`
  - 本任务阶段 `push()` 返回 `{ tiles, frames }`，`tiles` 为**所有**活跃轨迹（尚未分档），元素形如 `{ tileIndex, confidence, bbox: {x, y, w, h} }`，按 `bbox.x` 升序
  - 输入 `detections` 的元素结构与 `recognition.js` 的 `postprocess` 输出一致：`{ tileIndex, confidence, className?, bbox: {x, y, w, h} }`

- [ ] **Step 1: 在 `js/test-engine.js` 写失败的测试**

在文件末尾的 `console.log('\n=== 测试结果 ===')` 汇总块**之前**插入。先在文件顶部 import 区（第 10 行 `import { analyzeHand }` 之后）加一行：

```js
import { DetectionFuser } from './detection-fuser.js';
```

然后插入测试块：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL —— `Cannot find module '.../js/detection-fuser.js'`（模块尚不存在）

- [ ] **Step 3: 创建 `js/detection-fuser.js`**

```js
/**
 * detection-fuser.js - 多帧检测融合
 *
 * 把「牌」从单帧的一个检测框升级为跨帧轨迹,用出现率与类别投票聚合证据,
 * 消除单帧 YOLO 在置信度阈值附近的张数/类别抖动。
 *
 * 纯逻辑,不依赖 DOM,可被 node 直接引入做单元测试 —— 融合逻辑无法靠
 * 对着摄像头肉眼调准,必须能喂合成序列跑断言。
 *
 * 设计: docs/superpowers/specs/2026-07-26-detection-fusion-design.md
 */

/** 融合状态机的四个状态 */
export const FuserState = {
  COLLECTING: 'collecting',  // 帧数不足,还在攒证据
  UNSTABLE: 'unstable',      // 帧数够了但判据未达成
  STABLE: 'stable',          // 可以确认
  DEGRADED: 'degraded',      // 长时间不稳定,解锁强制确认
};

/**
 * 全部可调参数。真机调参只改这里,不要把魔数散进函数体。
 * 按实测 2~3 fps 标定:windowSize 5 帧约 2 秒。
 */
export const DEFAULT_CONFIG = {
  windowSize: 5,          // 滑动窗口帧数
  presentRate: 0.7,       // 出现率 ≥ 此值视为「确认存在」(与 windowSize 耦合)
  pendingRate: 0.3,       // 出现率 < 此值视为噪声,老化删除(与 windowSize 耦合)
  // 类别投票胜出占比下限。取值必须避开「可达边界」:票在 windowSize=5 的
  // 窗口内聚合,两个类别只可能分成 5:0 / 4:1 / 3:2,比例只能是 1.0 / 0.8 / 0.6。
  // 取 0.6 时 `ratio >= voteRatio` 恒成立,闸门形同虚设 —— 而它要拦的正是
  // 「5万/6万 每帧交替」这种僵持。0.7 落在 0.6 与 0.8 之间,两侧都有余量,
  // 语义是「5 帧里至少 4 帧一致才算收敛」。
  // 注意:此值与 windowSize 耦合,改任何一个都要重算可达比例集合。
  voteRatio: 0.7,
  stableFrames: 3,        // 输出连续一致所需帧数
  matchRadiusCoarse: 1.0, // 粗匹配阈值(牌宽倍数),用于估计全局位移
  matchRadiusFine: 0.4,   // 补偿后精匹配阈值(牌宽倍数)
  resetShiftRatio: 1.5,   // 触发 reset 的位移(牌宽倍数)
  degradeAfterMs: 8000,   // 持续不稳定多久后降级
  emaAlpha: 0.5,          // 轨迹位置/尺寸的 EMA 平滑系数
  minFramesForState: 3,   // 少于此帧数一律 COLLECTING
  outlierMinBoxes: 4,     // 少于此框数不做离群剔除(中位数不可靠)
  outlierHeightLo: 0.6,   // 高度低于中位数此倍数 → 剔除
  outlierHeightHi: 1.6,   // 高度高于中位数此倍数 → 剔除
  outlierBaseline: 0.5,   // 底边偏离基线中位数超过此倍数牌高 → 剔除
};

/** 中位数;会就地排序传入数组的副本 */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** bbox 中心点 */
function centerOf(bbox) {
  return { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
}

/**
 * 剔除离群框:牌是一行等高、共基线的,尺寸或基线明显不合群的多半是误检。
 * 框数太少时跳过 —— 中位数在小样本上不可靠,宁可不剔。
 */
function rejectOutliers(detections, config) {
  if (detections.length < config.outlierMinBoxes) return detections;
  const hMed = median(detections.map((d) => d.bbox.h));
  const yMed = median(detections.map((d) => d.bbox.y + d.bbox.h));
  if (hMed <= 0) return detections;
  return detections.filter((d) => {
    const h = d.bbox.h;
    if (h < config.outlierHeightLo * hMed || h > config.outlierHeightHi * hMed) return false;
    return Math.abs(d.bbox.y + d.bbox.h - yMed) <= config.outlierBaseline * hMed;
  });
}

export class DetectionFuser {
  /** @param {Partial<typeof DEFAULT_CONFIG>} [config] */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.reset();
  }

  /** 清空全部累积证据。换牌、切模式、大幅移动后必须调用。 */
  reset() {
    /** @type {Array<object>} 活跃轨迹 */
    this.tracks = [];
    /** 已处理帧数,同时用作帧序号 */
    this.frameSeq = 0;
    this._nextId = 1;
  }

  /**
   * 喂入一帧原始检测。
   * @param {Array<{tileIndex:number, confidence:number, bbox:{x:number,y:number,w:number,h:number}}>} detections
   * @param {number} [now] 调用方提供的时间戳(ms)。fuser 不自己取时钟,以便测试喂假时间。
   * @returns {{state:string, tiles:Array, pending:number, frames:number, progress:number}}
   */
  push(detections, now = 0) {
    const dets = rejectOutliers(detections || [], this.config);
    const tileW = this._tileWidth(dets);

    // 位移估计要用上一帧的轨迹,必须在 reset 判定之前算
    const shift = this._estimateShift(dets, tileW);
    if (shift && Math.hypot(shift.dx, shift.dy) > this.config.resetShiftRatio * tileW) {
      // 手机被挪开或换了牌 —— 旧证据必须作废,否则新旧牌的投票会混在一起,
      // 用户会拿到一副从未存在过的手牌
      this.reset();
    } else if (shift) {
      for (const t of this.tracks) {
        t.cx += shift.dx;
        t.cy += shift.dy;
      }
    }

    this.frameSeq++;
    this._match(dets, tileW);
    this._ageOut();
    return this.snapshot();
  }

  /** 只读当前融合结果,不推进状态 */
  snapshot() {
    const tiles = this.tracks
      .map((t) => {
        const vote = this._bestVote(t);
        return {
          tileIndex: vote.tileIndex,
          confidence: vote.confidence,
          bbox: { x: t.cx - t.w / 2, y: t.cy - t.h / 2, w: t.w, h: t.h },
        };
      })
      .sort((a, b) => a.bbox.x - b.bbox.x);
    return { state: FuserState.COLLECTING, tiles, pending: 0, frames: this.frameSeq, progress: 0 };
  }

  /** 本帧牌宽的中位数;本帧为空则退回轨迹宽度 */
  _tileWidth(dets) {
    if (dets.length > 0) return median(dets.map((d) => d.bbox.w)) || 1;
    if (this.tracks.length > 0) return median(this.tracks.map((t) => t.w)) || 1;
    return 1;
  }

  /**
   * 估计整行的全局位移(手抖导致的平移)。
   * 用宽松阈值粗匹配后取位移中位数 —— 中位数抗离群,个别错配不影响补偿量。
   * 这比陀螺仪更直接:它测的是牌在画面里实际移动了多少像素。
   */
  _estimateShift(dets, tileW) {
    if (this.tracks.length === 0 || dets.length === 0) return null;
    const limit = this.config.matchRadiusCoarse * tileW;
    const dxs = [];
    const dys = [];
    for (const t of this.tracks) {
      let bestC = null;
      let bestD = Infinity;
      for (const d of dets) {
        const c = centerOf(d.bbox);
        const dist = Math.hypot(c.x - t.cx, c.y - t.cy);
        if (dist < bestD) {
          bestD = dist;
          bestC = c;
        }
      }
      if (bestC && bestD <= limit) {
        dxs.push(bestC.x - t.cx);
        dys.push(bestC.y - t.cy);
      }
    }
    if (dxs.length === 0) return null;
    return { dx: median(dxs), dy: median(dys) };
  }

  /**
   * 把本帧检测关联到轨迹:按置信度降序贪心,每条轨迹最多被占用一次。
   * 目标最多 14 个,不需要匈牙利算法。
   */
  _match(dets, tileW) {
    const limit = this.config.matchRadiusFine * tileW;
    const used = new Set();
    const order = [...dets].sort((a, b) => b.confidence - a.confidence);
    for (const d of order) {
      const c = centerOf(d.bbox);
      let best = null;
      let bestD = Infinity;
      for (const t of this.tracks) {
        if (used.has(t.id)) continue;
        const dist = Math.hypot(c.x - t.cx, c.y - t.cy);
        if (dist < bestD) {
          bestD = dist;
          best = t;
        }
      }
      if (best && bestD <= limit) {
        used.add(best.id);
        this._hit(best, d, c);
      } else {
        const track = this._newTrack(d, c);
        this.tracks.push(track);
        used.add(track.id);   // 本帧新建的轨迹不可再被本帧其它检测匹配
      }
    }
  }

  _newTrack(det, c) {
    return {
      id: this._nextId++,
      cx: c.x,
      cy: c.y,
      w: det.bbox.w,
      h: det.bbox.h,
      hits: [this.frameSeq],
      votes: new Map([[det.tileIndex, det.confidence]]),
      bornFrame: this.frameSeq,
      lastFrame: this.frameSeq,
    };
  }

  /** 轨迹命中本帧的一个检测:EMA 更新位置尺寸,记录命中帧,累加类别票 */
  _hit(track, det, c) {
    const a = this.config.emaAlpha;
    track.cx += a * (c.x - track.cx);
    track.cy += a * (c.y - track.cy);
    track.w += a * (det.bbox.w - track.w);
    track.h += a * (det.bbox.h - track.h);
    track.hits.push(this.frameSeq);
    track.lastFrame = this.frameSeq;
    track.votes.set(det.tileIndex, (track.votes.get(det.tileIndex) || 0) + det.confidence);
  }

  /** 裁剪窗口外的命中记录,并删除出现率跌破噪声线的轨迹 */
  _ageOut() {
    const { windowSize, pendingRate } = this.config;
    const kept = [];
    for (const t of this.tracks) {
      t.hits = t.hits.filter((f) => f > this.frameSeq - windowSize);
      if (this._rate(t) >= pendingRate) kept.push(t);
    }
    this.tracks = kept;
  }

  /** 轨迹在滑动窗口内的出现率。新生轨迹用较短的分母,避免刚出生就被判为噪声。 */
  _rate(track) {
    const denom = Math.min(this.frameSeq - track.bornFrame + 1, this.config.windowSize);
    return denom > 0 ? track.hits.length / denom : 0;
  }

  /**
   * 轨迹的类别投票结果。
   * @returns {{tileIndex:number, ratio:number, confidence:number}}
   *   ratio 为胜出类别的票重占比;confidence 为该类别的平均置信度
   */
  _bestVote(track) {
    let bestIndex = -1;
    let bestWeight = 0;
    let total = 0;
    for (const [tileIndex, weight] of track.votes) {
      total += weight;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = tileIndex;
      }
    }
    const hits = track.hits.length || 1;
    return {
      tileIndex: bestIndex,
      ratio: total > 0 ? bestWeight / total : 0,
      confidence: Math.min(1, bestWeight / hits),
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: PASS —— 测试7 下的 4 条断言全部 ✅，且原有测试 1~6 未受影响（失败数为 0）

- [ ] **Step 5: 提交**

```bash
git add js/detection-fuser.js js/test-engine.js
git commit -m "多帧融合:轨迹关联与位移中位数补偿

用位移中位数补偿手抖导致的整行平移,再两遍贪心匹配把本帧检测关联到
已有轨迹。同时剔除尺寸/基线明显不合群的误检框。"
```

---

## Task 2: 出现率三态分档与类别加权投票

**Files:**
- Modify: `js/detection-fuser.js`（`snapshot()` 方法）
- Test: `js/test-engine.js`（追加新块）

**Interfaces:**
- Consumes: 任务 1 的 `DetectionFuser`、`_rate()`、`_bestVote()`、`DEFAULT_CONFIG` 中的 `presentRate` / `voteRatio`
- Produces: `snapshot()` 返回的 `tiles` 只含「确认存在」轨迹；`pending` 为待定轨迹数（出现率处于 `[pendingRate, presentRate)`，**或**类别投票占比 < `voteRatio`）。任务 3 的状态机依赖 `pending`

- [ ] **Step 1: 写失败的测试**

在 `js/test-engine.js` 的测试7 块之后、汇总块之前追加。注意 `makeFrame` 和 `HAND13` 已在任务 1 中定义，直接复用：

```js
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

// 类别僵持:某轨迹两类各占一半(占比 0.5 < voteRatio 0.6) → 未收敛,计入 pending。
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL —— 假阳、待定、类别僵持三处断言失败，因为任务 1 的 `snapshot()` 无条件输出所有轨迹且 `pending` 恒为 0

- [ ] **Step 3: 重写 `snapshot()`**

用下面的实现整体替换 `js/detection-fuser.js` 中现有的 `snapshot()` 方法：

```js
  /**
   * 只读当前融合结果,不推进状态。
   *
   * 轨迹按出现率与类别收敛度分三档:
   *   确认存在(出现率 ≥ presentRate 且投票占比 ≥ voteRatio) → 计入 tiles
   *   待定(出现率在 [pendingRate, presentRate),或投票未收敛)  → 计入 pending
   *   噪声(出现率 < pendingRate) → 已在 _ageOut 中删除
   *
   * 「待定」这一档是有意的:降低置信度阈值后必然出现若隐若现的框,若只做
   * 二分,它们要么污染结果、要么被静默丢弃 —— 静默丢弃正是「一会儿 12 张」
   * 的问题,只是变成稳定地给出 12 张,更糟。让它阻止稳定并提示用户,用户才
   * 知道该调整角度或光线。
   */
  snapshot() {
    const { presentRate, voteRatio } = this.config;
    const present = [];
    let pending = 0;

    for (const t of this.tracks) {
      const vote = this._bestVote(t);
      if (this._rate(t) >= presentRate && vote.ratio >= voteRatio) {
        present.push({ track: t, vote });
      } else {
        pending++;
      }
    }

    const tiles = present
      .map(({ track, vote }) => ({
        tileIndex: vote.tileIndex,
        confidence: vote.confidence,
        bbox: { x: track.cx - track.w / 2, y: track.cy - track.h / 2, w: track.w, h: track.h },
      }))
      .sort((a, b) => a.bbox.x - b.bbox.x);

    return { state: FuserState.COLLECTING, tiles, pending, frames: this.frameSeq, progress: 0 };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: PASS —— 测试7、测试8 全部 ✅，失败数 0

- [ ] **Step 5: 提交**

```bash
git add js/detection-fuser.js js/test-engine.js
git commit -m "多帧融合:出现率三态分档与类别加权投票

出现率 ≥0.6 计入输出,0.3~0.6 或类别未收敛的记为待定(阻止稳定),
<0.3 老化删除。待定不进输出 —— 静默补一张类别没收敛的牌比少一张更坏。"
```

---

## Task 3: 状态机、progress、票窗口化与降级超时

**Files:**
- Modify: `js/detection-fuser.js`（`reset()`、`push()`、`snapshot()`）
- Test: `js/test-engine.js`（追加新块）

**Interfaces:**
- Consumes: 任务 2 的 `snapshot()` 返回的 `tiles` 与 `pending`
- Produces: `snapshot()` 的 `state` 取 `FuserState` 四值之一，`progress` 为 0~1 的数。`push(detections, now)` 的 `now` 开始被真正使用（降级计时）。任务 4、5 依赖 `state`、`pending`、`frames`、`progress`

- [ ] **Step 1: 写失败的测试**

在测试8 块之后、汇总块之前追加：

```js
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

// 持续不稳定超过 8 秒 → 降级为 degraded,输出仍只含确认存在的轨迹
{
  const fuser = new DetectionFuser();
  let snap;
  for (let f = 0; f < 30; f++) {
    const frame = makeFrame(HAND13);
    if (f % 2 === 0) {
      frame.push({ tileIndex: 5, confidence: 0.9, bbox: { x: 900, y: 200, w: 40, h: 56 } });
    }
    snap = fuser.push(frame, f * 400);   // 30 帧 × 400ms = 11.6s > 8s
  }
  assert(snap.state === 'degraded', `持续不稳定 8s 后降级, 实际=${snap.state}`);
  assert(snap.tiles.length === 13, `降级时输出不含待定轨迹, 实际=${snap.tiles.length}`);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL —— `state` 恒为 `'collecting'`、`progress` 恒为 0，多条断言失败

- [ ] **Step 3: 加入状态机**

**3a.** 在 `reset()` 方法中，`this._nextId = 1;` 之后追加三行状态字段：

```js
    /** 上一帧输出的牌多重集签名,用于判断输出是否连续一致 */
    this._lastSig = null;
    /** 输出连续一致的帧数 */
    this._consistent = 0;
    /** 进入 UNSTABLE 的时间戳(ms);0 表示当前不处于 UNSTABLE */
    this._unstableSince = 0;
```

**3b.** 用下面的实现整体替换 `snapshot()` 中的 `return` 语句（即任务 2 中 `return { state: FuserState.COLLECTING, ... }` 那一行）：

```js
    return { tiles, pending, frames: this.frameSeq, ...this._judge(tiles, pending) };
```

**3c.** 在 `snapshot()` 方法之后新增 `_judge()` 方法：

```js
  /**
   * 裁决状态与进度。每帧重新裁决,因此 DEGRADED 不是终态 ——
   * 判据重新满足会直接升回 STABLE,降级只是解除「按钮永远不亮」的锁死。
   *
   * 注意:本方法有副作用(维护连续一致计数与降级计时),只应由 snapshot() 调用一次。
   */
  _judge(tiles, pending) {
    const { minFramesForState, stableFrames, windowSize, degradeAfterMs } = this.config;

    // 输出的牌多重集是否与上一帧一致
    const sig = tiles.map((d) => d.tileIndex).sort((a, b) => a - b).join(',');
    if (sig === this._lastSig) {
      this._consistent++;
    } else {
      this._lastSig = sig;
      this._consistent = 1;
    }

    let state;
    if (this.frameSeq < minFramesForState) {
      state = FuserState.COLLECTING;
    } else if (pending === 0 && tiles.length > 0 && this._consistent >= stableFrames) {
      state = FuserState.STABLE;
    } else {
      state = FuserState.UNSTABLE;
    }

    // 持续不稳定太久则降级,否则光线差的场景下按钮永远不亮,功能直接不可用
    if (state === FuserState.UNSTABLE) {
      if (this._unstableSince === 0) {
        this._unstableSince = this._now;
      } else if (this._now - this._unstableSince >= degradeAfterMs) {
        state = FuserState.DEGRADED;
      }
    } else {
      this._unstableSince = 0;
    }

    // 进度取「帧数」与「连续一致帧数」两个分量的较小值。
    // 有待定轨迹时封顶 0.99 —— 此时再攒多少帧也不会稳定,进度条不该显示满格。
    let progress = Math.min(
      this.frameSeq / windowSize,
      this._consistent / stableFrames,
      1
    );
    if (pending > 0) progress = Math.min(progress, 0.99);

    return { state, progress };
  }
```

**3d.** `_judge()` 需要读到调用方传入的时间。在 `push()` 中记录它——把 `this.frameSeq++;` 一行改为两行：

```js
    // 必须在 reset 分支之后赋值:reset() 会把 _now 清零,
    // 若在 push 开头就赋值,触发 reset 的那一帧时间戳会被抹掉
    this._now = now;
    this.frameSeq++;
```

并在 `reset()` 中的 `this._unstableSince = 0;` 之后补一行，保证 `snapshot()` 在未 push 时也有值：

```js
    /** 最近一次 push 传入的时间戳 */
    this._now = 0;
    /** 本帧是否出现「检测类别与轨迹既有胜出类别不符」 */
    this._conflict = false;
```

**3e. 把类别票改为滑动窗口，并删掉失效的大位移 reset。**

Task 1 的大位移 reset 是死代码，必须删除。原因：牌是周期排列的（周期 ≈ 一个牌宽），而 `matchRadiusCoarse` 正好是 1.0 个牌宽，最近邻搜索永远折叠到最近的那个周期上——实测真实位移 40px 估成 -2、80px 估成 -4、400px 估成 -20，估计值恒在 ±半周期内，`resetShiftRatio = 1.5` 牌宽永远不可能被触及。

替代方案是让旧证据自然过期：类别票和 `hits` 用同一个滑动窗口。两者本就一一对应，合并成一个数组即可。

**(0)** `DEFAULT_CONFIG` 中把 `voteRatio` 由 `0.6` 改为 `0.7`，并换上本任务 Step 3 config 段落里给出的新注释。原因：票一旦窗口化，5 帧窗口内两个类别只能分成 5:0 / 4:1 / 3:2，比例只能取 1.0 / 0.8 / 0.6——0.6 是可达最小值，`ratio >= 0.6` 恒成立，闸门失效。

同时更新 `js/test-engine.js` 中 测试8「类别僵持」块的注释，它当前写的是 `(占比 0.5 < voteRatio 0.6)`，窗口化后实际是 `(占比 0.6 < voteRatio 0.7)`。断言本身不变。

**(1)** `DEFAULT_CONFIG` 中删除 `resetShiftRatio` 一行（它已无使用者）。

**(2)** `push()` 中删除大位移 reset 分支，只保留位移补偿。小位移的估计是准确的（8px 估成 8、20px 估成 20），手抖补偿仍然有效，必须保留。改成：

```js
    const shift = this._estimateShift(dets, tileW);
    if (shift) {
      for (const t of this.tracks) {
        t.cx += shift.dx;
        t.cy += shift.dy;
      }
    }

    this._now = now;
    this._conflict = false;
    this.frameSeq++;
```

**(3)** 轨迹用一个数组同时承载命中与投票。`_newTrack` 中把 `hits` 与 `votes` 两个字段替换为：

```js
      hits: [{ frame: this.frameSeq, tileIndex: det.tileIndex, conf: det.confidence }],
```

**(4)** `_hit()` 中把 `track.hits.push(...)` 与 `track.votes.set(...)` 两行替换为下面这段。冲突检测必须在追加本帧票**之前**做，否则本帧的票会参与到「既有胜出类别」的计算里，冲突就永远测不出来：

```js
    // 与既有胜出类别不符 → 记录冲突。仅在轨迹已有历史时判定,
    // 新生轨迹只有一票,无所谓「既有胜出类别」。
    if (track.hits.length > 1 && this._bestVote(track).tileIndex !== det.tileIndex) {
      this._conflict = true;
    }
    track.hits.push({ frame: this.frameSeq, tileIndex: det.tileIndex, conf: det.confidence });
```

**(5)** `_ageOut()` 的裁剪改为按记录的 `frame` 字段：

```js
      t.hits = t.hits.filter((h) => h.frame > this.frameSeq - windowSize);
```

**(6)** `_bestVote()` 改为在窗口内的 `hits` 上聚合，不再读 `track.votes`：

```js
  _bestVote(track) {
    const weights = new Map();
    let total = 0;
    for (const h of track.hits) {
      weights.set(h.tileIndex, (weights.get(h.tileIndex) || 0) + h.conf);
      total += h.conf;
    }
    let bestIndex = -1;
    let bestWeight = 0;
    for (const [tileIndex, weight] of weights) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestIndex = tileIndex;
      }
    }
    const hits = track.hits.length || 1;
    return {
      tileIndex: bestIndex,
      ratio: total > 0 ? bestWeight / total : 0,
      confidence: Math.min(1, bestWeight / hits),
    };
  }
```

**(7)** `_judge()` 中，把 STABLE 的判定条件加上「本帧无类别冲突」。窗口化留下一个 1~2 帧的缺口：换牌后旧票仍暂时占多数，若不拦，fuser 会绿灯报出**旧手牌**——正是设计文档说的「比少一张更坏」。把这一行：

```js
    } else if (pending === 0 && tiles.length > 0 && this._consistent >= stableFrames) {
```

改为：

```js
    } else if (!this._conflict && pending === 0 && tiles.length > 0 && this._consistent >= stableFrames) {
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: PASS —— 测试7、8、9 全部 ✅，失败数 0

- [ ] **Step 5: 提交**

```bash
git add js/detection-fuser.js js/test-engine.js
git commit -m "多帧融合:状态机、票窗口化与降级兜底

STABLE 需同时满足无待定、类别收敛、无本帧类别冲突、输出连续 3 帧一致。
类别票与 hits 共用滑动窗口,换牌后旧证据自然过期 —— 原本基于位移中位数
的 reset 是死代码:牌周期排列且粗匹配半径等于周期,估计值恒落在 ±半周期
内,1.5 牌宽的阈值永远触不到。持续不稳定 8s 降级解锁强制确认。"
```

---

## Task 4: 接入 `app.js` 与降低置信度阈值

**Files:**
- Modify: `js/recognition.js:44`
- Modify: `js/app.js`（import 区、`stopDetectionLoop`、`detectionTick`）
- Test: 手动验证（DOM 逻辑无自动化测试）

**Interfaces:**
- Consumes: 任务 3 的 `DetectionFuser`、`push(detections, now)` 返回的 `{ state, tiles, pending, frames, progress }`
- Produces: 模块级 `fuser` 实例；`liveDetections` 的数据源变为融合结果。`updateLiveBadge()` 在本任务中改为接受一个 `snapshot` 参数（文案渲染在任务 5 完成）

- [ ] **Step 1: 降低置信度阈值**

`js/recognition.js` 第 44 行：

```js
    /** 检测置信度阈值 */
    this.confThreshold = 0.5;
```

改为：

```js
    /**
     * 检测置信度阈值。
     * 刻意设得比常规低:先把弱证据放进来,再由 detection-fuser.js 用多帧
     * 出现率把噪声滤出去。单帧看会有假阳,融合后反而更稳。
     */
    this.confThreshold = 0.3;
```

- [ ] **Step 2: 在 `app.js` 引入 fuser**

在 `js/app.js` 的 import 区追加（与其它 `./xxx.js` 相对导入放在一起）：

```js
import { DetectionFuser, FuserState } from './detection-fuser.js';
```

在 `let detectionLoopActive = false;`（约 `app.js:126`）之后追加：

```js
/** 多帧检测融合器:消除单帧识别的张数与类别抖动 */
const fuser = new DetectionFuser();
```

- [ ] **Step 3: 停止循环时清空累积证据**

`stopDetectionLoop()`（约 `app.js:150`）中，在 `detectionLoopActive = false;` 之后追加一行：

```js
  fuser.reset();
```

这覆盖了「点确认」「切到手动模式」两条路径——两者都会调用 `stopDetectionLoop()`。取消预览后重启摄像头走 `startCamera()`，此时 fuser 已是干净状态。

- [ ] **Step 4: 改写 `detectionTick` 的结果处理**

`js/app.js:203-210` 现有的：

```js
    if (result.success) {
      // 把条带内的 bbox 平移回全帧坐标系,叠加层和冻结预览才能对齐
      result.tiles.forEach((d) => { d.bbox.y += yOffset; });
      liveDetections = result.tiles;
      liveImageData = imageData;
      updateLiveBadge();
      drawOverlay();
    }
```

替换为：

```js
    if (result.success) {
      // 把条带内的 bbox 平移回全帧坐标系,叠加层和冻结预览才能对齐
      result.tiles.forEach((d) => { d.bbox.y += yOffset; });
      // 喂给融合器:叠加层画的是多帧融合结果而非最后一帧,框本身也不再抖
      const snap = fuser.push(result.tiles, performance.now());
      liveDetections = snap.tiles;
      liveImageData = imageData;
      updateLiveBadge(snap);
      drawOverlay();
    }
```

- [ ] **Step 5: 让 `updateLiveBadge` 接受参数（临时形态，任务 5 完成文案）**

`js/app.js:250` 的 `function updateLiveBadge() {` 改为 `function updateLiveBadge(snap) {`，函数体暂不动（`liveDetections` 已是融合结果，行为正确）。

同时检查 `stopDetectionLoop()` 之外是否还有无参调用：`startCamera()` 中只设置 `liveCountBadge.textContent`，不调用本函数，无需改动。

- [ ] **Step 6: 确认引擎测试未受影响**

Run: `npm run test`
Expected: PASS，失败数 0（本任务不改引擎，但 `app.js` 的语法错误不会被它捕获，故仍需下一步）

- [ ] **Step 7: 真机验证**

Run: `npm run preview:pages`，用手机访问 :8788，切到「📷 拍照识别」，摆一副 13 张的牌。

检查四点：
1. 浏览器控制台无报错（尤其是模块导入路径）
2. 叠加框不再逐帧抖动，位置平滑
3. 端稳约 2 秒后，badge 显示的张数稳定不跳
4. 点「确认识别结果」能正常进入预览页，牌数与叠加框一致

若控制台报 `Failed to resolve module specifier`，说明 import 路径漏了 `./` 前缀或 `.js` 扩展名。

- [ ] **Step 8: 提交**

```bash
git add js/app.js js/recognition.js
git commit -m "接入多帧融合,置信度阈值降到 0.3

叠加层与确认结果改用融合快照而非最后一帧。阈值降低让边缘牌进入候选,
假阳交由出现率过滤 —— 先放宽证据再用时序滤噪。"
```

---

## Task 5: 状态化 UI —— badge 文案、取相框颜色、降级按钮

**Files:**
- Modify: `js/app.js`（`updateLiveBadge`）
- Modify: `css/style.css:740-748`（`#camera-container::after`）、`css/style.css:313` 附近（新增 `.action-btn.warn`）
- Test: 手动验证

**Interfaces:**
- Consumes: 任务 3 的 `FuserState` 四个状态值、`snapshot` 的 `state` / `pending` / `frames` / `tiles`
- Produces: 无下游依赖（终点任务）

- [ ] **Step 1: 取相框虚线颜色改为随状态变的 CSS 变量**

`css/style.css:740-748` 现有的：

```css
/* 取相框上下边缘虚线,标示拍摄条带 */
#camera-container::after {
  content: '';
  position: absolute;
  inset: 0;
  border-top: 2px dashed rgba(0, 212, 170, 0.5);
  border-bottom: 2px dashed rgba(0, 212, 170, 0.5);
  pointer-events: none;
  z-index: 5;
}
```

替换为：

```css
/* 取相框上下边缘虚线,标示拍摄条带。
   颜色随融合状态变化,用户用余光就能判断该不该按,不必去读文字。 */
#camera-container::after {
  content: '';
  position: absolute;
  inset: 0;
  border-top: 2px dashed var(--band-color, rgba(0, 212, 170, 0.5));
  border-bottom: 2px dashed var(--band-color, rgba(0, 212, 170, 0.5));
  pointer-events: none;
  z-index: 5;
  transition: border-color 0.25s ease;
}

#camera-container[data-fuse-state='collecting'] { --band-color: rgba(255, 255, 255, 0.35); }
#camera-container[data-fuse-state='unstable']   { --band-color: rgba(212, 165, 116, 0.75); }
#camera-container[data-fuse-state='stable']     { --band-color: rgba(0, 212, 170, 0.9); }
#camera-container[data-fuse-state='degraded']   { --band-color: rgba(224, 138, 60, 0.85); }
```

- [ ] **Step 2: 新增降级按钮样式**

在 `css/style.css` 的 `.action-btn.danger` 规则块之前（约第 313 行 `/* Danger - Red */` 注释之前）插入：

```css
/* Warn - Amber:识别未达稳定但允许强制确认 */
.action-btn.warn {
  background: linear-gradient(135deg, #e08a3c 0%, #c4702a 100%);
  color: #fff;
  box-shadow: 0 4px 15px rgba(224, 138, 60, 0.25), inset 0 1px 0 rgba(255,255,255,0.15);
}

.action-btn.warn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(224, 138, 60, 0.35);
}

.action-btn.warn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 2px 8px rgba(224, 138, 60, 0.2);
}
```

- [ ] **Step 3: 在 `app.js` 取得容器引用**

在 `app.js` 的 DOM 引用区（`const btnConfirm = $('btn-confirm');` 附近，约第 37 行）追加：

```js
const cameraContainer = $('camera-container');
```

- [ ] **Step 4: 改写 `updateLiveBadge`**

用下面的实现整体替换 `js/app.js:250-261` 的 `updateLiveBadge` 函数：

```js
/** 上一次写入 badge 的内容签名,避免以 2~3 fps 反复改写 aria-live 区域 */
let lastBadgeKey = '';

/**
 * 按融合状态渲染 badge、确认按钮与取相框颜色。
 *
 * badge 带 aria-live="polite",若每帧改写 textContent 读屏软件会念个不停,
 * 因此只在内容真正变化时才碰 DOM。COLLECTING 阶段要显示进度,故签名含帧数;
 * 其余状态不含,避免帧数递增导致的无谓重绘。
 *
 * @param {{state: string, tiles: Array, pending: number, frames: number}} snap
 */
function updateLiveBadge(snap) {
  const n = snap.tiles.length;
  const key = snap.state === FuserState.COLLECTING
    ? `collecting|${snap.frames}`
    : `${snap.state}|${n}|${snap.pending}`;
  if (key === lastBadgeKey) return;
  lastBadgeKey = key;

  cameraContainer.dataset.fuseState = snap.state;
  btnConfirm.classList.remove('primary', 'warn');

  switch (snap.state) {
    case FuserState.COLLECTING:
      liveCountBadge.textContent = `采集中 ${snap.frames}/${fuser.config.windowSize}`;
      btnConfirm.textContent = '✔ 确认识别结果';
      btnConfirm.classList.add('primary');
      btnConfirm.disabled = true;
      break;

    case FuserState.UNSTABLE:
      liveCountBadge.textContent = snap.pending > 0
        ? `有 ${snap.pending} 处不确定,微调角度或光线`
        : '稳定中…';
      btnConfirm.textContent = '✔ 确认识别结果';
      btnConfirm.classList.add('primary');
      btnConfirm.disabled = true;
      break;

    case FuserState.STABLE:
      liveCountBadge.textContent = `✓ 已稳定 · ${n} 张`;
      btnConfirm.textContent = `✔ 确认识别 (${n} 张)`;
      btnConfirm.classList.add('primary');
      btnConfirm.disabled = n === 0;
      break;

    case FuserState.DEGRADED:
      liveCountBadge.textContent = '⚠️ 识别不稳定';
      btnConfirm.textContent = `⚠️ 仍不稳定,仍要确认 (${n} 张)`;
      btnConfirm.classList.add('warn');
      btnConfirm.disabled = n === 0;
      break;
  }
}
```

- [ ] **Step 5: 停止循环时复位 badge 签名与按钮样式**

`stopDetectionLoop()` 中，在任务 4 加的 `fuser.reset();` 之后追加：

```js
  lastBadgeKey = '';
  cameraContainer.dataset.fuseState = 'collecting';
  btnConfirm.classList.remove('warn');
  btnConfirm.classList.add('primary');
```

不复位签名的话，再次进入摄像头模式时若首帧状态恰好与上次退出时相同，badge 会停在旧文案。

- [ ] **Step 6: 确认引擎测试未受影响**

Run: `npm run test`
Expected: PASS，失败数 0

- [ ] **Step 7: 真机验证五个状态**

Run: `npm run preview:pages`，手机访问 :8788 → 拍照识别。

| 操作 | 预期 |
| --- | --- |
| 刚打开摄像头 | badge「采集中 1/5」逐帧递增，虚线灰色，按钮灰禁用 |
| 对准 13 张牌端稳约 2 秒 | badge「✓ 已稳定 · 13 张」，虚线绿色，按钮绿色可点 |
| 手指半遮一张牌 | badge「有 1 处不确定，微调角度或光线」，虚线琥珀色，按钮禁用 |
| 保持遮挡约 8 秒 | badge「⚠️ 识别不稳定」，虚线橙色，按钮变橙可点 |
| 移开手指 | 自动升回绿色 stable |
| 大幅移开手机再对准 | badge 回到「采集中 1/5」（触发了 reset） |
| 点确认 → 取消 → 再次识别 | badge 从「采集中」重新开始，按钮为绿色而非橙色 |

- [ ] **Step 8: 提交**

```bash
git add js/app.js css/style.css
git commit -m "识别状态可视化:badge 文案、取相框颜色与降级按钮

四态各有文案与配色,用户用余光即可判断该不该按。badge 带 aria-live,
只在内容变化时写 DOM,避免读屏软件被 2~3 fps 的刷新刷屏。"
```

---

## Task 6: 更新项目文档

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 全部前序任务的成果
- Produces: 无

- [ ] **Step 1: 在模块职责表中登记新模块**

`CLAUDE.md` 的「模块职责」表中，在 `js/recognition.js` 一行之后插入：

```markdown
| `js/detection-fuser.js` | 多帧检测融合：跨帧轨迹关联 + 出现率分档 + 类别投票 + 稳定状态机。不依赖 DOM，可被 node 引入 |
```

- [ ] **Step 2: 新增架构约束小节**

在「### 摄像头「条带取景」的三处耦合常量」小节之后插入：

```markdown
### 识别结果必须经过多帧融合，不能直接用单帧

单帧 YOLO 在置信度阈值附近会闪，13 张牌会在 12/13 之间跳动、类别会在相邻两张之间跳变。`recognition.js` 的 `confThreshold` 因此**刻意设为 0.3 而非常规的 0.5**——先把弱证据放进来，再由 `detection-fuser.js` 用多帧出现率把噪声滤出去。**单独调高阈值而不动融合器，或者绕过融合器直接用 `detect()` 的结果，都会让抖动回归。**

`app.js` 的 `detectionTick` 把原始检测喂给模块级的 `fuser`，用返回快照的 `tiles` 赋给 `liveDetections`。融合器的输出结构与原始检测完全一致，因此 `drawOverlay`、确认流程、预览页都不感知它的存在。

三个容易踩的点：

- **`stopDetectionLoop()` 必须调 `fuser.reset()`**，否则上一副牌的投票会污染下一副，用户会拿到一副从未存在过的手牌。
- **fuser 不得引用任何 DOM/浏览器 API**，时间由 `push(detections, now)` 的第二个参数传入。这是它能在 `js/test-engine.js` 里被 node 测试的前提——融合逻辑无法靠对着摄像头肉眼调准。
- **「待定」轨迹不进输出但会阻止 stable**。这是有意的：静默补一张类别没收敛的牌，比少一张更坏。持续 8 秒不稳定会降级为 DEGRADED 解锁强制确认，否则光线差时按钮永远不亮。

所有阈值集中在 `detection-fuser.js` 的 `DEFAULT_CONFIG`，真机调参只改那一处。
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "文档:登记 detection-fuser 模块与多帧融合约束"
```

---

## Self-Review 记录

**Spec 覆盖检查**（逐节对照 `2026-07-26-detection-fusion-design.md`）：

| Spec 小节 | 对应任务 |
| --- | --- |
| 新模块 `detection-fuser.js` 与三方法接口 | Task 1 |
| 位移中位数补偿 + 两遍贪心匹配 | Task 1 |
| 离群框剔除（B 方案并入部分） | Task 1 |
| 轨迹三态与「待定」 | Task 2 |
| 类别加权投票 | Task 2 |
| `confThreshold` 0.5 → 0.3 | Task 4 Step 1 |
| 状态机三条判据 | Task 3 |
| `progress` 算法与 0.99 封顶 | Task 3 |
| 自动 reset（1.5 牌宽） | Task 3 |
| DEGRADED 兜底与升回 STABLE | Task 3 |
| badge 文案表与 aria-live 节流 | Task 5 |
| 取相框虚线颜色 | Task 5 |
| 确认按钮三态样式 | Task 5 |
| `app.js` 接线 | Task 4 |
| 六个测试场景 | Task 1（3 条）、Task 2（3 条）、Task 3（reset 与降级） |
| `DEFAULT_CONFIG` 参数集中 | Task 1 |

**与 spec 的一处澄清**：spec 的测试场景 4 写作「单帧假阳……不阻止 STABLE」。实际推导下来，出现率随窗口滑动衰减需要若干帧（1 → 0.5 → 0.33 → 0.25 → 0.2），在跌破 `pendingRate` 之前它会短暂计入 `pending` 并推迟 STABLE 数帧。这是出现率机制的正确行为，不是缺陷。因此 Task 2 的对应测试喂 6 帧而非 5 帧，断言的是「最终不进入输出、最终 pending 归零」。

**类型一致性**：`push()` / `snapshot()` 全程返回同一形状 `{ state, tiles, pending, frames, progress }`；`tiles` 元素恒为 `{ tileIndex, confidence, bbox }`，与 `recognition.js` 的 `postprocess` 输出一致（不含 `className`——`drawOverlay` 用的是 `TILE_NAMES[det.tileIndex]`，预览页用的是 `createTileElement(det.tileIndex, 'sm')`，均不读 `className`，故安全）。`_rate()`、`_bestVote()`、`_judge()` 在定义任务与使用任务间命名一致。

## 不在本计划范围

- **分块推理**（把 40:9 条带切成两个重叠块逐帧轮流推理，有效分辨率翻倍）。收益需实测，且要求轨迹关联处理「本帧只覆盖半边」，稳定判据随之复杂。
- **模型域偏差**。当前模型基于 Roboflow 公开数据集训练，多帧投票救不了「在特定牌面和光照下系统性判错」——若某张牌 80% 的帧都判成另一张，融合只会稳定地给出错误答案。实施后若发现是固定几种牌一直错，即为此类问题，需补数据重训。
