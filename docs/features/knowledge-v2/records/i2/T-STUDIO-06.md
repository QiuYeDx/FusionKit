# 实施记录：T-STUDIO-06

| 字段 | 值 |
| --- | --- |
| 任务 | T-STUDIO-06 |
| 日期 | 2026-10-12 |
| 验证版本 | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12 21:45） |
| 环境 | Windows 11 Pro 10.0.26200，Node v20.19.4，vitest 2.1.9，Electron 测试版构建（vite build --mode=test），静默窗口，隔离临时 userData，无真实资料 |
| 任务指纹 | 50c1607b577ed7ff3a77176652a25184869e4cde9b220c629dc5aa2f7fac2478 |

## 实际结果

记住译法与记入翻译资料改走提案接口，一次事务保存、保存即启用；去掉采纳开关；共享 CaptureDestinationFields：已有资料集沿用自身方向、方向与当前翻译不一致时提示，新建资料集选择方向且默认取文档方向（记住译法也改用 captureLanguagePair）；重试以相同 id 重建视为已保存。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-STUDIO-06-1 | 通过 | file:records/i2/i2-unit.log |
| V-STUDIO-06-2 | 通过 | file:records/i2/i2-ui.log |
| V-STUDIO-06-3 | 通过 | file:records/i2/i2-ui.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-STUDIO-04-1 | 通过 | V-STUDIO-06-1, V-STUDIO-06-2, V-STUDIO-06-3 |
| AC-STUDIO-04-2 | 通过 | V-STUDIO-06-1, V-STUDIO-06-2, V-STUDIO-06-3 |
| AC-STUDIO-04-3 | 通过 | V-STUDIO-06-1, V-STUDIO-06-2, V-STUDIO-06-3 |

## 风险与未执行项

一致性检查保留的写法来自已应用的统一修订，origin 记为 revision（与 AC-STUDIO-04-2 一致）。方向提示曾写「创建后不能修改」，与资料页可改方向（AC-PAGE-04-2）矛盾，已改为「之后可以在翻译资料页修改」。没有选资料时批量翻译表单不选原文语言，此时新建资料集需要用户自选原文语言。
