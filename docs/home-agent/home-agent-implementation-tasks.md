# FusionKit Home Agent 开发任务维护文档

> 来源设计文档：`docs/home-agent/home-agent-feasibility.md`  
> 目标：将首页升级为支持"多目录 + 多文件 + 混合指定"的对话式 Agent 工作台，并可分步、可追踪地实施落地。

---

## 1. 使用说明（先读）

本文件用于日常执行管理，建议每次开发前后都更新：

1. 开始开发前，把一个任务标记为 `IN_PROGRESS`（同一时间只保留一个主任务进行中）。
2. 完成后改为 `DONE`，并填写"完成记录"和"验证记录"。
3. 遇到阻塞改为 `BLOCKED`，在"阻塞原因"填写明确原因与下一步方案。
4. 需求变更时，不删除原任务，改为 `CANCELLED` 并新增替代任务，保留历史。

---

## 2. 状态与优先级定义

### 2.1 任务状态

- `TODO`：未开始
- `IN_PROGRESS`：进行中
- `BLOCKED`：阻塞
- `DONE`：完成
- `CANCELLED`：取消（由新任务替代）

### 2.2 优先级

- `P0`：阻塞主链路，不完成无法推进
- `P1`：核心功能
- `P2`：增强与体验优化

---

## 3. 里程碑总览（建议顺序）

| 里程碑 | 名称 | 目标 | 预估 |
| --- | --- | --- | --- |
| M0 | 基线与任务模型 | 统一任务与目标集合数据结构 | 1 天 |
| M1 | 任务总线统一 | 转换/提取任务从页面状态迁移到 store | 2-3 天 |
| M2 | 目录发现与混合目标解析 | 支持多目录+多文件+排除规则 | 2-3 天 |
| M3 | Tool Registry 与执行适配 | 工具 Schema、校验、执行器打通 | 1-2 天 |
| M4 | 首页 Agent MVP | 对话、清单确认、入队执行 | 2-3 天 |
| **R1** | **v2 架构重构** | **修复 v1 架构缺陷，重构为对话优先+多轮循环** | **1 天** |
| M5 | 风险控制与可观测性 | 权限、审计、日志、错误处理 | 1-2 天 |
| M6 | 测试与发布准备 | 单测/集成/E2E、文档回填 | 1-2 天 |

---

## 4. 任务清单（主看板）

> 字段说明：  
> `依赖` 为空表示可立即做；`DoD` = Definition of Done（完成判定标准）。

### v1 阶段任务

| ID | 任务 | 优先级 | 依赖 | 状态 | 预计 |
| --- | --- | --- | --- | --- | --- |
| T-001 | 定义统一任务实体（`TaskKind/TaskLifecycle/TaskTargetRef`） | P0 | - | DONE | 0.5d |
| T-002 | 定义 `TargetSet` 与冲突优先级策略（排除/包含） | P0 | T-001 | DONE | 0.5d |
| T-003 | 新建 `useSubtitleConverterStore` 并迁移页面状态 | P0 | T-001 | DONE | 1d |
| T-004 | 新建 `useSubtitleExtractorStore` 并迁移页面状态 | P0 | T-001 | DONE | 1d |
| T-005 | 建立 `target-resolver`（多目录+多文件混合解析） | P0 | T-002 | ~~DONE~~ → CANCELLED | 1d |
| T-006 | 建立 `discovery-engine`（扫描、去重、来源标记） | P0 | T-002 | ~~DONE~~ → CANCELLED | 1d |
| T-007 | 建立 `filter-rules`（候选/排除双清单与原因） | P1 | T-006 | ~~DONE~~ → CANCELLED | 1d |
| T-008 | 新增主进程 FS IPC（目录扫描/元数据读取） | P0 | T-006 | DONE | 1d |
| T-009 | 定义 Tool Registry + Zod schemas | P0 | T-001,T-002 | ~~DONE~~ → CANCELLED | 1d |
| T-010 | 实现 `resolve_processing_targets` 工具 | P0 | T-005,T-009 | ~~DONE~~ → CANCELLED | 0.5d |
| T-011 | 实现 `scan_subtitle_files_in_targets` 工具 | P0 | T-006,T-008,T-009 | ~~DONE~~ → CANCELLED | 0.5d |
| T-012 | 实现 `build_processing_candidates` 工具 | P1 | T-007,T-009 | ~~DONE~~ → CANCELLED | 0.5d |
| T-013 | 实现 `apply_candidate_filters` 工具 | P1 | T-007,T-009 | ~~DONE~~ → CANCELLED | 0.5d |
| T-014 | 实现 3 个 queue 工具适配层（翻译/转换/提取） | P0 | T-003,T-004,T-009 | ~~DONE~~ → CANCELLED | 1d |
| T-015 | 实现 `useAgentStore`（会话、计划、状态机） | P0 | T-009 | ~~DONE~~ → CANCELLED | 1d |
| T-016 | 实现 `orchestrator`（解析->工具调用->回写） | P0 | T-010~T-015 | ~~DONE~~ → CANCELLED | 1d |
| T-017 | 新建 `HomeAgent` 页面（对话区+候选清单+计划卡） | P0 | T-015,T-016 | ~~DONE~~ → CANCELLED | 1.5d |
| T-018 | 首页路由替换与旧 Home 融合策略 | P1 | T-017 | DONE | 0.5d |
| T-019 | 清单二次筛选交互（增删目录/文件/限制条数） | P1 | T-017 | CANCELLED | 1d |
| T-020 | 执行模式支持（草案/确认即执行/自动执行） | P1 | T-016,T-017 | CANCELLED | 0.5d |
| T-021 | 权限白名单与敏感目录二次确认 | P0 | T-008,T-016 | TODO | 0.5d |
| T-022 | 结构化日志与审计记录（扫描、筛选、入队） | P1 | T-016 | TODO | 0.5d |
| T-023 | 单元测试（resolver/filter/schema） | P0 | T-005,T-007,T-009 | TODO | 1d |
| T-024 | 集成测试（混合目标指令全链路） | P1 | T-016,T-019,T-020 | TODO | 1d |
| T-025 | E2E 测试（多目录+多文件+排除规则） | P1 | T-017,T-019,T-020 | TODO | 1d |
| T-026 | 文档回填（设计偏差、最终接口、使用说明） | P2 | T-025 | TODO | 0.5d |

> **T-005/006/007/009~017/019/020 取消原因**：v1 架构存在根本性缺陷（见 R1 重构说明），已由 R-001~R-007 替代。

### R1 重构阶段任务（v2 架构）

| ID | 任务 | 优先级 | 依赖 | 状态 | 预计 |
| --- | --- | --- | --- | --- | --- |
| R-001 | 重写 `tool-schemas.ts`：7 个嵌套 schema → 4 个扁平 schema | P0 | - | DONE | 0.5h |
| R-002 | 重写 `tool-registry.ts`：7 工具 → 4 核心工具，移除 stub | P0 | R-001 | DONE | 0.5h |
| R-003 | 重写 `tool-executor.ts`：文件参数从嵌套对象简化为路径字符串 | P0 | R-001,R-002 | DONE | 0.5h |
| R-004 | 重写 `orchestrator.ts`：对话优先 prompt + 多轮 tool-call 循环 | P0 | R-001~R-003 | DONE | 1h |
| R-005 | 精简 `types.ts`：324 行 → ~35 行，移除 20+ 未使用类型 | P0 | R-004 | DONE | 0.5h |
| R-006 | 精简 `useAgentStore.ts`：移除 Plan 相关 8 个方法 | P0 | R-005 | DONE | 0.5h |
| R-007 | 更新 `HomeAgent/index.tsx`：移除 PlanCard，优化工具结果展示 | P0 | R-005,R-006 | DONE | 0.5h |
| R-008 | 删除废弃文件：`discovery-engine.ts`、`filter-rules.ts`、`target-resolver.ts` | P0 | R-003 | DONE | - |

---

## 5. 分阶段执行清单（可勾选）

## M0：基线与任务模型

- [x] T-001 统一任务模型类型定义完成
- [x] T-002 `TargetSet` 与冲突策略文档化并落地类型
- [x] 产出：`src/agent/types.ts` + 设计注释

### M0 DoD

- 类型可覆盖"多目录 + 多文件 + 混合 + 排除"
- 冲突优先级有明确默认策略并可配置

## M1：任务总线统一

- [x] T-003 转换任务迁移到 store
- [x] T-004 提取任务迁移到 store
- [ ] 工具页仍可正常显示任务进度与状态（待手工验证）

### M1 DoD

- 首页和工具页可共享同一任务源
- 无回归：转换/提取现有功能可用

## M2：目录发现与混合目标解析（已被 R1 重构简化）

- [x] ~~T-005 完成自然语言目标解析（目录/文件/排除）~~ → CANCELLED，功能由 LLM + system prompt 承担
- [x] ~~T-006 完成扫描引擎（递归、去重、来源）~~ → CANCELLED，功能内联到 `tool-executor.ts`
- [x] ~~T-007 完成候选/排除双清单与原因~~ → CANCELLED，筛选逻辑由 LLM 自然语言能力替代
- [x] T-008 完成 Main IPC 扫描能力（保留）

### M2 DoD（更新后）

- scan IPC 能正常返回目录下的字幕文件列表
- Agent 可通过 `scan_subtitle_files` 工具调用 IPC 扫描

## M3：Tool Registry 与执行适配（已被 R1 重构替代）

- [x] ~~T-009~T-014~~ → CANCELLED，由 R-001~R-003 替代
- [x] R-001 4 个扁平 Zod schema 完成
- [x] R-002 4 工具 registry 完成
- [x] R-003 简化执行器完成

### M3 DoD（更新后）

- 4 个工具入参都有 Zod schema 校验
- scan → queue 链路可跑通

## M4：首页 Agent MVP（已被 R1 重构替代）

- [x] ~~T-015~T-017~~ → CANCELLED，由 R-004~R-007 替代
- [x] T-018 路由替换完成（保留）
- [x] R-004 对话优先 orchestrator + 多轮循环完成
- [x] R-005 类型精简完成
- [x] R-006 Store 精简完成
- [x] R-007 HomeAgent UI 适配完成
- [ ] ~~T-019 二次筛选交互~~ → CANCELLED
- [ ] ~~T-020 三种执行模式~~ → CANCELLED

### M4 DoD（更新后）

- 用户可通过对话完成：闲聊 / 任务下达 / 扫描文件 / 入队执行
- 普通对话不会触发工具调用或报错
- 多步任务（scan → queue）可在一次对话中自动完成

## M5：风险控制与可观测性

- [ ] T-021 权限白名单 + 敏感目录保护
- [ ] T-022 审计与日志完成

### M5 DoD

- 未授权路径不可访问
- 每轮关键动作可追踪（可定位问题）

## M6：测试与发布准备

- [ ] T-023 单元测试通过
- [ ] T-024 集成测试通过
- [ ] T-025 E2E 用例通过
- [ ] T-026 文档回填完成

### M6 DoD

- 核心路径测试通过且可复现
- 文档与实现一致

---

## 6. R1 重构记录（2026-02-26）

### 6.1 重构原因

v1 实现经手工测试发现以下根本性问题：

1. **System Prompt 过于激进**：写了"CRITICAL: Act immediately"、"NEVER reply with a question"，强制 LLM 每次都尝试调用工具，用户闲聊时会"臆想"出不存在的任务并报错。
2. **只有一轮 follow-up**：orchestrator 做一次 tool-call 后只能再追问一次 LLM 做总结，无法完成 scan → queue 的多步链路。
3. **7 个工具、schema 深度嵌套**：`TargetSet` 有 10 个字段，`DiscoveredFile` 需要 6 个字段，LLM 极易生成错误参数，导致 Zod 校验失败。
4. **`resolve_processing_targets` 是空壳**：注册了但执行返回占位文本，误导 LLM 调用无效工具。
5. **无非任务对话路径**：没有"不调用工具也正常回复"的设计，任何非任务输入都会触发异常。

### 6.2 重构设计原则

1. **对话优先，工具按需**：LLM 默认作为普通对话助手，只在用户明确表达任务意图时才调用工具。
2. **参数极简**：工具 schema 尽量扁平，LLM 只需提供路径字符串数组等最少信息。
3. **多轮自动循环**：orchestrator 支持最多 5 轮 tool-call 循环，LLM 自动完成 scan → queue 链式操作。
4. **不臆想**：system prompt 明确"信息不足时追问，不要猜测"。

### 6.3 v1 → v2 架构变更

```text
v1 架构（7 工具、单轮 follow-up）:
  用户消息 → LLM(强制 tool-call) → 执行 1 轮 → LLM 总结 → 结束

v2 架构（4 工具、多轮循环）:
  用户消息 → LLM(自由决策)
    ├→ 纯文本回复 → 直接展示，结束
    └→ tool_calls → 执行工具 → 结果送回 LLM → 循环（最多 5 轮）→ 纯文本回复 → 结束
```

### 6.4 文件变更明细

| 文件 | 变更类型 | 说明 |
| --- | --- | --- |
| `src/agent/tool-schemas.ts` | 重写 | 106 → 90 行。7 schema → 4 schema，移除 TargetSet/DiscoveredFile 嵌套 |
| `src/agent/tool-registry.ts` | 重写 | 129 → 100 行。7 工具 → 4 工具（scan + 3 queue） |
| `src/agent/tool-executor.ts` | 重写 | 267 → 298 行。接收 `filePaths: string[]` 替代嵌套对象 |
| `src/agent/orchestrator.ts` | 重写 | 279 → 262 行。对话优先 prompt + 多轮循环 |
| `src/agent/types.ts` | 重写 | 324 → 42 行。移除 20+ 未使用类型 |
| `src/store/agent/useAgentStore.ts` | 重写 | 188 → 64 行。移除 Plan 相关方法 |
| `src/pages/HomeAgent/index.tsx` | 重写 | 329 → 284 行。移除 PlanCard，优化工具结果展示 |
| `src/agent/discovery-engine.ts` | **删除** | 功能内联到 tool-executor.ts |
| `src/agent/filter-rules.ts` | **删除** | 筛选逻辑由 LLM 自然语言能力替代 |
| `src/agent/target-resolver.ts` | **删除** | 目标解析由 LLM + system prompt 承担 |

### 6.5 工具对比

| v1 工具名 | v2 工具名 | 状态 |
| --- | --- | --- |
| `resolve_processing_targets` | - | 删除（空壳 stub） |
| `scan_subtitle_files_in_targets` | `scan_subtitle_files` | 简化 schema |
| `build_processing_candidates` | - | 删除（中间步骤不必要） |
| `apply_candidate_filters` | - | 删除（中间步骤不必要） |
| `queue_subtitle_translate_tasks` | `queue_subtitle_translate` | 简化 schema |
| `queue_subtitle_convert_tasks` | `queue_subtitle_convert` | 简化 schema |
| `queue_subtitle_extract_tasks` | `queue_subtitle_extract` | 简化 schema |

### 6.6 后续待办

- T-021 权限白名单与敏感目录保护仍需实现
- T-023~T-025 测试需基于 v2 架构重新编写
- 手工验证：闲聊不触发工具 / scan+queue 链路 / 错误处理

---

## 7. 每日推进模板（复制使用）

```md
### YYYY-MM-DD

- 今日主任务：T-xxx
- 结果：
  - 完成：
  - 未完成：
- 阻塞：
  - [ ] 是否需要拆分新任务
- 代码变更：
  - `path/a`
  - `path/b`
- 验证：
  - 单测：
  - 手测：
- 明日计划：
```

---

## 8. 任务详情模板（新增任务时使用）

```md
#### T-xxx 任务标题

- 优先级：P0/P1/P2
- 依赖：T-xxx, T-yyy
- 状态：TODO
- 目标：
- 变更范围（文件）：
- 风险点：
- DoD：
  - [ ]
  - [ ]
- 验证方式：
  - [ ] 单元测试
  - [ ] 集成测试
  - [ ] 手工验证
```

---

## 9. 风险前置检查（每个里程碑开始前）

- [ ] 本里程碑是否引入新的权限边界风险
- [ ] 是否需要新增追问文案避免误处理
- [ ] 是否存在兼容旧工具页面的回归风险
- [ ] 是否需要补充 i18n key（zh/en/ja）
- [ ] 是否需要新增 IPC 类型声明（`src/vite-env.d.ts`）

---

## 10. 当前执行建议

v2 重构已完成核心链路，下一步建议：

1. 手工验证 v2 架构的三个核心场景（闲聊 / 扫描+入队 / 错误处理）
2. `T-021` 权限白名单（防止扫描敏感目录）
3. `T-023` 单元测试（基于新的 4 工具 schema）
