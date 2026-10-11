# 实施记录：T-TRACK-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRACK-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:2e1aa984584d3688b72dc785c94601277f324e48528b5c9ac0547ffa3627d324 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，假转写运行时构建，FUSIONKIT_TEST_WINDOW=quiet，静音），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | e507f7c6ebd5d4800c0498e288c1e246b8e7f899007aa3c5715799502a1eda86 |

## 实际结果

媒体文档来源新增可选 `audioTrack`（序号 1–128、语言、标题）；适配器与 sink 写入；任务服务新增 `describeAudioTrack`，入队时解析并随记录交给 sink；运行时门面按 owner 缓存最近的探测摘要（释放时清除，每 owner 最多 200 个），用共享纯函数 `audioTrackOfProbe` 解析（所选，否则自动选择）；假运行时同样解析并补上源位置。组合审计已更新（exact true）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRACK-01-1 | 通过 | file:records/track-unit.log |
| V-TRACK-01-2 | 通过 | file:records/regression-unit.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRACK-01-1 | 通过 | V-TRACK-01-1 |
| AC-TRACK-01-2 | 通过 | V-TRACK-01-1, V-TRACK-01-2 |

## 风险与未执行项

AC-TRACK-01-1 中“未选择且第 2 条为唯一默认音轨”由 `audioTrackOfProbe` 对自动选择 id 的解析覆盖；默认音轨的判定本身在冻结的规范化器中（探测摘要的 autoSelectedStreamId），未在本次重复测试。渲染端实际总是显式发送所选音轨。
