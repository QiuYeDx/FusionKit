# 实施记录：T-RECOG-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-RECOG-02 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:937b572449bce7087b735e3b32eb6d45e6ded0f27a373caa3fbb8261e8831e33 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，假转写运行时构建，FUSIONKIT_TEST_WINDOW=quiet，静音），随应用 FFmpeg n8.1.2 与 whisper.cpp v1.9.1（开发环境 build/subtitle-studio-resources），真实验证用本机已安装的 large-v3-q5_0（CPU），无网络服务 |
| 任务指纹 | 850e68a0fe6fb55115c1f8887fd1d3166cd0ce1a2dbea2b894e4eed40e7318be |

## 实际结果

右键 / “⋯”菜单新增“重新识别原声…”（无媒体时禁用）；对话框默认取转写设置的模型与语言（会话内记住上次选择），可填提示词；逐条识别并显示进度，可停止；每条显示差异、试听按钮、“与原文一致”“未识别到语音”或失败原因，默认勾选有差异的结果；应用时作为一次可撤销的原文修改（撤销标签“重新识别 N 条字幕”）；没有已安装模型时显示说明与“去安装模型”。关闭对话框时停止识别与试听。渲染审查发现的选项行留白已修复复验。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RECOG-02-1 | 通过 | file:records/regression-electron.log |
| V-RECOG-02-2 | 通过 | file:records/render-review.md |
| V-RECOG-02-3 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RECOG-02-1 | 通过 | V-RECOG-02-1 |
| AC-RECOG-02-2 | 通过 | V-RECOG-02-1 |
| AC-RECOG-02-3 | 通过 | V-RECOG-02-1 |
| AC-RECOG-02-4 | 通过 | V-RECOG-02-1 |
| AC-RECOG-02-5 | 通过 | V-RECOG-02-2 |

## 风险与未执行项

界面测试选中 5 条（3 条不同、1 条一致、1 条失败），取消勾选 1 条后应用 2 条，比 AC 中的 3 条示例多覆盖了一致与失败两种状态；进度逐帧检查 1/5 到 5/5。界面测试用假运行时，截取仍走真实 FFmpeg（构建助手新增 `mediaRuntime`，见 design.md“实施中确定”）。
