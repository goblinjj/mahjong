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
  presentRate: 0.6,       // 出现率 ≥ 此值视为「确认存在」
  pendingRate: 0.3,       // 出现率 < 此值视为噪声,老化删除
  // 类别投票胜出占比下限。票随 windowSize=5 的滑动窗口,窗口内两个候选类别
  // 只能分成 5:0/4:1/3:2,比例只能取 1.0/0.8/0.6 —— 0.6 是可达最小值,阈值
  // 若取 0.6 则 ratio >= voteRatio 恒成立,闸门失效。取 0.7 意味着「5 帧里
  // 至少 4 帧同类」,离 0.6/0.8 两侧都有余量,不卡在窗口能达到的边界值上。
  voteRatio: 0.7,
  stableFrames: 3,        // 输出连续一致所需帧数
  matchRadiusCoarse: 1.0, // 粗匹配阈值(牌宽倍数),用于估计全局位移
  matchRadiusFine: 0.4,   // 补偿后精匹配阈值(牌宽倍数)
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
    /** 上一帧输出的牌多重集签名,用于判断输出是否连续一致 */
    this._lastSig = null;
    /** 输出连续一致的帧数 */
    this._consistent = 0;
    /** 进入 UNSTABLE 的时间戳(ms);0 表示当前不处于 UNSTABLE */
    this._unstableSince = 0;
    /** 最近一次 push 传入的时间戳 */
    this._now = 0;
    /** 本帧是否出现「检测类别与轨迹既有胜出类别不符」 */
    this._conflict = false;
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
    return this.snapshot();
  }

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

    return { tiles, pending, frames: this.frameSeq, ...this._judge(tiles, pending) };
  }

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
    } else if (!this._conflict && pending === 0 && tiles.length > 0 && this._consistent >= stableFrames) {
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
