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
import { TileRecognizer, ModelStatus, buildDemoDetections } from './recognition.js';
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
const btnCapture       = $('btn-capture');
const btnUpload        = $('btn-upload');
const fileInput        = $('file-input');
const recogStatus      = $('recognition-status');
const cameraVideo      = $('camera-video');
const cameraCanvas     = $('camera-canvas');
const btnLoadModel     = $('btn-load-model');
const modelFileInput   = $('model-file-input');
const btnDemo          = $('btn-demo');
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

  if (total === 13 || total === 14) {
    handCount.classList.remove('warning', 'danger');
  } else if (total > 14) {
    handCount.classList.remove('warning');
    handCount.classList.add('danger');
  } else {
    handCount.classList.remove('danger');
    handCount.classList.add('warning');
  }

  btnClear.disabled = total === 0;
  btnAnalyze.disabled = total !== 13 && total !== 14;

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
    camera.stop();
  }
}

// ============================================================
// 摄像头相关
// ============================================================
async function startCamera() {
  // 如果浏览器不支持摄像头，直接提示改用相册/演示
  if (!navigator.mediaDevices?.getUserMedia) {
    updateModelStatus('warn', '当前环境不支持摄像头。可通过"从相册选择"或"演示识别"使用。');
    return;
  }
  const ok = await camera.start(cameraVideo, cameraCanvas);
  if (!ok) {
    updateModelStatus('warn', '摄像头启动失败。可通过"从相册选择"或"演示识别"使用。');
  }
}

btnCapture.addEventListener('click', async () => {
  if (!camera.stream) {
    alert('摄像头尚未启动。请检查权限，或使用"从相册选择"。');
    return;
  }
  const imageData = camera.capture();
  await processImage(imageData);
});

// 从相册选择
btnUpload.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // 无摄像头时也要有 canvas 上下文可用
  if (!camera.canvas) {
    camera.canvas = cameraCanvas;
    camera.ctx = cameraCanvas.getContext('2d');
  }
  const imageData = await camera.loadFromFile(file);
  await processImage(imageData);
  fileInput.value = '';
});

// 加载本地 ONNX 模型
btnLoadModel.addEventListener('click', () => modelFileInput.click());
modelFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  updateModelStatus('loading', `正在加载 ${file.name}...`);
  const ok = await recognizer.loadModelFromFile(file);
  if (ok) {
    updateModelStatus('ok', `模型就绪：${file.name}`);
  } else {
    updateModelStatus('error', recognizer.humanReadableStatus());
  }
  modelFileInput.value = '';
});

// 演示识别
btnDemo.addEventListener('click', async () => {
  // 优先用摄像头当前帧，其次用一张灰色画布代替
  let imageData = camera.stream ? camera.capture() : null;
  if (!imageData) {
    const w = 640, h = 360;
    cameraCanvas.width = w;
    cameraCanvas.height = h;
    const ctx = cameraCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0f2d1a');
    grad.addColorStop(1, '#0a1a10');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(245, 240, 228, 0.9)';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('演示识别（未使用真实模型）', w / 2, h / 2);
    imageData = ctx.getImageData(0, 0, w, h);
    camera.canvas = cameraCanvas;
    camera.ctx = ctx;
  }
  const detections = buildDemoDetections(imageData.width, imageData.height);
  showDetectionPreview(imageData, detections);
});

/**
 * 处理拍照/上传的图片 → 识别牌面
 */
async function processImage(imageData) {
  if (!imageData) return;

  if (!recognizer.isLoaded) {
    // 尝试重新加载（如用户刚上传模型）
    const message = recognizer.humanReadableStatus();
    const useDemo = confirm(`${message}\n\n是否用【演示识别】走通流程？`);
    if (useDemo) {
      const dets = buildDemoDetections(imageData.width, imageData.height);
      showDetectionPreview(imageData, dets);
    }
    return;
  }

  recogStatus.classList.remove('hidden');
  const result = await recognizer.detect(imageData);
  recogStatus.classList.add('hidden');

  if (!result.success) {
    alert(result.message || '识别失败。请使用手动选牌模式。');
    return;
  }
  if (result.tiles.length === 0) {
    alert('未识别到麻将牌。请调整拍摄角度或光线后重试。');
    return;
  }
  showDetectionPreview(imageData, result.tiles);
}

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
    updateModelStatus('warn', '未找到模型文件。可【加载 ONNX 模型】上传，或用【演示识别】走通流程。');
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
  if (total !== 13 && total !== 14) return;

  const result = analyzeHand(tiles, wildCount);
  renderResult(result);
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
    case 'invalid':
      renderInvalid(result);
      break;
  }

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
  if (result.totalCount === 0) {
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

  resultTitle.textContent = `听牌分析 · 共听 ${result.totalCount} 张`;

  const card = document.createElement('div');
  card.className = 'result-card best';

  card.innerHTML = `
    <div class="tenpai-direct">
      <div class="tenpai-label">
        可胡的牌
        <span class="count">${result.totalCount} 张</span>
      </div>
    </div>
  `;

  const tilesContainer = document.createElement('div');
  tilesContainer.className = 'tenpai-tiles';
  result.tenpaiTiles.forEach((t) => {
    const wrapper = createTenpaiTileWithCount(t.tileIndex, t.count);
    tilesContainer.appendChild(wrapper);
  });
  card.querySelector('.tenpai-direct').appendChild(tilesContainer);

  resultContent.appendChild(card);
}

function renderDiscard(result) {
  if (result.discards.length === 0) {
    resultTitle.textContent = '分析结果';
    resultContent.innerHTML = `
      <div class="result-status">
        <span class="status-icon">🤔</span>
        <div class="status-title">无法听牌</div>
        <div>打出任何一张牌都无法进入听牌状态</div>
      </div>
    `;
    return;
  }

  const best = result.discards[0];
  resultTitle.textContent = `出牌分析 · 最多听 ${best.totalCount} 张`;

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
    countBadge.textContent = `听 ${discard.totalCount} 张`;

    discardInfo.appendChild(discardLabel);
    discardInfo.appendChild(discardTile);
    discardInfo.appendChild(arrowSpan);
    discardInfo.appendChild(countBadge);

    const tenpaiInfo = document.createElement('div');
    tenpaiInfo.className = 'tenpai-info';

    const tenpaiLabel = document.createElement('div');
    tenpaiLabel.className = 'tenpai-label';
    tenpaiLabel.innerHTML = `可胡 <span class="count">${discard.tenpaiTiles.length} 种</span>`;

    const tenpaiTiles = document.createElement('div');
    tenpaiTiles.className = 'tenpai-tiles';

    discard.tenpaiTiles.forEach((t) => {
      const wrapper = createTenpaiTileWithCount(t.tileIndex, t.count);
      tenpaiTiles.appendChild(wrapper);
    });

    tenpaiInfo.appendChild(tenpaiLabel);
    tenpaiInfo.appendChild(tenpaiTiles);

    card.appendChild(discardInfo);
    card.appendChild(tenpaiInfo);
    resultContent.appendChild(card);
  });
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

function createTenpaiTileWithCount(tileIndex, count) {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-flex';

  const tile = createTileElement(tileIndex, 'sm');
  tile.style.cursor = 'default';

  const badge = document.createElement('span');
  badge.className = 'tile-count-badge';
  badge.textContent = `×${count}`;

  wrapper.appendChild(tile);
  wrapper.appendChild(badge);
  return wrapper;
}
