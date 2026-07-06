/**
 * tile-selector.js - 手动选牌组件
 *
 * 提供牌面选择器和手牌展示功能。
 * 牌索引与引擎一致：
 *   0-8:  一万 ~ 九万
 *   9-17: 一条 ~ 九条
 *   18-26:一筒 ~ 九筒
 *   27:东  28:南  29:西  30:北
 *   31:中(百搭)  32:发  33:白
 */

const NUM_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONOR_CHARS = ['东', '南', '西', '北', '中', '发', '白'];
const SUIT_CHARS = ['万', '条', '筒'];
const SUIT_LABELS = ['万子', '条子', '筒子', '字牌'];

/**
 * 获取牌的花色 CSS 类名
 * @param {number} index - 牌索引 0-33
 * @returns {string} CSS 类名
 */
function getSuitClass(index) {
  if (index <= 8) return 'wan';
  if (index <= 17) return 'tiao';
  if (index <= 26) return 'tong';
  if (index <= 30) return 'feng';
  if (index === 31) return 'zhong';
  if (index === 32) return 'fa';
  return 'bai';
}

/**
 * 获取牌的显示文字
 * @param {number} index - 牌索引 0-33
 * @returns {{ num: string, suit: string|null }}
 */
function getTileChars(index) {
  if (index <= 26) {
    const suitIdx = Math.floor(index / 9);
    const numIdx = index % 9;
    return { num: NUM_CHARS[numIdx], suit: SUIT_CHARS[suitIdx] };
  }
  return { num: HONOR_CHARS[index - 27], suit: null };
}

/**
 * 创建麻将牌 DOM 元素
 * @param {number} tileIndex - 牌索引 0-33
 * @param {string} [size=''] - 尺寸类: 'sm', '', 'lg'
 * @returns {HTMLElement}
 */
export function createTileElement(tileIndex, size = '') {
  const el = document.createElement('div');
  const suitClass = getSuitClass(tileIndex);
  el.className = `mj-tile ${suitClass}`;
  if (size) el.classList.add(size);
  if (tileIndex === 31) el.classList.add('wild');

  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.dataset.tile = String(tileIndex);

  const { num, suit } = getTileChars(tileIndex);

  const numSpan = document.createElement('span');
  numSpan.className = 'tile-num';
  numSpan.textContent = num;
  el.appendChild(numSpan);

  if (suit) {
    const suitSpan = document.createElement('span');
    suitSpan.className = 'tile-suit';
    suitSpan.textContent = suit;
    el.appendChild(suitSpan);
  }

  // 红中百搭标记
  if (tileIndex === 31) {
    const badge = document.createElement('span');
    badge.className = 'wild-badge';
    badge.textContent = '百搭';
    el.appendChild(badge);
  }

  return el;
}

/**
 * 获取牌的可访问文字描述
 * @param {number} index
 * @returns {string}
 */
function getTileLabel(index) {
  const { num, suit } = getTileChars(index);
  const base = suit ? `${num}${suit}` : num;
  return index === 31 ? `${base}（百搭）` : base;
}

/**
 * TileSelector - 手动选牌组件
 */
export class TileSelector {
  /**
   * @param {HTMLElement} selectorContainer - #tile-selector
   * @param {HTMLElement} handContainer - #hand-tiles
   * @param {Function} onChange - callback(tiles: Uint8Array, wildCount: number, total: number)
   */
  constructor(selectorContainer, handContainer, onChange) {
    this.selectorContainer = selectorContainer;
    this.handContainer = handContainer;
    this.onChange = onChange;

    /** 每种牌的数量（索引31用 wildCount 单独记录） */
    this.tiles = new Uint8Array(34);
    /** 百搭（红中）的数量 */
    this.wildCount = 0;
    /** 手牌上限 */
    this.maxTiles = 14;

    /** @type {Map<number, HTMLElement>} 选择面板中每张牌的 DOM 引用 */
    this.selectorTiles = new Map();

    this.buildSelector();
    this.renderHand();
  }

  /**
   * 构建选牌面板
   */
  buildSelector() {
    this.selectorContainer.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'tile-grid';

    // 三种花色 + 字牌
    const sections = [
      { label: '万', start: 0, end: 8 },
      { label: '条', start: 9, end: 17 },
      { label: '筒', start: 18, end: 26 },
      { label: '字', start: 27, end: 33 },
    ];

    sections.forEach((section, sIdx) => {
      // 花色标签
      const label = document.createElement('div');
      label.className = 'suit-label';
      label.textContent = SUIT_LABELS[sIdx];
      grid.appendChild(label);

      // 每个花色的牌单独一行,永不换行(不足时缩小牌宽)
      const row = document.createElement('div');
      row.className = 'suit-row';
      if (section.label === '字') row.classList.add('honors');

      for (let i = section.start; i <= section.end; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tile-wrapper';

        const tile = createTileElement(i, 'sm');
        tile.setAttribute('aria-label', `添加 ${getTileLabel(i)}`);

        // 剩余数量标记
        const countBadge = document.createElement('span');
        countBadge.className = 'tile-count-badge';
        countBadge.textContent = '×4';
        wrapper.appendChild(tile);
        wrapper.appendChild(countBadge);

        // 点击事件
        const handler = () => this.addTile(i);
        tile.addEventListener('click', handler);
        tile.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handler();
          }
        });

        this.selectorTiles.set(i, { wrapper, tile, countBadge });
        row.appendChild(wrapper);
      }
      grid.appendChild(row);

      // 分割线（最后一组不需要）
      if (sIdx < sections.length - 1) {
        const divider = document.createElement('div');
        divider.className = 'suit-divider';
        grid.appendChild(divider);
      }
    });

    this.selectorContainer.appendChild(grid);
    this.updateSelectorCounts();
  }

  /**
   * 更新选牌面板上的剩余数量
   */
  updateSelectorCounts() {
    for (let i = 0; i < 34; i++) {
      const entry = this.selectorTiles.get(i);
      if (!entry) continue;

      const used = i === 31 ? this.wildCount : this.tiles[i];
      const remaining = 4 - used;

      entry.countBadge.textContent = `×${remaining}`;

      if (remaining <= 0) {
        entry.countBadge.classList.add('empty');
        entry.tile.classList.add('exhausted');
      } else {
        entry.countBadge.classList.remove('empty');
        entry.tile.classList.remove('exhausted');
      }
    }
  }

  /**
   * 向手牌中添加一张牌
   * @param {number} tileIndex - 牌索引 0-33
   */
  addTile(tileIndex) {
    const total = this.getTotal();
    if (total >= this.maxTiles) return;

    const used = tileIndex === 31 ? this.wildCount : this.tiles[tileIndex];
    if (used >= 4) return;

    if (tileIndex === 31) {
      this.wildCount++;
    } else {
      this.tiles[tileIndex]++;
    }

    this.updateSelectorCounts();
    this.renderHand();
    this.notifyChange();
  }

  /**
   * 从手牌中移除一张牌
   * @param {number} tileIndex - 牌索引 0-33
   */
  removeTile(tileIndex) {
    if (tileIndex === 31) {
      if (this.wildCount <= 0) return;
      this.wildCount--;
    } else {
      if (this.tiles[tileIndex] <= 0) return;
      this.tiles[tileIndex]--;
    }

    this.updateSelectorCounts();
    this.renderHand();
    this.notifyChange();
  }

  /**
   * 清空手牌
   */
  clear() {
    this.tiles.fill(0);
    this.wildCount = 0;
    this.updateSelectorCounts();
    this.renderHand();
    this.notifyChange();
  }

  /**
   * 获取当前手牌
   * @returns {{ tiles: Uint8Array, wildCount: number }}
   */
  getHand() {
    return {
      tiles: new Uint8Array(this.tiles),
      wildCount: this.wildCount,
    };
  }

  /**
   * 获取手牌总数
   * @returns {number}
   */
  getTotal() {
    let sum = this.wildCount;
    for (let i = 0; i < 34; i++) {
      sum += this.tiles[i];
    }
    return sum;
  }

  /**
   * 从外部设置手牌（例如拍照识别结果）
   * @param {Uint8Array} tiles - 34长度数组
   * @param {number} wildCount - 百搭数量
   */
  setHand(tiles, wildCount) {
    this.tiles = new Uint8Array(tiles);
    this.wildCount = wildCount;
    this.updateSelectorCounts();
    this.renderHand();
    this.notifyChange();
  }

  /**
   * 渲染手牌区域
   */
  renderHand() {
    this.handContainer.innerHTML = '';

    // 构建排序后的手牌列表
    const handList = this.buildSortedHandList();

    handList.forEach(({ tileIndex }, i) => {
      const tile = createTileElement(tileIndex);
      tile.classList.add('tile-enter');
      tile.style.animationDelay = `${i * 0.03}s`;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', `移除 ${getTileLabel(tileIndex)}`);

      // 点击移除
      tile.addEventListener('click', () => this.removeTile(tileIndex));
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.removeTile(tileIndex);
        }
      });

      this.handContainer.appendChild(tile);
    });
  }

  /**
   * 构建排序后的手牌列表（万→条→筒→字）
   * @returns {Array<{tileIndex: number}>}
   */
  buildSortedHandList() {
    const list = [];

    // 按牌索引排列: 0-8(万), 9-17(条), 18-26(筒), 27-33(字)
    for (let i = 0; i < 34; i++) {
      if (i === 31) {
        // 红中（百搭）放在字牌位置
        for (let c = 0; c < this.wildCount; c++) {
          list.push({ tileIndex: 31 });
        }
      } else {
        for (let c = 0; c < this.tiles[i]; c++) {
          list.push({ tileIndex: i });
        }
      }
    }

    return list;
  }

  /**
   * 触发回调
   */
  notifyChange() {
    if (this.onChange) {
      this.onChange(
        new Uint8Array(this.tiles),
        this.wildCount,
        this.getTotal()
      );
    }
  }
}
