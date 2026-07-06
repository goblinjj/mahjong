/**
 * camera.js - 摄像头捕获模块
 * 
 * 提供摄像头启动、拍照、文件加载功能
 */

export class Camera {
  constructor() {
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
  }

  /**
   * 启动摄像头
   * @param {HTMLVideoElement} videoElement - 视频预览元素
   * @param {HTMLCanvasElement} canvasElement - 画布元素（用于截图）
   * @returns {Promise<boolean>} 是否成功
   */
  async start(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment', // 后置摄像头
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      return true;
    } catch (err) {
      console.error('摄像头启动失败:', err);
      return false;
    }
  }

  /**
   * 停止摄像头
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  /**
   * 从当前视频帧捕获图像
   * @returns {ImageData|null} 图像数据
   */
  capture() {
    if (!this.video || !this.ctx) return null;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w === 0 || h === 0) return null;

    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /**
   * 从文件加载图像
   * @param {File} file - 图片文件
   * @returns {Promise<ImageData>} 图像数据
   */
  async loadFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        // 限制最大尺寸，避免过大图像
        const maxDim = 1920;
        let w = img.width;
        let h = img.height;

        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        this.canvas.width = w;
        this.canvas.height = h;
        this.ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(this.ctx.getImageData(0, 0, w, h));
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片加载失败'));
      };

      img.src = url;
    });
  }

  /**
   * 摄像头是否正在运行
   * @returns {boolean}
   */
  get isActive() {
    return this.stream !== null && this.stream.active;
  }
}
