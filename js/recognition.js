/**
 * recognition.js - ONNX Runtime Web 推理管线
 *
 * YOLOv8 麻将牌检测模型的预处理、推理、后处理管线。
 * 模型从默认路径 /assets/model/mahjong_yolov8n.onnx 自动加载；
 * 无模型时前端可走 buildDemoDetections 演示流程。
 */

/**
 * 模型状态枚举
 */
export const ModelStatus = {
  UNLOADED: 'unloaded',      // 从未尝试加载
  LOADING: 'loading',        // 正在加载
  READY: 'ready',            // 加载成功
  MISSING: 'missing',        // 模型文件不存在（404）
  ORT_MISSING: 'ort_missing', // onnxruntime-web 未引入
  ERROR: 'error',            // 其他加载错误
};

export class TileRecognizer {
  constructor() {
    /** @type {any} ONNX 推理会话 */
    this.session = null;
    /** @type {string} 当前状态，见 ModelStatus */
    this.status = ModelStatus.UNLOADED;
    /** @type {string} 最近一次错误信息 */
    this.lastError = '';
    /** @type {string} 默认模型文件路径（相对于站点根）
     *  ?v= 版本号用于绕过浏览器 immutable 缓存。
     *  每次替换模型文件时递增该值，让用户拉取最新模型。
     */
    this.modelPath = '/assets/model/mahjong_yolov8n.onnx?v=2';

    /** 检测置信度阈值 */
    this.confThreshold = 0.5;
    /** NMS IoU 阈值 (麻将牌通常紧贴不重叠，用较低阈值抑制重复框) */
    this.iouThreshold = 0.35;
    /** 模型输入尺寸 */
    this.inputSize = 640;

    /**
     * 34 类牌名，与引擎索引一致
     * 0-8: 万, 9-17: 条, 18-26: 筒, 27-30: 风, 31: 中, 32: 发, 33: 白
     */
    this.classNames = [
      '1wan', '2wan', '3wan', '4wan', '5wan', '6wan', '7wan', '8wan', '9wan',
      '1tiao', '2tiao', '3tiao', '4tiao', '5tiao', '6tiao', '7tiao', '8tiao', '9tiao',
      '1tong', '2tong', '3tong', '4tong', '5tong', '6tong', '7tong', '8tong', '9tong',
      'dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai',
    ];

    /**
     * Roboflow mahjong-baq4s (42 类) → 项目 34 类 索引映射。
     * 索引即 Roboflow 类顺序(按字母序):
     *   1B~9B=条, 1C~9C=万, 1D~9D=筒, 1F~4F=花, 1S~4S=季,
     *   EW=东, SW=南, WW=西, NW=北, RD=中, GD=发, WD=白
     * 花牌/季牌(1F-4F, 1S-4S)本项目不支持 → 映射为 null,推理时丢弃。
     */
    this.roboflow42to34 = [
      9,    // 0  1B  → 1tiao
      0,    // 1  1C  → 1wan
      18,   // 2  1D  → 1tong
      null, // 3  1F
      null, // 4  1S
      10,   // 5  2B  → 2tiao
      1,    // 6  2C  → 2wan
      19,   // 7  2D  → 2tong
      null, // 8  2F
      null, // 9  2S
      11,   // 10 3B
      2,    // 11 3C
      20,   // 12 3D
      null, // 13 3F
      null, // 14 3S
      12,   // 15 4B
      3,    // 16 4C
      21,   // 17 4D
      null, // 18 4F
      null, // 19 4S
      13,   // 20 5B
      4,    // 21 5C
      22,   // 22 5D
      14,   // 23 6B
      5,    // 24 6C
      23,   // 25 6D
      15,   // 26 7B
      6,    // 27 7C
      24,   // 28 7D
      16,   // 29 8B
      7,    // 30 8C
      25,   // 31 8D
      17,   // 32 9B
      8,    // 33 9C
      26,   // 34 9D
      27,   // 35 EW → dong
      32,   // 36 GD → fa
      30,   // 37 NW → bei
      31,   // 38 RD → zhong
      28,   // 39 SW → nan
      33,   // 40 WD → bai
      29,   // 41 WW → xi
    ];
  }

  /**
   * 是否已经就绪
   * @returns {boolean}
   */
  get isLoaded() {
    return this.status === ModelStatus.READY;
  }

  /**
   * 加载 ONNX 模型（默认从 modelPath 拉取）
   * @returns {Promise<boolean>} 是否成功
   */
  async loadModel() {
    if (typeof ort === 'undefined') {
      this.status = ModelStatus.ORT_MISSING;
      this.lastError = 'ONNX Runtime Web 未加载（检查网络/CDN 或本地部署）';
      console.warn(this.lastError);
      return false;
    }

    this.status = ModelStatus.LOADING;
    try {
      // 先探测文件是否存在，便于给出更明确的报错
      const resp = await fetch(this.modelPath, { method: 'HEAD' });
      if (!resp.ok) {
        this.status = ModelStatus.MISSING;
        this.lastError = `未找到模型文件：${this.modelPath}（请训练后放入该路径）`;
        console.info(this.lastError);
        return false;
      }

      console.log('[recognizer] 开始下载并初始化 ONNX 会话...');
      // 只用 WASM: WebGPU 在部分浏览器/环境下会静默挂起，兼容性优先
      const sessionPromise = ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      // 60 秒超时保护，防止无限挂起
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('模型初始化超时 (>60s)')), 60000)
      );
      this.session = await Promise.race([sessionPromise, timeoutPromise]);
      this.status = ModelStatus.READY;
      console.log('✅ 模型加载成功');
      return true;
    } catch (err) {
      this.status = ModelStatus.ERROR;
      this.lastError = err.message || String(err);
      console.warn('模型加载失败:', err);
      return false;
    }
  }

  /**
   * 检测图像中的麻将牌
   * @param {ImageData} imageData - 输入图像
   * @returns {Promise<{success: boolean, tiles?: Array, message?: string, status?: string}>}
   */
  async detect(imageData) {
    if (!this.isLoaded) {
      return {
        success: false,
        status: this.status,
        message: this.humanReadableStatus(),
      };
    }

    try {
      const input = this.preprocess(imageData);
      const inputName = this.session.inputNames[0] || 'images';
      const feeds = { [inputName]: input };
      const results = await this.session.run(feeds);
      const detections = this.postprocess(results, imageData.width, imageData.height);
      return { success: true, tiles: detections };
    } catch (err) {
      console.error('推理失败:', err);
      return { success: false, status: 'inference_error', message: `推理出错: ${err.message}` };
    }
  }

  /**
   * 给出人类可读的当前状态描述（用于 UI 提示）
   * @returns {string}
   */
  humanReadableStatus() {
    switch (this.status) {
      case ModelStatus.ORT_MISSING:
        return 'ONNX Runtime Web 未能加载：请检查网络（脚本从 jsdelivr CDN 引入），或改用离线部署。';
      case ModelStatus.MISSING:
        return '尚未提供模型文件。请将训练好的 .onnx 文件放入 assets/model/mahjong_yolov8n.onnx。';
      case ModelStatus.ERROR:
        return `模型加载失败：${this.lastError}`;
      case ModelStatus.LOADING:
        return '模型正在加载，请稍候...';
      case ModelStatus.UNLOADED:
        return '模型未加载';
      case ModelStatus.READY:
        return '模型就绪';
      default:
        return '未知状态';
    }
  }

  /**
   * 预处理：将 ImageData 转换为模型输入张量
   * - 等比缩放并 letter-box 填充到 inputSize × inputSize
   * - RGBA → RGB，归一化到 [0, 1]
   * - HWC → CHW
   *
   * @param {ImageData} imageData
   * @returns {any} ort.Tensor
   */
  preprocess(imageData) {
    const { width: srcW, height: srcH } = imageData;
    const targetSize = this.inputSize;

    const scale = Math.min(targetSize / srcW, targetSize / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.round((targetSize - newW) / 2);
    const padY = Math.round((targetSize - newH) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, targetSize, targetSize);

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = srcW;
    tmpCanvas.height = srcH;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(imageData, 0, 0);

    ctx.drawImage(tmpCanvas, 0, 0, srcW, srcH, padX, padY, newW, newH);

    const pixelData = ctx.getImageData(0, 0, targetSize, targetSize).data;

    const float32Data = new Float32Array(3 * targetSize * targetSize);
    const channelSize = targetSize * targetSize;

    for (let i = 0; i < channelSize; i++) {
      const srcIdx = i * 4;
      float32Data[i] = pixelData[srcIdx] / 255.0;
      float32Data[i + channelSize] = pixelData[srcIdx + 1] / 255.0;
      float32Data[i + 2 * channelSize] = pixelData[srcIdx + 2] / 255.0;
    }

    this._lastScale = scale;
    this._lastPadX = padX;
    this._lastPadY = padY;

    return new ort.Tensor('float32', float32Data, [1, 3, targetSize, targetSize]);
  }

  /**
   * 后处理：解析 YOLO 输出，应用 NMS
   *
   * YOLOv8 输出格式: [1, 4 + numClasses, numAnchors]
   * 前 4 行: cx, cy, w, h
   * 后 numClasses 行: 各类别置信度
   *
   * @param {object} results - ONNX 推理结果
   * @param {number} origW - 原始图像宽度
   * @param {number} origH - 原始图像高度
   * @returns {Array<{tileIndex: number, confidence: number, bbox: {x: number, y: number, w: number, h: number}}>}
   */
  postprocess(results, origW, origH) {
    const outputName = this.session.outputNames[0];
    const output = results[outputName];
    const outputData = output.data;
    const dims = output.dims;

    // 从模型输出反推实际类别数(可能是 34 或 42)
    const numModelClasses = dims[1] - 4;
    const numAnchors = dims[2];

    // 42 类模型 → 应用 Roboflow 映射;34 类模型 → 直接使用
    const remap = numModelClasses === 42 ? this.roboflow42to34 : null;

    const scale = this._lastScale || 1;
    const padX = this._lastPadX || 0;
    const padY = this._lastPadY || 0;

    const boxes = [];
    const scores = [];
    const classIds = [];

    for (let a = 0; a < numAnchors; a++) {
      const cx = outputData[0 * numAnchors + a];
      const cy = outputData[1 * numAnchors + a];
      const bw = outputData[2 * numAnchors + a];
      const bh = outputData[3 * numAnchors + a];

      let maxScore = -Infinity;
      let maxModelId = -1;
      for (let c = 0; c < numModelClasses; c++) {
        const score = outputData[(4 + c) * numAnchors + a];
        if (score > maxScore) {
          maxScore = score;
          maxModelId = c;
        }
      }

      if (maxScore < this.confThreshold) continue;

      // 映射到项目 34 类;若为花/季牌等未支持类 → 丢弃该检测
      const projectId = remap ? remap[maxModelId] : maxModelId;
      if (projectId == null) continue;

      const x = (cx - bw / 2 - padX) / scale;
      const y = (cy - bh / 2 - padY) / scale;
      const w = bw / scale;
      const h = bh / scale;

      boxes.push({ x, y, w, h });
      scores.push(maxScore);
      classIds.push(projectId);
    }

    const keepIndices = this.nms(boxes, scores, this.iouThreshold);

    const detections = keepIndices.map((idx) => ({
      tileIndex: classIds[idx],
      confidence: scores[idx],
      className: this.classNames[classIds[idx]],
      bbox: boxes[idx],
    }));

    // 按 x 排序：更贴近"人眼从左到右阅读牌墙"的习惯
    detections.sort((a, b) => a.bbox.x - b.bbox.x);

    return detections;
  }

  /**
   * Non-Maximum Suppression (NMS)
   *
   * 按置信度从高到低排序，保留最高分框，抑制与其 IoU 超阈值的所有低分框。
   */
  nms(boxes, scores, iouThreshold = 0.5) {
    if (boxes.length === 0) return [];

    const order = Array.from({ length: boxes.length }, (_, i) => i);
    order.sort((a, b) => scores[b] - scores[a]);

    const keep = [];
    const suppressed = new Uint8Array(boxes.length);

    for (let p = 0; p < order.length; p++) {
      const i = order[p];
      if (suppressed[i]) continue;
      keep.push(i);

      for (let q = p + 1; q < order.length; q++) {
        const j = order[q];
        if (suppressed[j]) continue;
        if (this.computeIoU(boxes[i], boxes[j]) > iouThreshold) {
          suppressed[j] = 1;
        }
      }
    }

    return keep;
  }

  /**
   * 计算两个矩形的 IoU
   */
  computeIoU(a, b) {
    const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.w, ay2 = a.y + a.h;
    const bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h;

    const interX1 = Math.max(ax1, bx1);
    const interY1 = Math.max(ay1, by1);
    const interX2 = Math.min(ax2, bx2);
    const interY2 = Math.min(ay2, by2);

    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const interArea = interW * interH;

    const aArea = a.w * a.h;
    const bArea = b.w * b.h;
    const unionArea = aArea + bArea - interArea;

    return unionArea > 0 ? interArea / unionArea : 0;
  }
}

/**
 * 无模型时的演示识别：从预设手牌样例中随机生成检测结果。
 * 提供合成的 bbox 坐标以便预览画布能标注。
 *
 * @param {number} imgW
 * @param {number} imgH
 * @returns {Array<{tileIndex: number, confidence: number, bbox: object, className: string}>}
 */
export function buildDemoDetections(imgW, imgH) {
  // 三组代表性示例，随机选一组
  const samples = [
    // 示例 A：一手接近听牌的手牌
    [0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 27, 31, 31],
    // 示例 B：七对子路径
    [0, 0, 5, 5, 12, 12, 20, 20, 27, 27, 32, 32, 33],
    // 示例 C：万字牌型
    [3, 4, 5, 6, 7, 8, 15, 16, 17, 24, 25, 26, 31],
  ];
  const chosen = samples[Math.floor(Math.random() * samples.length)];

  const classNames = [
    '1wan', '2wan', '3wan', '4wan', '5wan', '6wan', '7wan', '8wan', '9wan',
    '1tiao', '2tiao', '3tiao', '4tiao', '5tiao', '6tiao', '7tiao', '8tiao', '9tiao',
    '1tong', '2tong', '3tong', '4tong', '5tong', '6tong', '7tong', '8tong', '9tong',
    'dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai',
  ];

  const pad = Math.min(imgW, imgH) * 0.05;
  const rowY = imgH * 0.55;
  const tileW = (imgW - pad * 2) / chosen.length * 0.85;
  const tileH = tileW * 1.35;

  return chosen.map((tileIndex, i) => ({
    tileIndex,
    confidence: 0.75 + Math.random() * 0.2,
    className: classNames[tileIndex],
    bbox: {
      x: pad + i * ((imgW - pad * 2) / chosen.length),
      y: rowY - tileH / 2,
      w: tileW,
      h: tileH,
    },
  }));
}
