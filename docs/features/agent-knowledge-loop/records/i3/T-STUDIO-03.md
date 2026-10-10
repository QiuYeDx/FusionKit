# 实施记录：T-STUDIO-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-STUDIO-03 |
| 日期 | 2026-10-10 |
| 验证版本 | 45a88e0 + 本会话未提交改动（I3 工作树） |
| 环境 | Windows 11，Node（vitest 2.1.9），临时目录文档库 + mock 模型 |
| 任务指纹 | 94b6ba73a0f80b6f64f91c0dc85512b62aac5faf273678f62f2489e8763d13e4 |

## 实际结果

- `src/subtitle-studio/consistency-contract.ts`：请求/取消 schema（≤20 文档、≤5000 条、每请求 120 行）、抽取提示词、宽松解析、跨块合并、`buildConsistencyGroups`：应用自己按字面回数出处（长写法优先），只保留「≥2 种译法」「存在原文变体」「与资料规定不一致」的组；资料术语另做「原文命中但译文缺少规定写法」检查；推荐写法为资料 > 出现最多；出处带裁剪后的原文/译文供界面展示。
- `electron/main/subtitle-studio/consistency-service.ts`：请求 id 注册、可取消、按块并发（3）、JSON 模式、用量累计、错误映射；文档版本校验；资料按选择取已启用术语。
- IPC：`checkConsistency` / `cancelConsistency` 渠道、preload、白名单；处理器校验所有文档归本窗口所有；纳入 forgetOwner 与关闭清理。
- 合规：Studio 依赖边界新增审计条目（提案构造、资料变更广播、批量记入对话框及其 toast），Studio 页面向 Agent 上报事件改走中立的 `page-context` 事件出口（不再动态引用 Agent 运行时）；`electron/main/subtitle-studio/index.ts` 的组合变更按项目流程在 `current-integration-audits.v1.json` 记录审阅（新 blob 与说明），并按 `eol=lf` 保持字节。

## 用户测试反馈修复（2026-10-10）

用户在 8 个文档、1756 条字幕上检查得到 10 组「原文写法不一」，但无论怎么勾选都显示「统一 0 组（修改 0 条）」，且「センパイ（还写作 先輩）」与「先輩（还写作 せんぱい）」给出相反的修改方向。原因与修正：

- 模型把同一名称分成几项报告时各自成组，方向固定为“改成本组组名”，组名甚至可能没有任何字幕使用（センパイ 显示 69 处，全是 先輩）。现在 `joinSpellings` 把共用写法的项合为一组；按字幕实际回数每种写法（`spellings`，含组名本身），丢弃未出现的写法，组名取出现最多的写法；一行同时含长短两种写法时计入较长者。提示词也要求同一名称只报告一次。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-STUDIO-03-1 | 通过 | file:records/i3/studio-03-consistency.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-STUDIO-04-1 | 通过 | V-STUDIO-03-1 |
| AC-STUDIO-04-2 | 通过 | V-STUDIO-03-1 |
| AC-STUDIO-04-3 | 通过 | V-STUDIO-03-1 |
| AC-STUDIO-04-4 | 通过 | V-STUDIO-03-1 |
| AC-STUDIO-04-5 | 通过 | V-STUDIO-03-1 |

## 风险与未执行项

候选名称来自模型，召回取决于模型；但每个结论都经应用字面回数，不会出现字幕里不存在的写法。Studio 来源审计（provenance）套件同时通过，见 file:records/i3/provenance.log。
