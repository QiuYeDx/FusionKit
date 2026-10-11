# 实施记录：T-TRACK-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRACK-02 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:2e1aa984584d3688b72dc785c94601277f324e48528b5c9ac0547ffa3627d324 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，假转写运行时构建，FUSIONKIT_TEST_WINDOW=quiet，静音），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | 85cd2c705d706ad9ed7059549715eb5f61e6a320d05afedd59e0036e182b8fc7 |

## 实际结果

`CueMediaService` 对转写来源与手动选择的媒体给出 `audioOrdinal` 与状态中的 `track`；`CueAudioClipper.decode` 以 `-map 0:a:<序号−1>` 选流，文件缺少该流时用第一条重试；试听、连续播放、波形与重新识别都经由它；“原始音频”面板新增音轨一行。两音轨 MKV（440 / 880 Hz）实测：记住第 2 条解码到 880 Hz，第 1 条或未记住为 440 Hz，重新选择同一文件沿用，单音轨文件回退到第一条。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRACK-02-1 | 通过 | file:records/track-unit.log |
| V-TRACK-02-2 | 通过 | file:records/regression-electron.log |
| V-TRACK-02-3 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRACK-02-1 | 通过 | V-TRACK-02-1 |
| AC-TRACK-02-2 | 通过 | V-TRACK-02-1 |
| AC-TRACK-02-3 | 通过 | V-TRACK-02-2 |

## 风险与未执行项

界面测试中的媒体为假运行时的占位文件，面板显示与来源记录真实，但未在界面中解码多音轨（解码由 V-TRACK-02-1 的真实 FFmpeg 测试覆盖）。
