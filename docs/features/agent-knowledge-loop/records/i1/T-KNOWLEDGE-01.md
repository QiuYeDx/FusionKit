# 实施记录：T-KNOWLEDGE-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-KNOWLEDGE-01 |
| 日期 | 2026-10-10 |
| 验证版本 | 45a88e0 + 本会话未提交改动（I1 最终工作树） |
| 环境 | Windows 11，Node（vitest 2.1.9，单 fork），临时目录真实读写资料库 |
| 任务指纹 | 3760ba752f541ec5e58010215253fa4a488edd9f6879a634f8989bb0c4339941 |

## 实际结果

- `KnowledgeService.saveRecord` 的事务体抽为 `commitSaves(state, items)`，`saveRecord` 与新的 `saveRecords` 共用：一次 generation 检查、逐项保存（后项可引用前项新建记录）、一次 `invalidate`、一次整库校验、adopt 条目逐个批准；任一步抛错不提交。
- `saveRecords` 先逐项解析，诊断路径前缀 `/items/<i>`；同批重复记录/证据 id 返回 `DUPLICATE_BATCH_RECORD`。
- IPC：`ipc.ts` 新 schema（1..200 项、严格字段），`index.ts` 分发，渠道 `translation-knowledge:save-records`，preload 新方法，`TranslationKnowledgeApi.saveRecords`。
- 原 `saveRecord` 的 30 个既有用例全部保持通过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-KNOWLEDGE-01-1 | 通过 | file:records/i1/knowledge-01-service-ipc.log |
| V-KNOWLEDGE-01-2 | 通过 | file:records/i1/knowledge-regression.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-KNOWLEDGE-01-1 | 通过 | V-KNOWLEDGE-01-1 |
| AC-KNOWLEDGE-01-2 | 通过 | V-KNOWLEDGE-01-1 |
| AC-KNOWLEDGE-01-3 | 通过 | V-KNOWLEDGE-01-1 |
| AC-KNOWLEDGE-01-4 | 通过 | V-KNOWLEDGE-01-1 |
| AC-KNOWLEDGE-01-5 | 通过 | V-KNOWLEDGE-01-1 |

## 风险与未执行项

真实 Electron 中的 IPC 调用另由 T-AGENT-04 的端到端场景覆盖（卡片确认即走此通道）。未测并发写入压力；沿用仓库既有串行队列。
