/**
 * app.js - 麻将听牌分析器 主应用控制器
 *
 * 串联所有模块:
 *   - tile-selector.js  手动选牌
 *   - camera.js         摄像头拍照
 *   - recognition.js    ONNX 推理管线
 *   - analyzer.js       出牌分析核心
 *   - mahjong-engine.js 底层算法
 */

import { TileSelector, createTileElement } from './tile-selector.js';
import { Camera } from './camera.js';
import { TileRecognizer } from './recognition.js';
import { analyzeHand } from './analyzer.js';
import { TILE_NAMES, WILD_TILE } from './mahjong-engine.js';

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);

const btnManual    = $('btn-manual');
const btnCamera    = $('btn-camera');
const selectorSec  = $('selector-section');
const cameraSec    = $('camera-section');
const handCount    = $('hand-count');
const btnClear     = $('btn-clear');
const btnAnalyze   = $('btn-analyze');
const resultSec    = $('result-section');
const resultTitle  = $('result-title');
const resultContent = $('result-content');
const btnCapture   = $('btn-capture');
const btnUpload    = $('btn-upload');
const fileInput    = $('file-input');
const recogStatus  = $('recognition-status');
const cameraVideo  = $('camera-video');
const cameraCanvas = $('camera-canvas');

// ============================================================
// 模块初始化
// ============================================================
const camera = new Camera();
const recognizer = new TileRecognizer();
let selector;

/**
 * 手牌变化回调 — 更新 UI 状态
 */
function onHandChange(tiles, wildCount, total) {
  // 更新计数徽章
  handCount.textContent = `${total}/14`;

  // 更新计数徽章样式
  if (total === 13 || total === 14) {
    handCount.classList.remove('warning', 'danger');
  } else if (total > 14) {
    handCount.classList.remove('warning');
    handCount.classList.add('danger');
  } else {
    handCount.classList.remove('danger');
    handCount.classList.add('warning');
  }

  // 按钮启用/禁用
  btnClear.disabled = total === 0;
  btnAnalyze.disabled = total !== 13 && total !== 14;

  // 手牌变化时隐藏旧的分析结果
  resultSec.classList.add('hidden');
}

// 创建选牌器
selector = new TileSelector(
  $('tile-selector'),
  $('hand-tiles'),
  onHandChange
);

// ============================================================
// 输入模式切换
// ============================================================
let currentMode = 'manual'; // 'manual' | 'camera'

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
  const ok = await camera.start(cameraVideo, cameraCanvas);
  if (!ok) {
    alert('无法启动摄像头。请检查浏览器权限设置，或使用手动选牌模式。');
    switchMode('manual');
  }
}

btnCapture.addEventListener('click', async () => {
  if (!camera.stream) return;
  const imageData = camera.capture();
  await processImage(imageData);
});

// 从相册选择
btnUpload.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const imageData = await camera.loadFromFile(file);
  await processImage(imageData);
  fileInput.value = ''; // 清空以便重复选同一文件
});

/**
 * 处理拍照/上传的图片 → 识别牌面
 */
async function processImage(imageData) {
  recogStatus.classList.remove('hidden');

  const result = await recognizer.detect(imageData);

  recogStatus.classList.add('hidden');

  if (!result.success) {
    // 模型未加载，提示用户
    alert(result.message || '识别失败。请使用手动选牌模式。');
    switchMode('manual');
    return;
  }

  if (result.tiles.length === 0) {
    alert('未识别到麻将牌。请调整拍摄角度或光线后重试。');
    return;
  }

  // 将识别结果设置为手牌
  const tiles = new Uint8Array(34);
  let wildCount = 0;

  for (const det of result.tiles) {
    if (det.tileIndex === WILD_TILE) {
      wildCount++;
    } else {
      tiles[det.tileIndex]++;
    }
  }

  selector.setHand(tiles, wildCount);
  switchMode('manual'); // 切换回手动模式让用户确认/修正
}

// 尝试加载模型（后台，不阻塞）
recognizer.loadModel().then((loaded) => {
  if (loaded) {
    console.log('✅ 麻将识别模型加载成功');
  } else {
    console.log('ℹ️ 识别模型未加载，使用手动选牌模式');
  }
});

// ============================================================
// 分析按钮
// ============================================================
btnAnalyze.addEventListener('click', () => {
  const { tiles, wildCount } = selector.getHand();
  const total = selector.getTotal();

  if (total !== 13 && total !== 14) return;

  // 运行分析
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

  // 滚动到结果区域
  resultSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * 已经胡牌
 */
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

/**
 * 13张牌的听牌结果
 */
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

  const tenpaiHTML = buildTenpaiSection(result.tenpaiTiles, result.totalCount);
  card.innerHTML = `
    <div class="tenpai-direct">
      <div class="tenpai-label">
        可胡的牌
        <span class="count">${result.totalCount} 张</span>
      </div>
    </div>
  `;

  // 添加听牌牌面
  const tilesContainer = document.createElement('div');
  tilesContainer.className = 'tenpai-tiles';
  result.tenpaiTiles.forEach((t) => {
    const wrapper = createTenpaiTileWithCount(t.tileIndex, t.count);
    tilesContainer.appendChild(wrapper);
  });
  card.querySelector('.tenpai-direct').appendChild(tilesContainer);

  resultContent.appendChild(card);
}

/**
 * 14张牌的出牌分析
 */
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

    // 打出的牌
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

    // 听牌列表
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

/**
 * 无效输入
 */
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

/**
 * 创建带剩余张数标注的听牌牌面
 */
function createTenpaiTileWithCount(tileIndex, count) {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-flex';

  const tile = createTileElement(tileIndex, 'sm');
  tile.style.cursor = 'default'; // 结果中的牌不可点击

  const badge = document.createElement('span');
  badge.className = 'tile-count-badge';
  badge.textContent = `×${count}`;

  wrapper.appendChild(tile);
  wrapper.appendChild(badge);
  return wrapper;
}
