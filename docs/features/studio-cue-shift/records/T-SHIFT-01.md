# 实施记录：T-SHIFT-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-SHIFT-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:6ce8413ff8f1f252b12a5df586f317c08d63ff0fbc0f2cb79f992ce2bb64fb07 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | f54a96c45b467183592e5827f2d4fef1f10197a152880a370a681460466f9ad2 |

## 实际结果

新增纯函数 `cue-shift.ts`（范围起点与不能平移的原因：开始小于 0、转写文档超出媒体时长、早于前一条）；编辑契约新增 `shift` 操作（整篇或从 `fromCueId` 到结尾，|Δ| ≤ 24 小时、非 0），编辑服务逐条移动开始与结束（未知结束仍未知）并加时间修订号，撤销为反向平移，可放入批量编辑，翻译进行中拒绝；新增只读通道 `previewCueShift`（条数与原因，修订号检查、文档授权）。组合审计已更新（exact true）。250 条文档整篇平移后导出的 VTT 按新时间生成。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SHIFT-01-1 | 通过 | file:records/shift-unit.log |
| V-SHIFT-01-2 | 通过 | file:records/shift-unit.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SHIFT-01-1 | 通过 | V-SHIFT-01-1 |
| AC-SHIFT-01-2 | 通过 | V-SHIFT-01-1 |
| AC-SHIFT-01-3 | 通过 | V-SHIFT-01-1, V-SHIFT-01-2 |
| AC-SHIFT-01-4 | 通过 | V-SHIFT-01-1 |

## 风险与未执行项

10 万条级文档的平移耗时未单独测量（逐条修改内存对象后保存一次，与现有大编辑相同）。
