# 麻将听牌分析器 (Mahjong Analyzer)

一款运行在**纯浏览器本地**的网页应用，支持拍照识别或手动选牌，并根据广东麻将「推倒胡」规则分析手牌，推荐最优打法（打哪张可以听最多的牌）。

![翡翠牌桌UI](https://images.unsplash.com/photo-1522069169874-c58ec4b76be5?auto=format&fit=crop&w=600&q=80) <!-- 示意占位，您可替换为实际截图 -->

## 🌟 功能特点

- 🧮 **核心听牌引擎**：支持标准胡（4面子+1雀头）及七对子判定。
- 🏮 **红中百搭**：完美支持红中作为万能牌（百搭）的拆解与胡牌判定。
- 👑 **最优舍牌分析**：14张牌时，深度遍历所有舍牌可能，智能推荐听牌总进张数最多的打法。
- 📷 **本地图像识别**：使用前端 **ONNX Runtime Web** 框架，预留 YOLOv8 图像检测推理管线，完全在本地运行（隐私安全，不离开设备）。
- 🎨 **翡翠牌桌 UI**：质感深绿绒面背景，3D 拟真象牙白麻将牌，提供丝滑的翻转及脉冲动画效果。

## 📁 项目结构

```text
mahjong-analyzer/
├── index.html          # 单页应用入口
├── manifest.webmanifest# PWA 清单
├── sw.js               # Service Worker（缓存 app shell 与 ONNX Runtime）
├── _headers            # Cloudflare Pages 响应头
├── css/
│   └── style.css       # 翡翠牌桌视觉样式与微动效
├── js/
│   ├── app.js          # 主控制器（串联各模块与渲染）
│   ├── camera.js       # 摄像头调用与图片加载
│   ├── recognition.js  # ONNX YOLO 本地图像识别管线
│   ├── model-store.js  # 模型持久化存储（Cache Storage，避免重复下载）
│   ├── tile-selector.js# 手动选牌与手牌排序渲染
│   ├── tile-art.js     # 条子/筒子/白板的 SVG 牌面
│   ├── mahjong-engine.js# 核心算法引擎（胡牌/听牌/红中百搭）
│   ├── analyzer.js     # 舍牌优化决策分析器
│   └── test-engine.js  # 自动化测试用例
├── assets/
│   ├── model/          # 存放 YOLO ONNX 模型文件
│   └── icons/          # PWA 图标（icon.svg 为源文件）
└── package.json        # 项目依赖与开发脚本
```

## 🚀 快速开始

### 1. 本地启动

确保本地已安装 [Node.js](https://nodejs.org/)。

```bash
# 进入项目目录
cd mahjong-analyzer

# 安装依赖
npm install

# 运行本地开发服务器
npm run dev
```

运行后，在浏览器访问 `http://localhost:5173/` 即可。

### 2. 运行自动化测试

我们编写了 10 个测试用例来覆盖各种复杂的胡牌、听牌及红中百搭场景，确保算法 100% 正确：

```bash
node js/test-engine.js
```

### 3. 配置本地 AI 拍照识别

拍照识别使用浏览器端的 **ONNX Runtime Web**（由 `index.html` 从 jsdelivr CDN 引入 `ort.min.js` 及配套 wasm）。识别模型接入有三种方式：

**方式 A · 默认路径**
1. 训练 YOLOv8 麻将牌检测模型（类别定义详见 [`assets/model/README.md`](./assets/model/README.md)）。
2. 导出为 ONNX：`yolo export model=best.pt format=onnx opset=12 simplify=True`。
3. 重命名为 `mahjong_yolov8n.onnx`，放到 `assets/model/`。
4. 刷新页面 → 切换到【📷 拍照识别】→ 顶部状态条应显示 "识别模型就绪"。

**方式 B · 页面上传（无需部署模型）**
- 切换到拍照识别页 → 点击【📦 加载 ONNX 模型】→ 选择本地任意位置的 `.onnx` 文件。
- 模型在浏览器内存中运行，不会上传到任何服务器。

**方式 C · 演示识别（无模型也能跑通）**
- 点击【🎮 演示识别】→ 使用一组预设的示例检测结果，走通 "识别 → 预览与修正 → 应用到手牌" 完整流程。
- 拿这一步验证 UI/分析引擎；确认无误后再回到方式 A/B 接入真实模型。

拍照/上传后会显示带检测框的原图 + 可点击删除的识别结果列表，你可以在应用到手牌之前修正误检。

## 📲 安装到主屏幕（强烈建议）

识别模型约 12MB，**首次打开需要下载一次**。之后模型会被存进浏览器的 Cache Storage 长期保留，正常情况下不会再下载。

不过 iOS Safari 会在大约 7 天无访问后清理普通网页的存储 —— 这正是「过几天打开又要重新下载」的原因。**把本站添加到主屏幕**可以豁免该策略，让模型真正留在本地：

- **iPhone / iPad**：Safari 打开 → 点击底部「分享」→ 选择「添加到主屏幕」
- **Android / Chrome**：菜单 → 「安装应用」或「添加到主屏幕」

安装后从主屏图标启动，模型只在第一次下载，后续打开是秒开且零流量。状态条会显示「已从本地存储载入，未消耗流量」。

> 想确认模型是否已存到本地：打开开发者工具 → Application → Cache Storage，应能看到 `mahjong-model-v3` 桶。

### 本地验证 PWA

`npm run dev`（Vite）下 Service Worker **不会注册**，因为 Vite 的 HMR 会与 SW 缓存互相干扰。要验证 PWA、离线能力或 `_headers`，请用与线上一致的静态服务：

```bash
npm run preview:pages   # wrangler pages dev → http://localhost:8788/
```

## ⚖️ 许可

本项目采用 MIT 许可。
