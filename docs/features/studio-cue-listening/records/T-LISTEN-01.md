# 实施记录：T-LISTEN-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-LISTEN-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:48c354b152b6c94e79510f14955b329f34a1ffbf30e6ea45b90d0e0a57e126be |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | 59b0f11e4bb7375e89000b08092d15f3ccb0ef43635ddea97d2083a0628b876f |

## 实际结果

主进程 `readCueAudio` 支持 `tempo`（FFmpeg `-t` 改为输入选项 + `atempo`），0.75× / 0.5× 输出时长 = 输入 / tempo 且音高不变；渲染端播放器改为 Web Audio：单段（含循环）、连续播放 20 秒一段首尾调度（预取在上一段开始时发起，来不及时进入加载并从断点续播）、按 tempo 与输出延迟换算原媒体位置、改速从当前位置重开、到结尾或主进程报告无音频时结束。原有单段播放的界面测试全部通过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-LISTEN-01-1 | 通过 | file:records/engine-unit.log |
| V-LISTEN-01-2 | 通过 | file:records/ffmpeg-tempo-prefs.log |
| V-LISTEN-01-3 | 通过 | file:records/regression-electron.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-LISTEN-01-1 | 通过 | V-LISTEN-01-1 |
| AC-LISTEN-01-2 | 通过 | V-LISTEN-01-1, V-LISTEN-01-2 |
| AC-LISTEN-01-3 | 通过 | V-LISTEN-01-1 |
| AC-LISTEN-01-4 | 通过 | V-LISTEN-01-3 |

## 风险与未执行项

无缝衔接以假时钟的调度时刻验证（段 k+1 的开始 = 段 k 开始 + 时长），真实音频设备上的听感未人工确认（测试静音）。输出延迟依赖设备报告的 outputLatency。
