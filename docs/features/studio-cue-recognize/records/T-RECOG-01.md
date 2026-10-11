# 实施记录：T-RECOG-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-RECOG-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:937b572449bce7087b735e3b32eb6d45e6ded0f27a373caa3fbb8261e8831e33 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，假转写运行时构建，FUSIONKIT_TEST_WINDOW=quiet，静音），随应用 FFmpeg n8.1.2 与 whisper.cpp v1.9.1（开发环境 build/subtitle-studio-resources），真实验证用本机已安装的 large-v3-q5_0（CPU），无网络服务 |
| 任务指纹 | 25672bf655e2c8792242c7b0fe9240a5a91f1a0eeee0df8a29a11444bc23190b |

## 实际结果

新增 `recognizeCue` / `cancelCueRecognition` 通道（严格校验、只接受本窗口已打开的文档）；截取器支持指定采样率并新增“识别”解码道；`cue-recognize-service` 截取字幕时间前后各 0.2 秒（最长 30 秒）的 16 kHz 单声道 WAV，写入临时文件（0600、独占创建），交给 `runtime.recognize.clip`（租用转写服务进程、`vadEnabled: false`、beam 5、温度 0），结束后删除临时文件并释放租约；取消时中止解码与推理。组合审计已更新（exact true）。真实验证：Windows 语音合成的英文句子经本机 large-v3-q5_0（CPU）识别为原句，约 17 秒。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RECOG-01-1 | 通过 | file:records/recognize-unit.log |
| V-RECOG-01-2 | 通过 | file:records/recognize-unit.log |
| V-RECOG-01-3 | 通过 | file:records/recognize-real.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RECOG-01-1 | 通过 | V-RECOG-01-1 |
| AC-RECOG-01-2 | 通过 | V-RECOG-01-1 |
| AC-RECOG-01-3 | 通过 | V-RECOG-01-1, V-RECOG-01-2 |
| AC-RECOG-01-4 | 通过 | V-RECOG-01-3 |
| AC-RECOG-03-1 | 通过 | V-RECOG-01-1 |

## 风险与未执行项

真实识别只在 CPU 上验证（未用 CUDA）；真实运行时报告的语言为 "english"，契约只透传，界面不依赖其格式。转写任务以启用 VAD 的不同加载身份运行时返回“资源忙”（设计 A-02 已说明）。
