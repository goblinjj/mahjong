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
├── css/
│   └── style.css       # 翡翠牌桌视觉样式与微动效
├── js/
│   ├── app.js          # 主控制器（串联各模块与渲染）
│   ├── camera.js       # 摄像头调用与图片加载
│   ├── recognition.js  # ONNX YOLO 本地图像识别管线
│   ├── tile-selector.js# 手动选牌与手牌排序渲染
│   ├── mahjong-engine.js# 核心算法引擎（胡牌/听牌/红中百搭）
│   ├── analyzer.js     # 舍牌优化决策分析器
│   └── test-engine.js  # 自动化测试用例
├── assets/
│   └── model/          # 存放 YOLO ONNX 模型文件
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

为了开启拍照自动识别牌面功能，您需要将训练好的 YOLO 模型放入本地目录：

1. 准备您的 YOLOv8 训练模型，并导出为 `.onnx` 格式。
2. 将文件重命名为 `mahjong_yolov8n.onnx`。
3. 放入此路径：`assets/model/mahjong_yolov8n.onnx`。
4. 重新刷新网页，点击【拍照识别】即可运行本地推理。*(如果未放置模型，系统会自动降级并引导至手动选牌模式)*

## ⚖️ 许可

本项目采用 MIT 许可。
