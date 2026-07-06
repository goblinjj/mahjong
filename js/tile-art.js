/**
 * tile-art.js — 用 SVG 绘制条子/筒子牌面
 *
 * 导出 pipFaceSVG(kind, n)，返回一段 <svg> 字符串。
 * 万子和字牌仍由 tile-selector.js 用文字渲染。
 */

// 牌面画布（与牌的 3:4 比例接近）
const VB_W = 88;
const VB_H = 120;
const PAD_X = 13;
const PAD_Y = 13;
const AREA_L = PAD_X;
const AREA_R = VB_W - PAD_X;
const AREA_T = PAD_Y;
const AREA_B = VB_H - PAD_Y;
const AREA_W = AREA_R - AREA_L;
const AREA_H = AREA_B - AREA_T;

// 点数队形（每个元素是一"行"的个数）
const TONG_ROWS = {
  1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [2, 2], 5: [2, 1, 2],
  6: [2, 2, 2], 7: [3, 2, 2], 8: [2, 2, 2, 2], 9: [3, 3, 3],
};
const TIAO_ROWS = {
  2: [2], 3: [1, 2], 4: [2, 2], 5: [2, 1, 2],
  6: [3, 3], 7: [1, 3, 3], 8: [2, 2, 2, 2], 9: [3, 3, 3],
};

// 条子红色竹节：5条中间行、7条顶行
function isRedRow(n, rowIdx) {
  return (n === 5 && rowIdx === 1) || (n === 7 && rowIdx === 0);
}

/** 计算网格中每个牌点的中心坐标 */
function gridPositions(rows) {
  const R = rows.length;
  const maxC = Math.max(...rows);
  const pos = [];
  for (let r = 0; r < R; r++) {
    const cy = AREA_T + (r + 0.5) * AREA_H / R;
    const c = rows[r];
    for (let i = 0; i < c; i++) {
      const cx = AREA_L + (i + 0.5) * AREA_W / c;
      pos.push({ cx, cy, rowIdx: r, rowCount: c, rows: R, maxC });
    }
  }
  return pos;
}

const n2 = (x) => Math.round(x * 100) / 100;

// 铜钱配色（用于六筒/九筒的分排配色）
const COIN_THEMES = {
  blue: { outer: '#2e7fc0', edge: '#0f4c86', inner: '#1f6aad', innerEdge: '#0f4c86' },
  green: { outer: '#2ba85a', edge: '#12662f', inner: '#1c8f42', innerEdge: '#0f5a2b' },
  red: { outer: '#d5495a', edge: '#8a1020', inner: '#c2263a', innerEdge: '#7a0c1c' },
};

/** 六筒/九筒按排配色：上绿、中红、下蓝；其余牌统一蓝色 */
function tongTheme(n, rowIdx) {
  if (n === 6 || n === 9) return ['green', 'red', 'blue'][rowIdx] || 'blue';
  return 'blue';
}

/** 一枚铜钱（同心圆环） */
function coin(cx, cy, r, opts = {}) {
  const { theme = 'blue', ornate = false } = opts;
  const t = COIN_THEMES[theme];
  const inner = ornate ? '#c41e3a' : t.inner;
  const innerEdge = ornate ? '#8a0f22' : t.innerEdge;
  let s = `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}" fill="${t.outer}" stroke="${t.edge}" stroke-width="${n2(r * 0.12)}"/>`;
  s += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * 0.74)}" fill="#eef5fb"/>`;
  if (ornate) {
    s += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * 0.58)}" fill="${t.outer}"/>`;
    s += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * 0.4)}" fill="#eef5fb"/>`;
  }
  s += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * (ornate ? 0.26 : 0.5))}" fill="${inner}"/>`;
  s += `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * (ornate ? 0.26 : 0.5))}" fill="none" stroke="${innerEdge}" stroke-width="${n2(r * 0.08)}"/>`;
  // 高光
  s += `<circle cx="${n2(cx - r * 0.3)}" cy="${n2(cy - r * 0.33)}" r="${n2(r * 0.15)}" fill="#ffffff" opacity="0.55"/>`;
  return s;
}

/** 七筒：顶部 3 枚从左下至右上斜排，下方 2×2 */
function sevenTong() {
  const r = 11.5;
  const topH = AREA_H * 0.42;
  const yHi = AREA_T + r + 1;          // 右上
  const yLo = AREA_T + topH - r + 1;   // 左下
  const xL = AREA_L + AREA_W * 0.22;
  const xC = VB_W / 2;
  const xR = AREA_R - AREA_W * 0.22;
  let s = '';
  s += coin(xL, yLo, r);
  s += coin(xC, (yHi + yLo) / 2, r);
  s += coin(xR, yHi, r);
  const bandT = AREA_T + topH;
  const bandH = AREA_B - bandT;
  const yb0 = bandT + bandH * 0.28;
  const yb1 = bandT + bandH * 0.72;
  const xb0 = AREA_L + AREA_W * 0.28;
  const xb1 = AREA_R - AREA_W * 0.28;
  [[xb0, yb0], [xb1, yb0], [xb0, yb1], [xb1, yb1]].forEach(([x, y]) => { s += coin(x, y, r); });
  return s;
}

/** 一根竹节 */
function cane(cx, cy, w, h, red = false) {
  const col = red
    ? { body: '#d42a40', edge: '#8a0f22', node: '#7a0c1c' }
    : { body: '#20a24b', edge: '#0c5a24', node: '#0a4a1e' };
  const x = cx - w / 2;
  const y = cy - h / 2;
  const rx = w * 0.45;
  let s = `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(rx)}" fill="${col.body}" stroke="${col.edge}" stroke-width="1"/>`;
  // 竖向高光
  s += `<rect x="${n2(x + w * 0.2)}" y="${n2(y + h * 0.08)}" width="${n2(w * 0.2)}" height="${n2(h * 0.84)}" rx="${n2(w * 0.1)}" fill="#ffffff" opacity="0.3"/>`;
  // 竹节环
  const nodeH = Math.max(h * 0.055, 1.4);
  s += `<rect x="${n2(x)}" y="${n2(cy - nodeH / 2)}" width="${n2(w)}" height="${n2(nodeH)}" fill="${col.node}" opacity="0.55"/>`;
  s += `<rect x="${n2(x)}" y="${n2(y + h * 0.28 - nodeH / 2)}" width="${n2(w)}" height="${n2(nodeH)}" fill="${col.node}" opacity="0.45"/>`;
  return s;
}

/** 一条：孔雀/鸟造型 */
function bird() {
  return `
    <!-- 栖木 -->
    <rect x="28" y="96" width="32" height="5" rx="2.5" fill="#12702f"/>
    <!-- 尾羽 -->
    <path d="M50 82 Q74 78 80 54 Q70 74 54 76 Z" fill="#1c8f42"/>
    <path d="M50 84 Q70 84 78 66 Q66 82 52 80 Z" fill="#25a651" opacity="0.9"/>
    <!-- 身体 -->
    <ellipse cx="42" cy="70" rx="14" ry="18" fill="#28a558"/>
    <!-- 翅膀 -->
    <path d="M42 56 Q56 62 50 84 Q42 78 36 64 Z" fill="#1b8040"/>
    <!-- 头 -->
    <circle cx="42" cy="44" r="10.5" fill="#2ab060"/>
    <!-- 冠羽 -->
    <path d="M42 34 q5 -9 -1 -13 q3 8 -4 11 Z" fill="#c41e3a"/>
    <path d="M46 34 q7 -6 3 -13 q0 8 -6 11 Z" fill="#e8863a"/>
    <!-- 喙 -->
    <path d="M32 45 L21 48 L32 51 Z" fill="#e8863a"/>
    <!-- 眼 -->
    <circle cx="39" cy="43" r="2.1" fill="#14140f"/>
    <circle cx="38.4" cy="42.4" r="0.7" fill="#fff"/>
  `;
}

/** 白板：四周两圈蓝色边框，中间留白 */
export function baiFaceSVG() {
  const blue = '#1f5c9c';
  return `<svg class="tile-svg" viewBox="0 0 ${VB_W} ${VB_H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + `<rect x="16" y="22" width="56" height="76" rx="7" fill="none" stroke="${blue}" stroke-width="3"/>`
    + `<rect x="23" y="29" width="42" height="62" rx="4.5" fill="none" stroke="${blue}" stroke-width="1.6"/>`
    + `</svg>`;
}

/**
 * 生成条子/筒子的 SVG 牌面
 * @param {'tiao'|'tong'} kind
 * @param {number} n 1-9
 * @returns {string}
 */
export function pipFaceSVG(kind, n) {
  let body = '';

  if (kind === 'tiao' && n === 1) {
    body = bird();
  } else if (kind === 'tong') {
    const rows = TONG_ROWS[n];
    if (n === 1) {
      body = coin(VB_W / 2, VB_H / 2, 26, { ornate: true });
    } else if (n === 3) {
      // 斜排三筒
      const r = 13;
      body += coin(AREA_L + AREA_W * 0.26, AREA_T + AREA_H * 0.22, r);
      body += coin(VB_W / 2, VB_H / 2, r);
      body += coin(AREA_R - AREA_W * 0.26, AREA_B - AREA_H * 0.22, r);
    } else if (n === 7) {
      body = sevenTong();
    } else {
      const pos = gridPositions(rows);
      const r = Math.min(AREA_W / pos[0].maxC, AREA_H / pos[0].rows) / 2 * 0.82;
      pos.forEach((p) => { body += coin(p.cx, p.cy, r, { theme: tongTheme(n, p.rowIdx) }); });
    }
  } else {
    // 条子 2-9
    const rows = TIAO_ROWS[n];
    const pos = gridPositions(rows);
    const w = Math.min(AREA_W / pos[0].maxC * 0.5, 14);
    const h = Math.min(AREA_H / pos[0].rows * 0.84, 30);
    pos.forEach((p) => { body += cane(p.cx, p.cy, w, h, isRedRow(n, p.rowIdx)); });
  }

  return `<svg class="tile-svg" viewBox="0 0 ${VB_W} ${VB_H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>`;
}
