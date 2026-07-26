# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

纯浏览器端的广东麻将「推倒胡 / 红中百搭」听牌分析器。摄像头实时识别（ONNX/YOLOv8）或手动选牌 → 分析向听数、听牌、最优打法。无后端、无用户数据上传。

## 常用命令

```bash
npm install            # 安装 vite + wrangler（仅开发/部署用）
npm run dev            # Vite 开发服务器，http://localhost:5173/（不注册 SW，见下）
npm run preview:pages  # wrangler pages dev，:8788 —— 唯一能验证 PWA/_headers 的方式
npm run test           # 引擎测试（= node js/test-engine.js，失败时 exit 1）
npm run icons          # 从 assets/icons/icon.svg 重新生成 PNG（需 librsvg）
npm run build          # Vite 打包到 dist/（注意：部署并不使用它，见下）
npx wrangler pages deploy .   # 部署到 Cloudflare Pages 项目 "majiang"
```

`js/test-engine.js` 是唯一的测试入口，没有 test runner、没有单测过滤参数。要单独验证某个场景，直接在该文件里加一个 `{ ... }` 块（每个块自包含，用 `assert(cond, msg)` 计数）。

**验证 Service Worker / PWA / `_headers` 必须用 `npm run preview:pages`。** `npm run dev` 下 Service Worker 被刻意跳过注册（`index.html` 里检测 `/@vite/client`），因为 Vite 会把 CSS/JS 转成带 HMR 的模块，被 SW 缓存后会和热更新互相干扰。线上地址：https://majiang.goblin.top/

## 关键架构约束

### 部署产物就是仓库根目录

`wrangler.toml` 里 `pages_build_output_dir = "."`——Cloudflare Pages 直接把仓库根目录当静态站点发布，**不跑 `npm run build`**。因此：

- `index.html` / `js/*.js` 必须是浏览器可直接执行的原生 ES 模块，import 只能用相对路径（`./xxx.js`，带扩展名）。**不要引入需要打包的裸模块名（`import x from 'pkg'`）或 npm 依赖**，那样本地 vite 能跑但线上直接 404。
- ONNX Runtime 通过 `index.html` 的 `<script>` 引入，以全局 `ort` 使用（`recognition.js` 里没有 import）。
- `_headers` 配置 Cloudflare 响应头：`.onnx` 是 `immutable, max-age=1y`。

### 面向中国大陆：零境外依赖是硬约束

主要用户在中国大陆，因此**页面不允许请求任何境外资源**。已经踩过的两处：

- **Google Fonts**：`fonts.googleapis.com` 在大陆被墙，而 `<link rel="stylesheet">` 是渲染阻塞的 —— 会白屏到连接超时。已移除，改用纯系统中文字体栈（见 `css/style.css` 的 `--font-family`）。iOS 苹方 / Android 思源黑体本身就是最佳选择，视觉无损失。
- **cdn.jsdelivr.net**：ORT 运行时曾从这里加载，大陆访问不稳定，拉不到则识别功能完全不可用。已自托管到 `assets/vendor/onnxruntime-web@1.19.2/`（3 个文件，wasm 未压缩 11MB）。

新增任何外部资源前先问：大陆能不能访问？验证方式是跑一遍页面并确认没有非同源请求。

### 升级 ONNX Runtime 的完整步骤

vendor 目录名带版本号，这是缓存失效机制，不是装饰。升级时四处都要改：

1. 下载新版的 `ort.min.js`、`ort-wasm-simd-threaded.mjs`、`ort-wasm-simd-threaded.wasm` 到 `assets/vendor/onnxruntime-web@<新版本>/`
2. `index.html`：`<script src>` 与 `ort.env.wasm.wasmPaths` 两处路径
3. `sw.js`：递增 `VERSION`，让旧的 vendor 缓存桶被清理（否则用户会一直用旧的 11MB）
4. 删掉旧版本目录

具体需要哪几个文件由 ORT 的运行时决定（当前配置 `numThreads = 1`，走 SIMD 单线程分支）。改配置后应重新跑一遍页面，确认没有 404。

### 模型文件替换必须递增 MODEL_VERSION

`recognition.js` 导出的 `MODEL_VERSION`（当前 3）同时决定两件事：URL 上的 `?v=N`、以及 Cache Storage 的桶名 `mahjong-model-v{N}`。**每次替换 `.onnx` 文件都必须把它加 1**，否则老用户会一直用着存在本地的旧模型（比单纯的 HTTP 缓存更顽固）。递增后旧桶由 `purgeOtherVersions()` 自动清理。

### 12MB 模型的持久化：Cache Storage，不是 HTTP 缓存

这是本项目最容易理解错的一处。`_headers` 给 `.onnx` 设了 `immutable, max-age=1y`（线上已验证生效），但**这只是"允许"浏览器缓存，不能"保证"**——HTTP 磁盘缓存是可随时驱逐的临时区，12MB 是 LRU 首选目标，iOS Safari 更会在约 7 天无访问后清理。用户表现为「过几天打开又重下 12MB」。

真正的解法在 `js/model-store.js`：把模型放进 **Cache Storage**（受本站配额管理）并申请 `navigator.storage.persist()`。授权后浏览器承诺不再自动驱逐。这是「缓存」与「存储」的本质区别。

`persist()` 是否被授予由浏览器决定，不由代码控制：Chrome 看站点参与度（静默判定），Safari 基本要求已「添加到主屏幕」。**这就是本项目做 PWA 的唯一动机** —— 不是为了离线，是为了让 12MB 真正留在本地。因此 `manifest.webmanifest` + `sw.js` + 引导用户装到主屏，三者缺一效果都会打折。

### Service Worker 绝不能碰模型缓存桶

`sw.js` 的 `activate` 清理旧缓存时，只删 `OWNED_PREFIXES`（`mahjong-shell-` / `mahjong-vendor-`）里的桶。**`mahjong-model-` 前缀由 model-store.js 独占管理，SW 误删会直接导致用户重下 12MB** —— 正是本项目要根治的问题。`fetch` 事件里也对 `.onnx` 直接 return 放行。

新增缓存桶时务必确认前缀不与模型桶冲突。

### 大文件必须 cache-first，不能 stale-while-revalidate

`/assets/vendor/*`（11MB 的 ORT wasm）在 `sw.js` 里走 `cacheFirst`。如果误用同源默认的 `staleWhileRevalidate`，**每次打开页面都会在后台重新下载 11MB** —— 用户看不到，但流量实实在在。判断标准是内容可变性：vendor 路径带版本号、内容不可变 → cache-first；HTML/CSS/JS 会改 → stale-while-revalidate。

### SW 预缓存要当心内容协商

`sw.js` 的 `SHELL_ASSETS` 支持 `{ url, headers }` 形式，目前 `/css/style.css` 用它显式声明了 `Accept: text/css`。原因：SW 预缓存发的请求默认 `Accept: */*`，而开发服务器（Vite）会据此返回 HMR 的 **JS 包装版**而不是真 CSS，缓存下来页面会完全失去样式。生产是纯静态文件没有协商，但显式带 Accept 更健壮。新增会被 dev server 转换的资源时注意这一点。

### 牌索引与「百搭单独计数」的核心约定

全项目统一 34 类索引：`0-8 万`、`9-17 条`、`18-26 筒`、`27-30 东南西北`、`31 中(百搭)`、`32 发`、`33 白`（`WILD_TILE = 31`）。

**最容易踩的坑**：手牌用 `(tiles: Uint8Array(34), wildCount: number)` 二元组表示，红中**不**存进 `tiles[31]`，而是单独放在 `wildCount` 里。引擎所有函数都假设 `tiles[31] === 0`；`TileSelector`、`analyzeHand`、识别结果应用逻辑都遵守这一点。另外红中永远不作为「可胡的目标牌 / 有效进张」返回给 UI。

### 引擎的原地修改契约

`mahjong-engine.js` 的递归（`canFormMelds`、`checkStandardWin`、各 `canDiscardTo*`）为性能起见**原地修改 `tiles` 并在返回前还原**。新增任何递归分支时必须保证每条 return 路径都已还原计数，否则会静默污染调用方手牌。

### 向听数缓存必须显式清空

`isTenpaiFast` 有模块级 memo（`_tenpaiCache`，key 是 `tiles.join(',')+'|'+wildCount`）。缓存只在一次分析内有效，**每次顶层分析前必须调用 `resetShantenCache()`**——`analyzeHand` 已在两个入口各调一次。二向听递归是 CPU 密集的（秒级），`app.js` 因此先渲染 loading 再 `requestAnimationFrame` 两帧后同步计算。

`MAX_SHANTEN_DEPTH = 2`：超过二向听不再精确计算，返回 `far_from_tenpai`。`analyzeDiscard` 用「当前最佳向听数」作为 `getShanten` 的 `maxDepth` 做自适应剪枝。

### analyzeHand 的返回类型是判别联合

`analyzer.js` 按手牌总数分派：`3k+2`（2/5/8/11/14）走出牌分析，`3k+1`（1/4/7/10/13）走听牌/向听分析，`3k` 一律 `invalid`。返回 `{type}` 取值：`already_won | discard | far_from_tenpai | tenpai | shanten | invalid`，字段各不相同——`app.js` 的 `renderResult` switch 必须与之同步。手牌少于 14 张被解释为已副露若干组，因此七对子只在 14 张时判定。

### 摄像头「条带取景」的三处耦合常量

只对画面中间条带做推理。改动时以下三处必须一起改，否则叠加框会错位：

- `app.js`：`BAND_TOP_FRAC = 0.35` / `BAND_BOTTOM_FRAC = 0.35`（裁剪比例），`VISIBLE_BAND_FRAC` 由其推导，`ensureContainerAspect()` 据此设置容器 `aspect-ratio`。
- `css/style.css`：`#camera-container { aspect-ratio: 40/9 }`（JS 会按实际视频比例覆盖）、`#camera-frame { height: 333.333%; transform: translateY(-35%) }`。

推理在裁剪后的条带坐标系里进行，`detectionTick` 会把 bbox 的 `y` 加回 `yOffset` 还原到全帧坐标，叠加层再线性缩放绘制。

另有一处不影响对位、但同样是跨文件耦合的：`css/style.css` 的 `#camera-container[data-fuse-state='…']` 四条规则由 `app.js` 的 `updateLiveBadge` 写入，取值必须与 `detection-fuser.js` 的 `FuserState` 完全一致。写错不会报错，只是虚线颜色不变。

### 识别结果必须经过多帧融合，不能直接用单帧

单帧 YOLO 在置信度阈值附近会闪，13 张牌会在 12/13 之间跳动、类别会在相邻两张之间跳变。`recognition.js` 的 `confThreshold` 因此**刻意设为 0.3 而非常规的 0.5**——先把弱证据放进来，再由 `detection-fuser.js` 用多帧出现率把噪声滤出去。**单独调高阈值而不动融合器，或者绕过融合器直接用 `detect()` 的结果，都会让抖动回归。**

`app.js` 的 `detectionTick` 把原始检测喂给模块级的 `fuser`，用返回快照的 `tiles` 赋给 `liveDetections`。融合器的输出结构与原始检测完全一致，因此 `drawOverlay`、确认流程、预览页都不感知它的存在。

五个容易踩的点：

- **`stopDetectionLoop()` 必须调 `fuser.reset()`**，否则上一副牌的投票会污染下一副，用户会拿到一副从未存在过的手牌。
- **fuser 不得引用任何 DOM/浏览器 API**，时间由 `push(detections, now)` 的第二个参数传入。这是它能在 `js/test-engine.js` 里被 node 测试的前提——融合逻辑无法靠对着摄像头肉眼调准。
- **「待定」轨迹不进输出但会阻止 stable**。这是有意的：静默补一张类别没收敛的牌，比少一张更坏。持续 8 秒不稳定会降级为 DEGRADED 解锁强制确认，否则光线差时按钮永远不亮。
- **`DEFAULT_CONFIG` 里的比率阈值不能取到「可达值」上**。`presentRate` / `pendingRate` / `voteRatio` 都是在 `windowSize` 帧的窗口内算出来的，取值集合是离散的：5 帧窗口下出现率只能是 0.2/0.25/0.333/0.4/0.5/0.6/0.667/0.75/0.8/1.0。投票占比因为按置信度加权、理论上连续，但**各帧置信度接近时会紧贴同一组离散值**（两类之争是 0.6/0.8/1.0），实践中照样会卡在边界上。**阈值一旦等于某个可达值，判据就恒真或恒假，闸门静默失效且不报错。** 本项目已经因此栽过三次（位移 reset 阈值、`voteRatio`、`presentRate`），所以 `presentRate` 与 `voteRatio` 都取 0.7 这种「落在两个可达值之间」的数。**改动 `windowSize` 或任何一个比率阈值，都必须重算可达值集合。**

- **`updateLiveBadge` 的 switch 必须与 `FuserState` 同步**，和 `renderResult` 必须与 `analyzeHand` 的判别联合同步是同一类约束。新增状态而不更新它，UI 会静默停在上一个状态。

所有阈值集中在 `detection-fuser.js` 的 `DEFAULT_CONFIG`，真机调参只改那一处。

### 模型类别映射

`postprocess` 从 `dims[1] - 4` 反推类别数：42 类走 `roboflow42to34` 映射表（Roboflow `mahjong-baq4s` 数据集按字母序，花牌/季牌映射为 `null` 直接丢弃），34 类直接使用。模型输入输出契约详见 `assets/model/README.md`；换用其它检测头（如带 end2end NMS）需要改 `postprocess`。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `js/mahjong-engine.js` | 纯算法：胡牌判定、听牌、向听数、有效进张。不依赖 DOM，可直接被 node 引入 |
| `js/analyzer.js` | 在引擎之上做场景分派与出牌推荐排序。同样不依赖 DOM |
| `js/app.js` | 唯一的 DOM 入口（`index.html` 只 import 它），串联所有模块并渲染结果 |
| `js/tile-selector.js` | 手动选牌面板 + 手牌渲染，`createTileElement(idx, size)` 是全项目唯一的牌 DOM 工厂 |
| `js/tile-art.js` | 条子/筒子/白板的 SVG 牌面（viewBox 88×120）。万子和其余字牌由 tile-selector 用文字渲染 |
| `js/camera.js` | getUserMedia 封装，`capture()` 返回全帧 ImageData |
| `js/recognition.js` | ONNX 会话管理 + letterbox 预处理 + YOLOv8 后处理 + NMS |
| `js/detection-fuser.js` | 多帧检测融合：跨帧轨迹关联 + 出现率分档 + 类别投票 + 稳定状态机。不依赖 DOM，可被 node 引入 |
| `js/model-store.js` | 模型的持久化存储层（Cache Storage + persist + 下载进度 + 旧版本清理），不依赖 ORT |
| `sw.js` | Service Worker：app shell 与第三方运行时缓存。**不碰模型** |
| `manifest.webmanifest` | PWA 清单；图标源文件是 `assets/icons/icon.svg`，PNG 由 `npm run icons` 生成 |

## 已知的文档/代码漂移

- `README.md` 描述的【📦 加载 ONNX 模型】和【🎮 演示识别】按钮**当前 UI 里已不存在**，摄像头页现在是实时识别 + 单个「确认识别结果」按钮。
- `recognition.js` 的 `buildDemoDetections()` 和 `camera.js` 的 `loadFromFile()` 已导出但无人调用（对应上面被移除的入口）。改动这两处前先确认是要重新接线还是删除。
