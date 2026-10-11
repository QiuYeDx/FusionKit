# 实施记录：T-SHIFT-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-SHIFT-02 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:6ce8413ff8f1f252b12a5df586f317c08d63ff0fbc0f2cb79f992ce2bb64fb07 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | f4e93ec46aabd920888c0214815a4678f4f8a86a0d6d22107bdcdafa9a2844b9 |

## 实际结果

“平移时间”对话框增加范围（所选 / 从第 X 条到结尾 / 整篇；参照字幕为文档第一条时不显示“从第 1 条”），在一页上全选后默认整篇；毫秒输入加 −1 秒、−0.1 秒、+0.1 秒、+1 秒微调；“所选”在本地计算，其余由主进程预检（150 毫秒去抖）；▶ 按平移后的时间试听参照字幕（主进程收到的范围 = 原时间 + 偏移量，改偏移量后再试听使用新值）；未选择时工具栏“平移整篇时间…”；撤销标签“平移 N 条字幕的时间”。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SHIFT-02-1 | 通过 | file:records/regression-electron.log |
| V-SHIFT-02-2 | 通过 | file:records/render-review.md |
| V-SHIFT-02-3 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SHIFT-02-1 | 通过 | V-SHIFT-02-1 |
| AC-SHIFT-02-2 | 通过 | V-SHIFT-02-1 |
| AC-SHIFT-02-3 | 通过 | V-SHIFT-02-1 |
| AC-SHIFT-02-4 | 通过 | V-SHIFT-02-1 |
| AC-SHIFT-02-5 | 通过 | V-SHIFT-02-2 |

## 风险与未执行项

AC-SHIFT-02-4“关闭对话框停止试听”沿用 useStopCueAudioOnClose（与其他对话框相同，cue-audio-ui 已验证该机制），本测试未单独断言。预览文案由“第一条从…”改为“第 X 条从…”，cue-structure-ui 的断言已随之更新并通过。
