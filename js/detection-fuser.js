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
  // presentRate/pendingRate/voteRatio 三者都是「窗口内命中次数」算出的比例,
  // 分子分母是整数,可达值是有限集合而非连续区间(windowSize=5 时非 0/1 的
  // 可达值为 {0.2, 0.25, 0.333, 0.4, 0.5, 0.6, 0.667, 0.75, 0.8})。阈值一旦
  // 卡在某个可达值上,`>=` 判据就会恒真或恒假 —— 已经在 voteRatio(曾为
  // 0.6,恰是窗口内两类别可达的最小占比)和 presentRate(曾为 0.6,恰是
  // 3/5 的 IEEE754 精确值)上各踩过一次。改动这三者中任意一个,或改动
  // windowSize 本身,都必须重新核对新阈值没有落在可达集合上。
  presentRate: 0.7,       // 出现率 ≥ 此值视为「确认存在」。0.6 曾是隔帧
                           // 出现的幻影框(命中率 3/5=0.6)恰好达标的边界值,
                           // 会周期性把幻影框误判为确认存在。0.7 落在可达值
                           // 0.667 与 0.75 之间,两侧都有余量。
  pendingRate: 0.3,       // 出现率 < 此值视为噪声,老化删除
  voteRatio: 0.7,         // 类别投票胜出占比下限。票是按置信度加权的,所以
                           // ratio 本身取值连续;但在各帧置信度相近(实际情况)
                           // 时它会贴近等权可达值:窗口内两个候选类别只能分成
                           // 5:0/4:1/3:2,等权比例只能取 1.0/0.8/0.6 —— 0.7 落在
                           // 0.6 与 0.8 之间,意味着「5 帧里至少 4 帧同类」,
                           // 且不与任何等权可达值相等。
  // 一条轨迹至少要命中这么多帧才可能算「确认存在」。1 是危险的:_rate() 对
  // 新生轨迹用短分母(见其注释),出生当帧出现率就是 1/1=1.0、投票占比也是
  // 1.0,单个幻影框会立刻被算作一张牌。STABLE 有「输出连续一致」兜底,
  // DEGRADED 没有 —— 而 DEGRADED 恰恰是检测最脏时走的那条路。
  // 这是对整数计数的比较(hits.length ∈ {1..windowSize}),阈值取到可达值
  // 是有意的:2 就是要把「只有 1 帧证据」这一档挡在外面。
  minHitsForPresent: 2,
  stableFrames: 3,        // 输出连续一致所需帧数
  // 粗匹配阈值(牌宽倍数),用于估计全局位移。注意:对一行紧密排列的牌,
  // 这道闸门是「常开」的 —— 详见 _estimateShift 里的说明。
  matchRadiusCoarse: 1.0,
  matchRadiusFine: 0.4,   // 补偿后精匹配阈值(牌宽倍数)
  degradeAfterMs: 8000,   // 持续不稳定多久后降级
  // 相邻两帧时间戳相差超过此值,视为帧流中断(页面被切到后台、锁屏、
  // 系统挂起),累积的证据已经不可信 —— 回来时镜头很可能对着另一副牌、
  // 另一个位置,旧轨迹与新检测混在一起会拼出一副从未存在过的手牌。
  // 实测节奏 2~3 fps(帧间隔 300~500ms),低端机再慢也在 1.5s 内,
  // 3s 与正常帧间隔拉开一个数量级,不会被慢机器误触发。
  staleFrameGapMs: 3000,
  // 有 pending 轨迹、或本帧一张确认存在的牌都没有时,进度条封顶于此 ——
  // 前者再攒多少帧也不会稳定,后者对着空气也不该显示满格,都是错误信号。
  pendingProgressCap: 0.99,
  emaAlpha: 0.5,          // 轨迹位置/尺寸的 EMA 平滑系数
  minFramesForState: 3,   // 少于此帧数一律 COLLECTING
  outlierMinBoxes: 4,     // 少于此框数不做离群剔除(中位数不可靠)
  outlierHeightLo: 0.6,   // 高度低于中位数此倍数 → 剔除
  outlierHeightHi: 1.6,   // 高度高于中位数此倍数 → 剔除
  // 底边偏离基线中位数超过此倍数牌高 → 剔除。这道闸门是**故意放得很松**的:
  // 它拿每个框的底边和「底边中位数」(一条水平线)比,而牌行在画面里只要
  // 有倾角 θ,偏离量就随着离行中心的距离线性增长 —— 手牌越长,能容忍的
  // 角度越小。0.5 时 13 张牌只能容忍约 6°,而手持手机很少正好摆在 6° 以内,
  // 一倾斜两端的牌就被剔掉,又因为剔除发生在建轨迹之前,这些牌根本不会
  // 变成 pending、也就拦不住 STABLE —— 结果是给 13 张牌打出绿色的
  // 「✓ 已稳定 · 9 张」,正是本模块最要避免的失效。2.0 把容忍角放宽到 20° 以上,
  // 同时一个满尺寸、离行 160px 的幻影框(160 > 2.0×56)仍会被拦下。
  // 真正畸形的框由上面的高度闸门负责,不指望这一条。
  // (根治办法是对 (cx, y+h) 做最小二乘拟合、按到直线的残差判定,因为基线
  // 本来就是一条直线而非一个水平常数;当前只是把阈值放松到不误伤的量级。)
  outlierBaseline: 2.0,
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

  /**
   * 清空全部累积证据。切模式、结束一次识别会话、页面被切到后台时必须调用。
   *
   * 没有「移动多少像素就自动 reset」这样的触发器 —— 那条规则曾经存在,
   * 因为它的阈值恰好卡在可达值上而被删掉了。取而代之的是投票自然过期:
   * 轨迹只保留最近 windowSize 帧的命中(见 _ageOut),旧票会随窗口滑出,
   * 换牌/移动后旧证据自己会消失,过渡期里轨迹落在 pending 挡住 STABLE。
   * 唯一需要外部/内部显式 reset 的是「帧流断了」的情形,见 staleFrameGapMs。
   */
  reset() {
    /** @type {Array<object>} 活跃轨迹 */
    this.tracks = [];
    /** 已处理帧数,同时用作帧序号 */
    this.frameSeq = 0;
    this._nextId = 1;
    /** 上一帧输出的牌多重集签名,用于判断输出是否连续一致 */
    this._lastSig = null;
    /** 输出连续一致的帧数 */
    this._consistent = 0;
    /** 进入 UNSTABLE 的时间戳(ms);null 表示当前不处于 UNSTABLE */
    this._unstableSince = null;
    /** 最近一次 push 传入的时间戳 */
    this._now = 0;
    /** 上一帧 push 的时间戳;null 表示 reset 后还没有过任何一帧 */
    this._lastPushAt = null;
    /** 本帧是否出现「检测类别与轨迹既有胜出类别不符」 */
    this._conflict = false;
    /**
     * push() 每次结算后缓存的完整快照;snapshot() 只读它,不重新计算、
     * 不产生副作用。未 push 过时也要有合理的初值。
     */
    this._lastResult = { state: FuserState.COLLECTING, tiles: [], pending: 0, frames: 0, progress: 0 };
  }

  /**
   * 喂入一帧原始检测。
   * @param {Array<{tileIndex:number, confidence:number, bbox:{x:number,y:number,w:number,h:number}}>} detections
   * @param {number} [now] 调用方提供的时间戳(ms)。fuser 不自己取时钟,以便测试喂假时间。
   * @returns {{state:string, tiles:Array, pending:number, frames:number, progress:number}}
   */
  push(detections, now = 0) {
    // 帧流断过就把证据全部作废。降级计时器用的是墙钟时间,而证据窗口按帧计,
    // 页面被切到后台时帧不再来、证据不会衰减,墙钟却一直在走 —— 回来的第一帧
    // 就可能直接判成 DEGRADED,并把旧牌与新牌拼在一起输出。
    // reset() 会把 _lastPushAt 清成 null,所以 reset 后的第一帧不会被当成断流。
    if (this._lastPushAt !== null && now - this._lastPushAt >= this.config.staleFrameGapMs) {
      this.reset();
    }
    this._lastPushAt = now;

    const dets = rejectOutliers(detections || [], this.config);
    const tileW = this._tileWidth(dets);

    // 位移估计要用上一帧的轨迹
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
    this._match(dets, tileW);
    this._ageOut();

    const { tiles, pending } = this._classify();
    this._lastResult = { tiles, pending, frames: this.frameSeq, ...this._judge(tiles, pending) };
    return this.snapshot();
  }

  /**
   * 只读当前融合结果,不推进状态、不产生任何副作用 —— 单纯格式化
   * push() 已经算好并缓存在 this._lastResult 里的值。可以任意多次调用。
   */
  snapshot() {
    return this._lastResult;
  }

  /**
   * 把轨迹按出现率与类别收敛度分三档。纯函数,不修改任何状态,可被
   * push() 或测试反复调用而不影响结果。
   *
   *   确认存在(命中 ≥ minHitsForPresent 帧、出现率 ≥ presentRate
   *            且投票占比 ≥ voteRatio) → 计入 tiles
   *   待定(证据不足以确认,但出现率还没跌到噪声线)              → 计入 pending
   *   噪声(出现率 < pendingRate) → 已在 _ageOut 中删除
   *
   * 「命中帧数」这一条独立于出现率:_rate() 对新生轨迹用短分母(那是为了
   * 「存活」判定,不让刚出生的轨迹被当噪声删掉),代价是出生当帧出现率恒为
   * 1.0。若不另加帧数下限,一个单帧幻影框会在出生那一帧就被算成一张牌。
   * 未成熟的轨迹并入「待定」而不是静默丢弃,才能在 pending 里被看见并挡住
   * STABLE —— 静默补一张来路不明的牌,比少一张更坏。
   *
   * 「待定」这一档是有意的:降低置信度阈值后必然出现若隐若现的框,若只做
   * 二分,它们要么污染结果、要么被静默丢弃 —— 静默丢弃正是「一会儿 12 张」
   * 的问题,只是变成稳定地给出 12 张,更糟。让它阻止稳定并提示用户,用户才
   * 知道该调整角度或光线。
   */
  _classify() {
    const { presentRate, voteRatio, minHitsForPresent } = this.config;
    const present = [];
    let pending = 0;

    for (const t of this.tracks) {
      const vote = this._bestVote(t);
      const mature = t.hits.length >= minHitsForPresent;
      if (mature && this._rate(t) >= presentRate && vote.ratio >= voteRatio) {
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

    return { tiles, pending };
  }

  /**
   * 裁决状态与进度。每次 push() 重新裁决,因此 DEGRADED 不是终态 ——
   * 判据重新满足会直接升回 STABLE,降级只是解除「按钮永远不亮」的锁死。
   *
   * 注意:本方法有副作用(维护连续一致计数与降级计时),只应由 push() 调用
   * 一次;snapshot() 不得调用它,否则「只读」就名不副实。
   */
  _judge(tiles, pending) {
    const { minFramesForState, stableFrames, windowSize, degradeAfterMs, pendingProgressCap } = this.config;

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
    } else if (!this._conflict && pending === 0 && tiles.length > 0 && this._consistent >= stableFrames) {
      state = FuserState.STABLE;
    } else {
      state = FuserState.UNSTABLE;
    }

    // 持续不稳定太久则降级,否则光线差的场景下按钮永远不亮,功能直接不可用
    if (state === FuserState.UNSTABLE) {
      if (this._unstableSince === null) {
        this._unstableSince = this._now;
      } else if (this._now - this._unstableSince >= degradeAfterMs) {
        state = FuserState.DEGRADED;
      }
    } else {
      this._unstableSince = null;
    }

    // 进度取「帧数」与「连续一致帧数」两个分量的较小值。
    // 有待定轨迹、或本帧没有任何确认存在的牌时,封顶 pendingProgressCap ——
    // 前者攒多少帧也不会稳定,后者对着空气不该显示满格,都不是「可以确认」。
    let progress = Math.min(
      this.frameSeq / windowSize,
      this._consistent / stableFrames,
      1
    );
    if (pending > 0 || tiles.length === 0) progress = Math.min(progress, pendingProgressCap);

    return { state, progress };
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
   *
   * 关于下面的 `bestD <= limit`(matchRadiusCoarse × 牌宽):对一行紧密排列的
   * 牌,**这道闸门永远不会触发**,不要把它当成一道活的防线。行是周期结构
   * (周期 = 牌间距),位移多大都会混叠到「不超过半个周期」的最近邻距离上,
   * 而半个周期恒小于 1.0 × 牌宽。因此:
   *   - 位移补偿真正买到的容忍度,是 matchRadiusFine×牌宽 到半个周期之间
   *     (实测:每帧漂移 20px 仍能跟住,22px 就散架;不做补偿只能扛到 16px);
   *   - 超过半个周期后,估计值会混叠成一个「自信而错误」的位移,轨迹整体错位
   *     一张牌。挡住它的不是这里,而是下游的类别冲突闸门(_hit 里的
   *     this._conflict)和「输出连续一致 stableFrames 帧」的要求。
   * 保留这个判据是为了行数很少、不成周期结构时(如只识出两三张)仍有约束。
   */
  _estimateShift(dets, tileW) {
    if (this.tracks.length === 0 || dets.length === 0) return null;
    // 见上:紧密排列的一行里,这个 limit 恒不生效
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
      hits: [{ frame: this.frameSeq, tileIndex: det.tileIndex, conf: det.confidence }],
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
    track.lastFrame = this.frameSeq;
    // 与既有胜出类别不符 → 记录冲突。仅在轨迹已有历史时判定,
    // 新生轨迹只有一票,无所谓「既有胜出类别」。
    if (track.hits.length > 1 && this._bestVote(track).tileIndex !== det.tileIndex) {
      this._conflict = true;
    }
    track.hits.push({ frame: this.frameSeq, tileIndex: det.tileIndex, conf: det.confidence });
  }

  /** 裁剪窗口外的命中记录,并删除出现率跌破噪声线的轨迹 */
  _ageOut() {
    const { windowSize, pendingRate } = this.config;
    const kept = [];
    for (const t of this.tracks) {
      t.hits = t.hits.filter((h) => h.frame > this.frameSeq - windowSize);
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
}
