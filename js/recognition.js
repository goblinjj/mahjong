/**
 * recognition.js - ONNX Runtime Web 推理管线
 *
 * YOLOv8 麻将牌检测模型的预处理、推理、后处理管线。
 * 当模型文件不可用时，会优雅降级并提示用户。
 */

export class TileRecognizer {
  constructor() {
    /** @type {any} ONNX 推理会话 */
    this.session = null;
    /** @type {boolean} 模型是否已加载 */
    this.isLoaded = false;
    /** @type {string} 模型文件路径 */
    this.modelPath = '/assets/model/mahjong_yolov8n.onnx';

    /** 检测置信度阈值 */
    this.confThreshold = 0.45;
    /** NMS IoU 阈值 */
    this.iouThreshold = 0.5;
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
  }

  /**
   * 加载 ONNX 模型
   * @returns {Promise<boolean>} 是否成功
   */
  async loadModel() {
    try {
      // 检查 onnxruntime-web 是否可用
      if (typeof ort === 'undefined') {
        console.warn('ONNX Runtime Web 未加载');
        return false;
      }

      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['webgpu', 'wasm'],
      });

      this.isLoaded = true;
      console.log('模型加载成功');
      return true;
    } catch (err) {
      console.warn('模型加载失败 (这是正常的，如果你还没有训练模型):', err.message);
      return false;
    }
  }

  /**
   * 检测图像中的麻将牌
   * @param {ImageData} imageData - 输入图像
   * @returns {Promise<{success: boolean, tiles?: Array, message?: string}>}
   */
  async detect(imageData) {
    if (!this.isLoaded) {
      return {
        success: false,
        message: '模型未加载。请使用手动选牌模式，或将训练好的 ONNX 模型放入 assets/model/ 目录。',
      };
    }

    try {
      // 预处理
      const input = this.preprocess(imageData);

      // 推理
      const inputName = this.session.inputNames[0] || 'images';
      const feeds = { [inputName]: input };
      const results = await this.session.run(feeds);

      // 后处理
      const detections = this.postprocess(results, imageData.width, imageData.height);

      return { success: true, tiles: detections };
    } catch (err) {
      console.error('推理失败:', err);
      return { success: false, message: `推理出错: ${err.message}` };
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
    const { width: srcW, height: srcH, data: srcData } = imageData;
    const targetSize = this.inputSize;

    // 计算等比缩放比例（letter-box）
    const scale = Math.min(targetSize / srcW, targetSize / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = Math.round((targetSize - newW) / 2);
    const padY = Math.round((targetSize - newH) / 2);

    // 使用离屏 canvas 进行缩放
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');

    // 灰色填充背景 (114/255 ≈ YOLOv8 default pad)
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, targetSize, targetSize);

    // 绘制缩放后的图像
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = srcW;
    tmpCanvas.height = srcH;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(imageData, 0, 0);

    ctx.drawImage(tmpCanvas, 0, 0, srcW, srcH, padX, padY, newW, newH);

    // 读取像素数据
    const pixelData = ctx.getImageData(0, 0, targetSize, targetSize).data;

    // RGBA → CHW RGB float32, 归一化到 [0, 1]
    const float32Data = new Float32Array(3 * targetSize * targetSize);
    const channelSize = targetSize * targetSize;

    for (let i = 0; i < channelSize; i++) {
      const srcIdx = i * 4; // RGBA
      float32Data[i] = pixelData[srcIdx] / 255.0;                       // R
      float32Data[i + channelSize] = pixelData[srcIdx + 1] / 255.0;     // G
      float32Data[i + 2 * channelSize] = pixelData[srcIdx + 2] / 255.0; // B
    }

    // 保存缩放信息，后处理时用于还原坐标
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
    // 获取输出张量
    const outputName = this.session.outputNames[0];
    const output = results[outputName];
    const outputData = output.data;
    const dims = output.dims; // [1, 4+numClasses, numAnchors]

    const numClasses = this.classNames.length; // 34
    const numAnchors = dims[2];
    const stride = dims[1]; // 4 + numClasses = 38

    const scale = this._lastScale || 1;
    const padX = this._lastPadX || 0;
    const padY = this._lastPadY || 0;

    const boxes = [];
    const scores = [];
    const classIds = [];

    for (let a = 0; a < numAnchors; a++) {
      // 提取 bbox (cx, cy, w, h)
      const cx = outputData[0 * numAnchors + a];
      const cy = outputData[1 * numAnchors + a];
      const bw = outputData[2 * numAnchors + a];
      const bh = outputData[3 * numAnchors + a];

      // 找最大类别置信度
      let maxScore = -Infinity;
      let maxClassId = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = outputData[(4 + c) * numAnchors + a];
        if (score > maxScore) {
          maxScore = score;
          maxClassId = c;
        }
      }

      if (maxScore < this.confThreshold) continue;

      // 将坐标从 letter-boxed 空间还原到原图空间
      const x = (cx - bw / 2 - padX) / scale;
      const y = (cy - bh / 2 - padY) / scale;
      const w = bw / scale;
      const h = bh / scale;

      boxes.push({ x, y, w, h });
      scores.push(maxScore);
      classIds.push(maxClassId);
    }

    // NMS
    const keepIndices = this.nms(boxes, scores, this.iouThreshold);

    const detections = keepIndices.map((idx) => ({
      tileIndex: classIds[idx],
      confidence: scores[idx],
      className: this.classNames[classIds[idx]],
      bbox: boxes[idx],
    }));

    // 按置信度降序排列
    detections.sort((a, b) => b.confidence - a.confidence);

    return detections;
  }

  /**
   * Non-Maximum Suppression (NMS)
   * @param {Array<{x: number, y: number, w: number, h: number}>} boxes
   * @param {Array<number>} scores
   * @param {number} iouThreshold
   * @returns {Array<number>} 保留的索引
   */
  nms(boxes, scores, iouThreshold = 0.5) {
    if (boxes.length === 0) return [];

    // 按分数降序排列索引
    const indices = Array.from({ length: boxes.length }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);

    const keep = [];
    const suppressed = new Set();

    for (const i of indices) {
      if (suppressed.has(i)) continue;
      keep.push(i);

      for (const j of indices) {
        if (j <= i || suppressed.has(j)) continue;

        const iou = this.computeIoU(boxes[i], boxes[j]);
        if (iou > iouThreshold) {
          suppressed.add(j);
        }
      }
    }

    return keep;
  }

  /**
   * 计算两个矩形的 IoU
   * @param {{x: number, y: number, w: number, h: number}} a
   * @param {{x: number, y: number, w: number, h: number}} b
   * @returns {number} IoU 值 [0, 1]
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
