/**
 * model-store.js — ONNX 模型的持久化存储层
 *
 * 【为什么不能只靠 HTTP 缓存】
 * _headers 已经给 /assets/model/*.onnx 设了 `max-age=31536000, immutable`,
 * 线上验证也确实生效。但 HTTP 磁盘缓存对浏览器来说是「可随时丢弃的临时区」,
 * 不是存储 —— 12MB 的单个资源是 LRU 驱逐的首要目标, iOS Safari 更会在大约
 * 7 天无访问后主动清理。所以用户「过几天再打开又要重下 12MB」。
 *
 * 本模块把模型改放进 Cache Storage(受本站存储配额管理), 并申请
 * navigator.storage.persist() —— 授权后浏览器承诺不再自动驱逐这份数据。
 * 这是「缓存」和「存储」的本质区别, 也是该问题的根源解法。
 *
 * 任何一步失败都会优雅降级回普通网络加载, 不会让识别功能不可用。
 */

/** Cache Storage 名称前缀。实际名称为 `${CACHE_PREFIX}v${version}`。 */
const CACHE_PREFIX = 'mahjong-model-';

/** Cache Storage 是否可用(隐私模式 / 非安全上下文下可能没有) */
function cacheStorageAvailable() {
  return typeof caches !== 'undefined' && typeof indexedDB !== 'undefined';
}

/**
 * 申请持久化存储权限。
 *
 * - Chrome/Edge: 依据站点参与度静默决定, 不弹窗
 * - Firefox: 可能弹窗询问
 * - Safari: 已「添加到主屏幕」的站点更容易获得
 *
 * @returns {Promise<boolean>} 是否已处于持久化状态
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * 查询当前存储用量(用于调试/展示)
 * @returns {Promise<{usage: number, quota: number, persisted: boolean}|null>}
 */
export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted
      ? await navigator.storage.persisted()
      : false;
    return { usage, quota, persisted };
  } catch {
    return null;
  }
}

/**
 * 删除所有非当前版本的模型缓存。
 * 换模型(递增 version)后旧的 12MB 不会白占配额。
 * @param {number|string} currentVersion
 */
async function purgeOtherVersions(currentVersion) {
  if (!cacheStorageAvailable()) return;
  const keep = `${CACHE_PREFIX}v${currentVersion}`;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== keep)
        .map((k) => caches.delete(k))
    );
  } catch (err) {
    console.warn('[model-store] 清理旧模型缓存失败:', err);
  }
}

/**
 * 带进度地把 Response 读成 Uint8Array
 * @param {Response} res
 * @param {(p: {received: number, total: number}) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || 0;

  // 老浏览器没有可读流 → 直接整体读取, 无进度
  if (!res.body?.getReader) {
    const buf = await res.arrayBuffer();
    onProgress?.({ received: buf.byteLength, total: buf.byteLength });
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total });
  }

  const bytes = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    bytes.set(c, pos);
    pos += c.length;
  }
  return bytes;
}

/**
 * 取得模型二进制 —— 优先从持久化存储读, 未命中才走网络并存下来。
 *
 * @param {string} url - 模型 URL(含 ?v= 版本号)
 * @param {number|string} version - 版本号, 决定 Cache Storage 名称
 * @param {(p: {phase: 'stored'|'downloading'|'done', received?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{bytes: Uint8Array, fromCache: boolean}>}
 * @throws 网络失败或 404 时抛出, 由调用方区分「文件不存在」和「其它错误」
 */
export async function fetchModelBytes(url, version, onProgress) {
  const cacheName = `${CACHE_PREFIX}v${version}`;

  // ---- 1. 先查持久化存储 ----
  if (cacheStorageAvailable()) {
    try {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.({ phase: 'stored' });
        const buf = await hit.arrayBuffer();
        // 命中即说明这份数据值得长期保留, 顺手确认持久化状态
        requestPersistentStorage();
        purgeOtherVersions(version);
        onProgress?.({ phase: 'done' });
        return { bytes: new Uint8Array(buf), fromCache: true };
      }
    } catch (err) {
      console.warn('[model-store] 读取模型缓存失败, 改走网络:', err);
    }
  }

  // ---- 2. 未命中 → 下载 ----
  onProgress?.({ phase: 'downloading', received: 0, total: 0 });
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`模型下载失败: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const bytes = await readWithProgress(res, ({ received, total }) =>
    onProgress?.({ phase: 'downloading', received, total })
  );

  // ---- 3. 写入持久化存储(失败不影响本次使用) ----
  if (cacheStorageAvailable()) {
    try {
      // 先申请持久化再写入, 降低刚写完就被驱逐的概率
      await requestPersistentStorage();
      const cache = await caches.open(cacheName);
      await cache.put(
        url,
        new Response(bytes, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.length),
          },
        })
      );
      await purgeOtherVersions(version);
    } catch (err) {
      // 配额不足 / 隐私模式等 —— 只影响下次是否还要重下, 不影响本次
      console.warn('[model-store] 写入模型缓存失败(本次仍可正常使用):', err);
    }
  }

  onProgress?.({ phase: 'done' });
  return { bytes, fromCache: false };
}

/**
 * 清空本站所有模型缓存(调试用, 可在控制台手动调用)
 * @returns {Promise<number>} 删除的缓存数量
 */
export async function clearModelCache() {
  if (!cacheStorageAvailable()) return 0;
  const keys = await caches.keys();
  const targets = keys.filter((k) => k.startsWith(CACHE_PREFIX));
  await Promise.all(targets.map((k) => caches.delete(k)));
  return targets.length;
}
