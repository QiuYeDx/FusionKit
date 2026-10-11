# 实施记录：T-SPLIT-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-SPLIT-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:5712e310e4c453d2d4734819d13281f105e516436bbac84cb42bc37f12116c23 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | 89364bf39be19cee2a97d2bbb31915472614f22fa1a73c75008ec57324202f20 |

## 实际结果

编辑契约新增 `split`（两半文字、拆分时刻、可选两半译文）与 `insert`（前 / 后、时间、文字、可选译文）；新字幕与锚点共用原文件节点或转写片段、修订号为 2；撤销为删除新字幕（拆分另恢复原文字、时间与译文），重做由 restore 恢复同一条。转写校验允许相邻已编辑字幕共用片段，去掉“字幕数不超过片段数”；VTT / ASS / SSA 允许一个节点多条字幕，导出在此情况下不修补原文件。纯函数与只读通道 `suggestCueSplit`（字词时间 / 字数比例）。组合审计已更新（exact true）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SPLIT-01-1 | 通过 | file:records/split-unit.log |
| V-SPLIT-01-2 | 通过 | file:records/split-unit.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SPLIT-01-1 | 通过 | V-SPLIT-01-1 |
| AC-SPLIT-01-2 | 通过 | V-SPLIT-01-1 |
| AC-SPLIT-01-3 | 通过 | V-SPLIT-01-1 |
| AC-SPLIT-01-4 | 通过 | V-SPLIT-01-1 |
| AC-SPLIT-02-1 | 通过 | V-SPLIT-01-1 |
| AC-SPLIT-02-2 | 通过 | V-SPLIT-01-1 |

## 风险与未执行项

ASS / SSA 文档的拆分只经由共用的节点规则覆盖（单元测试使用 VTT）；双语导入成对字幕的拆分未单独测试。
