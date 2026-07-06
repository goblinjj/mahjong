/**
 * app.js - 麻将听牌分析器 主应用控制器
 *
 * 串联所有模块:
 *   - tile-selector.js  手动选牌
 *   - camera.js         摄像头拍照
 *   - recognition.js    ONNX 推理管线 + 演示识别回退
 *   - analyzer.js       出牌分析核心
 *   - mahjong-engine.js 底层算法
 */

import { TileSelector, createTileElement } from './tile-selector.js';
import { Camera } from './camera.js';
import { TileRecognizer, ModelStatus } from './recognition.js';
import { analyzeHand } from './analyzer.js';
import { TILE_NAMES, WILD_TILE } from './mahjong-engine.js';

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);

const btnManual        = $('btn-manual');
const btnCamera        = $('btn-camera');
const selectorSec      = $('selector-section');
const cameraSec        = $('camera-section');
const handCount        = $('hand-count');
const btnClear         = $('btn-clear');
const btnAnalyze       = $('btn-analyze');
const resultSec        = $('result-section');
const resultTitle      = $('result-title');
const resultContent    = $('result-content');
const cameraVideo      = $('camera-video');
const cameraCanvas     = $('camera-canvas');
const cameraOverlay    = $('camera-overlay');
const liveCountBadge   = $('live-count-badge');
const btnConfirm       = $('btn-confirm');
const modelStatusEl    = $('model-status');
const modelStatusIcon  = modelStatusEl.querySelector('.model-status-icon');
const modelStatusText  = modelStatusEl.querySelector('.model-status-text');
const detectionPreview = $('detection-preview');
const detectionCanvas  = $('detection-canvas');
const detectionCount   = $('detection-count');
const detectionList    = $('detection-list');
const btnDetectCancel  = $('btn-detection-cancel');
const btnDetectApply   = $('btn-detection-apply');

// ============================================================
// 模块初始化
// ============================================================
const camera = new Camera();
const recognizer = new TileRecognizer();
let selector;

/** 当前正在预览/编辑的识别结果 */
let pendingDetections = [];
/** 与 pendingDetections 对齐的原始图像 */
let pendingImageData = null;

/**
 * 手牌变化回调 — 更新 UI 状态
 */
function onHandChange(tiles, wildCount, total) {
  handCount.textContent = `${total}/14`;

  // 合法麻将进程状态: 3k+1(听牌) 或 3k+2(出牌)
  const analyzable = total > 0 && total <= 14 && total % 3 !== 0;

  if (total > 14) {
    handCount.classList.remove('warning');
    handCount.classList.add('danger');
  } else if (analyzable) {
    handCount.classList.remove('warning', 'danger');
  } else {
    handCount.classList.remove('danger');
    handCount.classList.add('warning');
  }

  btnClear.disabled = total === 0;
  btnAnalyze.disabled = !analyzable;

  resultSec.classList.add('hidden');
}

selector = new TileSelector(
  $('tile-selector'),
  $('hand-tiles'),
  onHandChange
);

// ============================================================
// 输入模式切换
// ============================================================
let currentMode = 'manual';

btnManual.addEventListener('click', () => switchMode('manual'));
btnCamera.addEventListener('click', () => switchMode('camera'));

function switchMode(mode) {
  currentMode = mode;

  btnManual.classList.toggle('active', mode === 'manual');
  btnCamera.classList.toggle('active', mode === 'camera');
  btnManual.setAttribute('aria-pressed', String(mode === 'manual'));
  btnCamera.setAttribute('aria-pressed', String(mode === 'camera'));

  selectorSec.classList.toggle('hidden', mode !== 'manual');
  cameraSec.classList.toggle('hidden', mode !== 'camera');

  if (mode === 'camera') {
    startCamera();
  } else {
    stopDetectionLoop();
    camera.stop();
  }
}

// ============================================================
// 摄像头 + 实时识别
// ============================================================
/** 最近一次识别到的检测结果 (显示在叠加层上) */
let liveDetections = [];
/** 最近一次成功推理时对应的原始帧,供"确认"时冻结使用 */
let liveImageData = null;
/** 检测循环运行标志 */
let detectionLoopActive = false;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    updateModelStatus('warn', '当前环境不支持摄像头。请改用手动选牌模式。');
    liveCountBadge.textContent = '摄像头不可用';
    return;
  }
  const ok = await camera.start(cameraVideo, cameraCanvas);
  if (!ok) {
    updateModelStatus('warn', '摄像头启动失败。请检查权限，或改用手动选牌模式。');
    liveCountBadge.textContent = '摄像头启动失败';
    return;
  }
  liveCountBadge.textContent = recognizer.isLoaded ? '实时识别中…' : '模型加载中…';
  startDetectionLoop();
}

function startDetectionLoop() {
  if (detectionLoopActive) return;
  detectionLoopActive = true;
  detectionTick();
}

function stopDetectionLoop() {
  detectionLoopActive = false;
  liveDetections = [];
  liveImageData = null;
  const ctx = cameraOverlay.getContext('2d');
  ctx.clearRect(0, 0, cameraOverlay.width, cameraOverlay.height);
  btnConfirm.disabled = true;
}

/** 引导虚线内条带占比,必须与 CSS #camera-container::after 的 inset 一致 */
const BAND_TOP_FRAC = 0.35;
const BAND_BOTTOM_FRAC = 0.35;

/**
 * 将完整帧裁剪到虚线内的横向条带,以便只对该区域做识别。
 * @param {ImageData} imageData
 * @returns {{ cropped: ImageData, yOffset: number }}
 */
function cropToGuideBand(imageData) {
  const yStart = Math.floor(imageData.height * BAND_TOP_FRAC);
  const yEnd = imageData.height - Math.floor(imageData.height * BAND_BOTTOM_FRAC);
  const bandH = yEnd - yStart;
  if (bandH <= 0) return { cropped: imageData, yOffset: 0 };

  const stride = imageData.width * 4;
  const bytes = imageData.data.slice(yStart * stride, yEnd * stride);
  const cropped = new ImageData(bytes, imageData.width, bandH);
  return { cropped, yOffset: yStart };
}

async function detectionTick() {
  if (!detectionLoopActive) return;

  // 未就绪时轻量轮询
  if (!recognizer.isLoaded || !camera.isActive || cameraVideo.videoWidth === 0) {
    setTimeout(detectionTick, 300);
    return;
  }

  ensureContainerAspect();

  const imageData = camera.capture();
  if (!imageData) {
    setTimeout(detectionTick, 200);
    return;
  }

  try {
    // 只对虚线条带做推理,过滤掉框外内容
    const { cropped, yOffset } = cropToGuideBand(imageData);
    const result = await recognizer.detect(cropped);
    if (!detectionLoopActive) return;

    if (result.success) {
      // 把条带内的 bbox 平移回全帧坐标系,叠加层和冻结预览才能对齐
      result.tiles.forEach((d) => { d.bbox.y += yOffset; });
      liveDetections = result.tiles;
      liveImageData = imageData;
      updateLiveBadge();
      drawOverlay();
    }
  } catch (err) {
    console.error('实时识别出错:', err);
  }

  // 让出主线程,避免掉帧和过热
  setTimeout(detectionTick, 80);
}

/** 视频尺寸改变(如设备旋转)时,同步容器 aspect-ratio,让叠加层坐标始终线性对齐 */
function ensureContainerAspect() {
  const container = cameraVideo.parentElement;
  if (!container || cameraVideo.videoWidth === 0) return;
  const desired = `${cameraVideo.videoWidth} / ${cameraVideo.videoHeight}`;
  if (container.style.aspectRatio !== desired) {
    container.style.aspectRatio = desired;
  }
}

cameraVideo.addEventListener('loadedmetadata', ensureContainerAspect);
cameraVideo.addEventListener('resize', () => {
  ensureContainerAspect();
  if (detectionLoopActive) drawOverlay();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    ensureContainerAspect();
    if (detectionLoopActive) drawOverlay();
  }, 200);
});

function updateLiveBadge() {
  const n = liveDetections.length;
  if (n === 0) {
    liveCountBadge.textContent = '未检测到牌';
    btnConfirm.disabled = true;
    btnConfirm.textContent = '✔ 确认识别结果';
  } else {
    liveCountBadge.textContent = `实时识别: ${n} 张`;
    btnConfirm.disabled = false;
    btnConfirm.textContent = `✔ 确认识别 (${n} 张)`;
  }
}

/**
 * 在 #camera-overlay 上绘制当前 liveDetections 的边框和标签。
 * 容器 aspect-ratio 已在 camera.start 中设为视频原生比例,故这里坐标只需线性缩放。
 */
function drawOverlay() {
  const video = cameraVideo;
  if (video.videoWidth === 0) return;

  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssW = rect.width;
  const cssH = rect.height;

  if (cameraOverlay.width !== Math.round(cssW * dpr) ||
      cameraOverlay.height !== Math.round(cssH * dpr)) {
    cameraOverlay.width = Math.round(cssW * dpr);
    cameraOverlay.height = Math.round(cssH * dpr);
    cameraOverlay.style.width = cssW + 'px';
    cameraOverlay.style.height = cssH + 'px';
  }

  const ctx = cameraOverlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const scaleX = cssW / video.videoWidth;
  const scaleY = cssH / video.videoHeight;

  ctx.lineWidth = 2;
  ctx.font = 'bold 11px sans-serif';
  ctx.textBaseline = 'bottom';

  liveDetections.forEach((det) => {
    const b = det.bbox;
    const x = b.x * scaleX;
    const y = b.y * scaleY;
    const w = b.w * scaleX;
    const h = b.h * scaleY;

    ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
    ctx.strokeRect(x, y, w, h);

    // 标签
    const label = TILE_NAMES[det.tileIndex] || '?';
    const labelW = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(x, Math.max(0, y - 14), labelW, 14);
    ctx.fillStyle = 'rgba(0, 212, 170, 1)';
    ctx.fillText(label, x + 4, Math.max(12, y - 2));
  });
}

// 屏幕尺寸变化时同步刷新叠加层
window.addEventListener('resize', () => {
  if (detectionLoopActive) drawOverlay();
});

// 确认按钮 → 冻结当前帧,进入编辑预览
btnConfirm.addEventListener('click', () => {
  if (liveDetections.length === 0 || !liveImageData) return;
  const frozenDets = liveDetections.slice();
  const frozenImg = liveImageData;
  stopDetectionLoop();
  camera.stop();
  showDetectionPreview(frozenImg, frozenDets);
});

// ============================================================
// 识别结果预览与修正
// ============================================================
/**
 * 显示识别结果预览
 * @param {ImageData} imageData
 * @param {Array} detections
 */
function showDetectionPreview(imageData, detections) {
  pendingImageData = imageData;
  pendingDetections = detections.slice();

  detectionPreview.classList.remove('hidden');
  renderDetectionPreview();
  detectionPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderDetectionPreview() {
  // 画布：绘制原图 + 检测框
  const ctx = detectionCanvas.getContext('2d');
  const w = pendingImageData.width;
  const h = pendingImageData.height;

  // 限制显示宽度，保留纵横比
  const maxCanvasW = 480;
  const dispScale = Math.min(1, maxCanvasW / w);
  detectionCanvas.width = Math.round(w * dispScale);
  detectionCanvas.height = Math.round(h * dispScale);

  // 绘制原图（先画到临时 canvas 再缩放）
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d').putImageData(pendingImageData, 0, 0);
  ctx.drawImage(tmp, 0, 0, detectionCanvas.width, detectionCanvas.height);

  // 绘制检测框
  ctx.lineWidth = 2;
  ctx.font = 'bold 12px sans-serif';
  pendingDetections.forEach((det, i) => {
    const b = det.bbox;
    const x = b.x * dispScale;
    const y = b.y * dispScale;
    const bw = b.w * dispScale;
    const bh = b.h * dispScale;
    ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
    ctx.strokeRect(x, y, bw, bh);
    const label = `${i + 1}·${(det.confidence * 100).toFixed(0)}%`;
    const labelW = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x, y - 14, labelW, 14);
    ctx.fillStyle = 'rgba(0, 212, 170, 1)';
    ctx.fillText(label, x + 4, y - 3);
  });

  // 数量徽章
  detectionCount.textContent = `${pendingDetections.length} 张`;

  // 结果列表：点击可删除该检测
  detectionList.innerHTML = '';
  pendingDetections.forEach((det, i) => {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-flex';

    const tile = createTileElement(det.tileIndex, 'sm');
    tile.setAttribute('aria-label', `删除识别结果第 ${i + 1} 张`);
    tile.style.cursor = 'pointer';

    const conf = document.createElement('span');
    conf.className = 'tile-count-badge';
    conf.textContent = `${(det.confidence * 100).toFixed(0)}%`;

    wrapper.appendChild(tile);
    wrapper.appendChild(conf);

    tile.addEventListener('click', () => {
      pendingDetections.splice(i, 1);
      renderDetectionPreview();
    });

    detectionList.appendChild(wrapper);
  });
}

btnDetectCancel.addEventListener('click', () => {
  detectionPreview.classList.add('hidden');
  pendingDetections = [];
  pendingImageData = null;
  // 取消后若仍处于拍照模式,重新启动摄像头继续实时识别
  if (currentMode === 'camera') {
    startCamera();
  }
});

btnDetectApply.addEventListener('click', () => {
  const tiles = new Uint8Array(34);
  let wildCount = 0;

  for (const det of pendingDetections) {
    if (det.tileIndex === WILD_TILE) {
      wildCount++;
    } else if (det.tileIndex >= 0 && det.tileIndex < 34) {
      // 每张牌最多 4 张
      if (tiles[det.tileIndex] < 4) tiles[det.tileIndex]++;
    }
  }
  // 百搭最多 4 张
  wildCount = Math.min(wildCount, 4);

  selector.setHand(tiles, wildCount);
  detectionPreview.classList.add('hidden');
  pendingDetections = [];
  pendingImageData = null;
  switchMode('manual');
});

// ============================================================
// 模型加载状态提示
// ============================================================
/**
 * @param {'loading'|'ok'|'warn'|'error'} kind
 * @param {string} text
 */
function updateModelStatus(kind, text) {
  modelStatusEl.classList.remove('ok', 'warn', 'error', 'loading');
  modelStatusEl.classList.add(kind);
  const iconMap = { loading: '⏳', ok: '✅', warn: '⚠️', error: '❌' };
  modelStatusIcon.textContent = iconMap[kind] || 'ℹ️';
  modelStatusText.textContent = text;
}

// 尝试加载模型（后台，不阻塞）
updateModelStatus('loading', '正在检测识别模型...');
recognizer.loadModel().then((loaded) => {
  if (loaded) {
    updateModelStatus('ok', '识别模型就绪。可以拍照识别。');
  } else if (recognizer.status === ModelStatus.MISSING) {
    updateModelStatus('warn', '未找到模型文件（assets/model/mahjong_yolov8n.onnx）。可用【演示识别】走通流程。');
  } else if (recognizer.status === ModelStatus.ORT_MISSING) {
    updateModelStatus('error', 'ONNX Runtime 未加载。请检查网络或改用离线部署。');
  } else {
    updateModelStatus('error', recognizer.humanReadableStatus());
  }
});

// ============================================================
// 分析按钮
// ============================================================
btnAnalyze.addEventListener('click', () => {
  const { tiles, wildCount } = selector.getHand();
  const total = selector.getTotal();
  if (total <= 0 || total > 14 || total % 3 === 0) return;

  // 二向听/far 情况下 analyzeHand 是 CPU 密集的同步计算 (最多约 5s)。
  // 先渲染 loading 状态并禁用按钮,让浏览器完成一帧渲染,再在下一帧启动计算。
  renderLoading();
  btnAnalyze.disabled = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const result = analyzeHand(tiles, wildCount);
        renderResult(result);
      } finally {
        btnAnalyze.disabled = false;
      }
    });
  });
});

// ============================================================
// 清空按钮
// ============================================================
btnClear.addEventListener('click', () => {
  selector.clear();
  resultSec.classList.add('hidden');
});

// ============================================================
// 渲染分析结果
// ============================================================
function renderResult(result) {
  resultContent.innerHTML = '';
  resultSec.classList.remove('hidden');

  switch (result.type) {
    case 'already_won':
      renderAlreadyWon();
      break;
    case 'tenpai':
      renderTenpai(result);
      break;
    case 'discard':
      renderDiscard(result);
      break;
    case 'far_from_tenpai':
      renderFarFromTenpai(result);
      break;
    case 'invalid':
      renderInvalid(result);
      break;
  }

  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLoading() {
  resultContent.innerHTML = '';
  resultSec.classList.remove('hidden');
  resultTitle.textContent = '正在分析…';
  resultContent.innerHTML = `
    <div class="result-status">
      <span class="status-icon">⏳</span>
      <div class="status-title">正在计算最佳出牌</div>
      <div>牌型距离听牌较远时可能需要几秒钟, 请稍候…</div>
    </div>
  `;
  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderAlreadyWon() {
  resultTitle.textContent = '分析结果';
  resultContent.innerHTML = `
    <div class="result-status">
      <span class="status-icon">🎉</span>
      <div class="status-title">已经胡牌了！</div>
      <div>这副牌已经是胡牌牌型，恭喜！</div>
    </div>
  `;
}

function renderTenpai(result) {
  if (result.tenpaiTiles.length === 0) {
    resultTitle.textContent = '分析结果';
    resultContent.innerHTML = `
      <div class="result-status">
        <span class="status-icon">😅</span>
        <div class="status-title">未听牌</div>
        <div>当前牌型还没有进入听牌状态</div>
      </div>
    `;
    return;
  }

  resultTitle.textContent = `听牌分析 · ${result.total} 张手牌 · 共 ${result.tenpaiTiles.length} 种`;

  const card = document.createElement('div');
  card.className = 'result-card best';

  card.innerHTML = `
    <div class="tenpai-direct">
      <div class="tenpai-label">
        可胡的牌
        <span class="count">${result.tenpaiTiles.length} 种</span>
      </div>
    </div>
  `;

  const tilesContainer = document.createElement('div');
  tilesContainer.className = 'tenpai-tiles';
  result.tenpaiTiles.forEach((tileIndex) => {
    tilesContainer.appendChild(createTileElement(tileIndex, 'sm'));
  });
  card.querySelector('.tenpai-direct').appendChild(tilesContainer);

  resultContent.appendChild(card);
}

/** 向听数对应的中文名称 */
const SHANTEN_LABEL = { 0: '听牌', 1: '一向听', 2: '二向听' };

function renderDiscard(result) {
  if (result.discards.length === 0) {
    // 理论上不会走到这里(analyzer 会返回 far_from_tenpai),保底处理
    renderFarFromTenpai(result);
    return;
  }

  const best = result.discards[0];
  const shantenLabel = SHANTEN_LABEL[result.shanten] ?? `${result.shanten} 向听`;

  // 标题:
  //   听牌路径 —— "最多听 X 种"
  //   一向听/二向听路径 —— "最多进张 X 种"
  const bestCountLabel = result.shanten === 0
    ? `最多听 ${best.ukeire.length} 种`
    : `最多进张 ${best.ukeire.length} 种`;
  resultTitle.textContent = `出牌分析 · ${result.total} 张手牌 · ${shantenLabel} · ${bestCountLabel}`;

  result.discards.forEach((discard, index) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    if (index === 0) card.classList.add('best');

    const discardInfo = document.createElement('div');
    discardInfo.className = 'discard-info';

    const discardLabel = document.createElement('span');
    discardLabel.className = 'discard-label';
    discardLabel.textContent = '打出';

    const discardTile = createTileElement(discard.tileIndex);

    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'discard-label';
    arrowSpan.textContent = '→';

    const countBadge = document.createElement('span');
    countBadge.className = 'badge';
    countBadge.textContent = result.shanten === 0
      ? `听 ${discard.ukeire.length} 种`
      : `${shantenLabel} · 进张 ${discard.ukeire.length} 种`;

    discardInfo.appendChild(discardLabel);
    discardInfo.appendChild(discardTile);
    discardInfo.appendChild(arrowSpan);
    discardInfo.appendChild(countBadge);

    const ukeireInfo = document.createElement('div');
    ukeireInfo.className = 'tenpai-info';

    const ukeireLabel = document.createElement('div');
    ukeireLabel.className = 'tenpai-label';
    const labelText = result.shanten === 0 ? '可胡' : '有效进张';
    ukeireLabel.innerHTML = `${labelText} <span class="count">${discard.ukeire.length} 种</span>`;

    const ukeireTiles = document.createElement('div');
    ukeireTiles.className = 'tenpai-tiles';

    discard.ukeire.forEach((tileIndex) => {
      ukeireTiles.appendChild(createTileElement(tileIndex, 'sm'));
    });

    ukeireInfo.appendChild(ukeireLabel);
    ukeireInfo.appendChild(ukeireTiles);

    card.appendChild(discardInfo);
    card.appendChild(ukeireInfo);
    resultContent.appendChild(card);
  });
}

function renderFarFromTenpai(result) {
  resultTitle.textContent = '分析结果';
  resultContent.innerHTML = `
    <div class="result-status">
      <span class="status-icon">🤔</span>
      <div class="status-title">距离听牌较远</div>
      <div>当前手牌超过二向听, 单张调整难以直接推进; 建议整理手牌形状后再分析。</div>
    </div>
  `;
}

function renderInvalid(result) {
  resultTitle.textContent = '分析结果';
  resultContent.innerHTML = `
    <div class="result-status">
      <span class="status-icon">⚠️</span>
      <div class="status-title">输入有误</div>
      <div>${result.message}</div>
    </div>
  `;
}

