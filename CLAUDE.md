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
- ONNX Runtime 通过 `index.html` 的 CDN `<script>` 引入，以全局 `ort` 使用（`recognition.js` 里没有 import）。
- `_headers` 配置 Cloudflare 响应头：`.onnx` 是 `immutable, max-age=1y`。

### 模型文件替换必须递增 MODEL_VERSION

`recognition.js` 导出的 `MODEL_VERSION`（当前 3）同时决定两件事：URL 上的 `?v=N`、以及 Cache Storage 的桶名 `mahjong-model-v{N}`。**每次替换 `.onnx` 文件都必须把它加 1**，否则老用户会一直用着存在本地的旧模型（比单纯的 HTTP 缓存更顽固）。递增后旧桶由 `purgeOtherVersions()` 自动清理。

### 12MB 模型的持久化：Cache Storage，不是 HTTP 缓存

这是本项目最容易理解错的一处。`_headers` 给 `.onnx` 设了 `immutable, max-age=1y`（线上已验证生效），但**这只是"允许"浏览器缓存，不能"保证"**——HTTP 磁盘缓存是可随时驱逐的临时区，12MB 是 LRU 首选目标，iOS Safari 更会在约 7 天无访问后清理。用户表现为「过几天打开又重下 12MB」。

真正的解法在 `js/model-store.js`：把模型放进 **Cache Storage**（受本站配额管理）并申请 `navigator.storage.persist()`。授权后浏览器承诺不再自动驱逐。这是「缓存」与「存储」的本质区别。

`persist()` 是否被授予由浏览器决定，不由代码控制：Chrome 看站点参与度（静默判定），Safari 基本要求已「添加到主屏幕」。**这就是本项目做 PWA 的唯一动机** —— 不是为了离线，是为了让 12MB 真正留在本地。因此 `manifest.webmanifest` + `sw.js` + 引导用户装到主屏，三者缺一效果都会打折。

### Service Worker 绝不能碰模型缓存桶

`sw.js` 的 `activate` 清理旧缓存时，只删 `OWNED_PREFIXES`（`mahjong-shell-` / `mahjong-vendor-`）里的桶。**`mahjong-model-` 前缀由 model-store.js 独占管理，SW 误删会直接导致用户重下 12MB** —— 正是本项目要根治的问题。`fetch` 事件里也对 `.onnx` 直接 return 放行。

新增缓存桶时务必确认前缀不与模型桶冲突。

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
| `js/model-store.js` | 模型的持久化存储层（Cache Storage + persist + 下载进度 + 旧版本清理），不依赖 ORT |
| `sw.js` | Service Worker：app shell 与第三方运行时缓存。**不碰模型** |
| `manifest.webmanifest` | PWA 清单；图标源文件是 `assets/icons/icon.svg`，PNG 由 `npm run icons` 生成 |

## 已知的文档/代码漂移

- `README.md` 描述的【📦 加载 ONNX 模型】和【🎮 演示识别】按钮**当前 UI 里已不存在**，摄像头页现在是实时识别 + 单个「确认识别结果」按钮。
- `recognition.js` 的 `buildDemoDetections()` 和 `camera.js` 的 `loadFromFile()` 已导出但无人调用（对应上面被移除的入口）。改动这两处前先确认是要重新接线还是删除。
