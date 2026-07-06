# 麻将牌检测模型（YOLOv8 · ONNX）

将训练完成的 YOLOv8 模型导出为 ONNX，放到本目录：

```
assets/model/mahjong_yolov8n.onnx
```

## 类别定义（顺序必须严格一致，共 34 类）

| 索引 | 类名 | 说明 |
| --- | --- | --- |
| 0-8 | `1wan` ~ `9wan` | 一万 ~ 九万 |
| 9-17 | `1tiao` ~ `9tiao` | 一条 ~ 九条 |
| 18-26 | `1tong` ~ `9tong` | 一筒 ~ 九筒 |
| 27-30 | `dong` `nan` `xi` `bei` | 东南西北风 |
| 31 | `zhong` | 红中（本项目作百搭） |
| 32 | `fa` | 发财 |
| 33 | `bai` | 白板 |

> ⚠️ 顺序不一致时识别结果会错乱。请在 Ultralytics 的 `data.yaml` 里按此顺序声明。

## 快速训练

```bash
# 安装
pip install ultralytics

# 训练
yolo detect train \
  data=data.yaml \
  model=yolov8n.pt \
  imgsz=640 \
  epochs=80 \
  batch=16

# 导出为 ONNX（opset ≥ 12，动态 batch 可选）
yolo export model=runs/detect/train/weights/best.pt format=onnx opset=12 simplify=True
```

导出的 `best.onnx` 重命名为 `mahjong_yolov8n.onnx` 后放入本目录即可。

## 不训练也想体验

在网页点击【演示识别】按钮，会用一组预设手牌走通"识别 → 预览 → 修正 → 应用"完整流程。
你也可以点击【加载 ONNX 模型】从本地任意位置直接选择模型文件（不需放到服务器）。

## 输入/输出契约

- 输入张量：`float32[1, 3, 640, 640]`，RGB，值域 `[0, 1]`，letterbox 灰边填充。
- 输出张量：`float32[1, 4+34, N]`（YOLOv8 默认头），前 4 通道为 `cx cy w h`（像素坐标，640×640 空间），后 34 通道为各类置信度。
- 若你的模型头输出格式不同（例如自定义解码或用了 `end2end` NMS 分支），请对应调整 `js/recognition.js` 的 `postprocess`。
