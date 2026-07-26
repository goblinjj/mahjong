/**
 * sw.js — Service Worker
 *
 * 职责划分（重要）:
 *   - 本文件只管 app shell(HTML/CSS/JS/图标) 和第三方运行时(ORT、字体)
 *   - 12MB 的 .onnx 模型**不由这里管**, 而是由 js/model-store.js 存进
 *     独立的 `mahjong-model-v*` 缓存桶。原因: 模型体积远大于 shell,
 *     放进 install 阶段预缓存会让安装很慢且容易整体失败; 分开管理还能
 *     让模型版本和站点版本各自独立演进。
 *
 *   >>> activate 清理旧缓存时绝不能删除 `mahjong-model-` 前缀的桶 <<<
 *       误删会导致用户重新下载 12MB —— 正是本次要根治的问题。
 *
 * PWA 化的意义: iOS Safari 对普通标签页的存储会在约 7 天无访问后清理,
 * 而「添加到主屏幕」后的站点豁免该策略, navigator.storage.persist()
 * 也更容易获得授权。这是让模型真正长期留存的前提。
 */

const VERSION = 'v1';
const SHELL_CACHE = `mahjong-shell-${VERSION}`;
const VENDOR_CACHE = `mahjong-vendor-${VERSION}`;

/** 本 SW 管理的缓存前缀。不在此列的(如 mahjong-model-)一律不碰。 */
const OWNED_PREFIXES = ['mahjong-shell-', 'mahjong-vendor-'];

/**
 * 应用自身的静态资源。
 *
 * 元素可以是字符串，也可以是 { url, headers } —— 后者用于需要显式声明
 * Accept 的资源: 开发服务器(如 Vite)会按 Accept 做内容协商，SW 预缓存时
 * 发的请求默认 `Accept: *​/*`，拿到的会是 HMR 的 JS 包装版而不是真 CSS，
 * 缓存下来会导致页面完全没有样式。生产环境是纯静态文件，没有这个问题，
 * 但显式带上 Accept 更健壮。
 */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  { url: '/css/style.css', headers: { Accept: 'text/css,*/*;q=0.1' } },
  '/js/app.js',
  '/js/analyzer.js',
  '/js/camera.js',
  '/js/mahjong-engine.js',
  '/js/model-store.js',
  '/js/recognition.js',
  '/js/tile-art.js',
  '/js/tile-selector.js',
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
];

/**
 * 自托管的第三方运行时前缀（ONNX Runtime 的 js + wasm，约 11MB）。
 * 目录名带版本号 → 内容不可变 → 必须 cache-first：
 * 若走 stale-while-revalidate，每次打开都会在后台重新下载 11MB。
 */
const VENDOR_PATH_PREFIX = '/assets/vendor/';

// ============================================================
// 生命周期
// ============================================================

/** 把 SHELL_ASSETS 的元素规范化成 Request */
function toRequest(asset) {
  const { url, headers } = typeof asset === 'string' ? { url: asset } : asset;
  return new Request(url, { cache: 'reload', headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // 单个资源失败不应让整次安装失败(例如某个图标暂时 404)
      .then((cache) => Promise.allSettled(
        SHELL_ASSETS.map((asset) => cache.add(toRequest(asset)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          // 只清理本 SW 拥有的、且非当前版本的桶；模型桶不在 OWNED_PREFIXES 里
          .filter((k) =>
            OWNED_PREFIXES.some((p) => k.startsWith(p)) &&
            k !== SHELL_CACHE &&
            k !== VENDOR_CACHE
          )
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ============================================================
// 请求拦截
// ============================================================

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 模型由 model-store.js 自行管理，SW 完全不介入
  if (url.pathname.endsWith('.onnx')) return;

  // 页面导航：network-first，离线时回退到缓存的首页
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 自托管运行时：cache-first（路径已版本化，内容不会变）
  if (url.pathname.startsWith(VENDOR_PATH_PREFIX)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
    return;
  }

  // 其余同源静态资源：stale-while-revalidate，秒开且后台更新
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// ============================================================
// 缓存策略
// ============================================================

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const res = await fetch(request);
  // 只缓存明确成功的响应。opaque(跨域 no-cors)拿不到真实状态码，
  // 缓存下来可能把一次 5xx 永久固化，因此跳过。
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  return hit || (await network) || Response.error();
}
