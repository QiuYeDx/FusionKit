# data 任务

这里的每个任务块是唯一的任务台账，不要再另写状态汇总表；总览由脚本生成。
元数据只引用需求与 AC，不复制 AC 文本。负责人可以连续完成多个任务，但同一时刻只领一个。

通用命令约定：
- `VT` = `node node_modules/vitest/vitest.mjs run`
- `TSC-I1` = 在 scratchpad 中用临时 tsconfig 运行 `node node_modules/typescript/bin/tsc --noEmit -p <临时 tsconfig>`，检查范围是 `src/translation-knowledge/`、`electron/main/translation-knowledge/`、`src/subtitle-studio/`、`electron/main/subtitle-studio/` 及其测试。

### T-DATA-01 FK-TK/2 协议与校验

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-01 |
| 验收 | AC-DATA-01-1, AC-DATA-01-2, AC-DATA-01-3, AC-DATA-01-4 |
| 依赖 | - |
| 写集 | src/translation-knowledge/schemas.ts, src/translation-knowledge/summary.ts, src/translation-knowledge/validation.ts, test/translation-knowledge/protocol.test.ts, test/translation-knowledge/fixtures.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-01.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §1–2](design.md) 重写 `schemas.ts`、`validation.ts`，新增 `summary.ts`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-01-1 | unit | required | VT test/translation-knowledge/protocol.test.ts | - |

### T-DATA-02 存储 format 3、版本不符归档与保留代数

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-02, R-DATA-03 |
| 验收 | AC-DATA-02-1, AC-DATA-02-2, AC-DATA-02-3, AC-DATA-02-4, AC-DATA-03-1, AC-DATA-03-2 |
| 依赖 | T-DATA-01 |
| 写集 | electron/main/translation-knowledge/repository.ts, electron/main/translation-knowledge/errors.ts, test/translation-knowledge/repository.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-01：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-02.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §3](design.md) 实现。归档测试在临时目录中写入非当前版本的指针和若干任意文件，验证这些文件被原样移动；中断恢复通过可注入的 rename 钩子模拟。删除清除日志与 cleanupPending 相关代码。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-02-1 | integration | required | VT test/translation-knowledge/repository.test.ts --maxWorkers=1 --minWorkers=1 | - |

### T-DATA-03 服务、IPC 与预加载：增删改与撤销删除

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-04 |
| 验收 | AC-DATA-04-1, AC-DATA-04-2, AC-DATA-04-3, AC-DATA-04-4, AC-DATA-04-5, AC-DATA-04-6 |
| 依赖 | T-DATA-02 |
| 写集 | electron/main/translation-knowledge/service.ts, electron/main/translation-knowledge/ipc.ts, electron/main/translation-knowledge/index.ts, electron/main/translation-knowledge/maintenance.ts, electron/main/translation-knowledge/maintenance-storage.ts, electron/main/translation-knowledge/task-gate.ts, src/translation-knowledge/ipc-contract.ts, src/translation-knowledge/review-policy.ts, src/translation-knowledge/maintenance-contract.ts, src/translation-knowledge/task-reference-contract.ts, electron/preload/translation-knowledge-api.ts, electron/preload/index.ts, electron/main/index.ts, src/vite-env.d.ts, test/translation-knowledge/ |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-02：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-03.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §4–5](design.md) 实现。删除维护、审核、任务闸门相关的文件及其测试（`maintenance*.test.ts`、`task-maintenance.test.ts`、`batch-review.test.ts`）。main 与 preload 的 provenance 审计留到 I4 重新记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-03-1 | integration | required | VT test/translation-knowledge/service.test.ts test/translation-knowledge/ipc.test.ts --maxWorkers=1 --minWorkers=1 | - |

### T-DATA-04 导入与导出

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-06 |
| 验收 | AC-DATA-06-1, AC-DATA-06-2, AC-DATA-06-3, AC-DATA-06-4, AC-DATA-06-5, AC-DATA-06-6 |
| 依赖 | T-DATA-03 |
| 写集 | electron/main/translation-knowledge/service.ts, electron/main/translation-knowledge/export-selection.ts, electron/main/translation-knowledge/export-plans.ts, src/translation-knowledge/export-contract.ts, src/translation-knowledge/ipc-contract.ts, test/translation-knowledge/import.test.ts, test/translation-knowledge/export-plans.test.ts, test/translation-knowledge/export-selection.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-03：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-04.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §4 导入 / 导出](design.md) 实现。凭据与路径检测函数从旧代码迁出复用；旧的 `export-selection.test.ts` 删除或改写。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-04-1 | integration | required | VT test/translation-knowledge/import.test.ts test/translation-knowledge/export-plans.test.ts --maxWorkers=1 --minWorkers=1 | - |

### T-DATA-05 执行解析 v3 与冻结快照 v2

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-05 |
| 验收 | AC-DATA-05-1, AC-DATA-05-2, AC-DATA-05-3, AC-DATA-05-4, AC-DATA-05-5, AC-DATA-05-6 |
| 依赖 | T-DATA-01 |
| 写集 | src/translation-knowledge/execution-contract.ts, src/translation-knowledge/execution.ts, src/translation-knowledge/snapshot-contract.ts, src/translation-knowledge/automatic-snapshot-contract.ts, test/translation-knowledge/execution.test.ts, test/translation-knowledge/snapshot.test.ts, test/translation-knowledge/automatic-snapshot.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-01：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-05.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [architecture §5](../../architecture.md#5-执行解析-v3srctranslation-knowledgeexecutionts) 与 [设计 §6](design.md) 实现。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-05-1 | unit | required | VT test/translation-knowledge/execution.test.ts test/translation-knowledge/snapshot.test.ts test/translation-knowledge/automatic-snapshot.test.ts | - |

### T-DATA-06 提案构造 v2

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-07 |
| 验收 | AC-DATA-07-1, AC-DATA-07-2, AC-DATA-07-3, AC-DATA-07-4 |
| 依赖 | T-DATA-03 |
| 写集 | src/translation-knowledge/proposal.ts, test/translation-knowledge/proposal.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-03：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-06.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §7](design.md) 实现。集成用例：把提案生成的请求交给临时目录中真实的 `KnowledgeService.saveRecords`，并断言保存结果。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-06-1 | integration | required | VT test/translation-knowledge/proposal.test.ts --maxWorkers=1 --minWorkers=1 | - |

### T-DATA-07 生成产物与 v2 示例

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-DATA-08 |
| 验收 | AC-DATA-08-1 |
| 依赖 | T-DATA-01, T-DATA-04 |
| 写集 | scripts/translation-knowledge/, resources/translation-knowledge/, .agents/skills/fusionkit-translation-knowledge/examples/, .agents/skills/fusionkit-translation-knowledge/references/knowledge-v1.schema.json, .agents/skills/fusionkit-translation-knowledge/references/knowledge-v2.schema.json, .agents/skills/fusionkit-translation-knowledge/scripts/validate.mjs, .agents/skills/fusionkit-translation-knowledge/SKILL.md, .agents/skills/fusionkit-translation-knowledge/references/, electron/main/translation-knowledge/skill-archive.generated.ts, package.json, vite.config.ts, test/translation-knowledge/protocol.test.ts, test/translation-knowledge/skill-archive.test.ts, test/translation-knowledge/fixtures.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-DATA-01：同一工作树 473d58e+I1，其验证通过后继续；T-DATA-04：同一工作树 473d58e+I1，其验证通过后继续 |
| 完成日期 | 2026-10-12 |
| 实施记录 | records/i1/T-DATA-07.md |
| 集成版本 | 473d58e + 未提交工作树（I1） |

#### 实现要点

按 [设计 §8](design.md) 实现。Skill 压缩包测试要求文档内的相对链接都在包内，所以 Skill 文档正文（SKILL.md 与 references，含「从归档重建」）提前在本任务改写为 v2；R-DATA-09 在 I4 只剩模块 README、避坑笔记与 CHANGELOG。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-DATA-07-1 | static | required | npm run knowledge:artifacts && npm run knowledge:check | - |
| V-DATA-07-2 | unit | required | VT test/translation-knowledge/protocol.test.ts test/translation-knowledge/skill-archive.test.ts | - |
| V-DATA-07-3 | static | required | TSC-I1（I1 范围类型检查通过） | - |
