# 工作包 RN-006：HomeAgent 工具 Schema 与执行器

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：未开始  
> 优先级：P0  
> 依赖：RN-001, RN-002, RN-003

---

## 目标

让 HomeAgent 能通过自然语言创建名称翻译预览 plan，并在用户确认后应用 plan。关键是正确区分「字幕内容翻译」和「文件/文件夹名称翻译」，并保证 Agent 不绕过预览确认。

---

## 范围

包含：

1. 新增 Agent 工具 schema。
2. 新增 Agent 工具注册。
3. 新增 executor：inspect、create plan、apply plan。
4. 更新 system prompt。
5. 更新 Agent 类型以识别 rename 工具结果。

不包含：

1. HomeAgent 预览确认 UI 卡片，这属于 RN-007。
2. 手动工具页。
3. 重命名核心 service 实现。

---

## 主要文件

修改：

- `src/agent/tool-schemas.ts`
- `src/agent/tools.ts`
- `src/agent/tool-executor.ts`
- `src/agent/orchestrator.ts`
- `src/agent/types.ts`
- `src/store/agent/useAgentStore.ts`

可新增：

- `src/agent/name-translation-intent.test.ts`
- `src/agent/name-plan-confirmation.ts`

---

## 新增工具

### `inspect_rename_paths`

用于路径语义不确定时检查路径类型。

Schema 见最终设计文档 10.1。

执行器：

```ts
export async function executeInspectRenamePaths(args: InspectRenamePathsArgs): Promise<ToolExecutionResult>
```

调用 IPC：`inspect-rename-paths`。

### `create_name_translation_plan`

用于生成 dry-run plan。

Schema 见最终设计文档 10.2。

执行器：

```ts
export async function executeCreateNameTranslationPlan(args: CreateNameTranslationPlanArgs): Promise<ToolExecutionResult>
```

调用 RN-002 的 `createNameTranslationPlan`。

返回必须包含：

1. `planId`
2. preview items
3. ready/blocked/skipped/unchanged 统计
4. `requiresConfirmation: true`
5. `executionStatus: "preview_created"`

### `apply_name_translation_plan`

用于应用 plan。

Schema 见最终设计文档 10.3。

执行器：

```ts
export async function executeApplyNameTranslationPlan(args: ApplyNameTranslationPlanArgs): Promise<ToolExecutionResult>
```

要求：

1. 必须检查最近用户消息是否明确确认。
2. 必须检查 plan 是最近创建或当前 pending rename plan。
3. 不受 `auto_execute` 影响，不能自动执行。
4. 调用 RN-003 的 validate/apply。

---

## Prompt 更新重点

在 `buildSystemPrompt()` 中新增第四类能力：

```text
4. Name Translation / Rename: Translate names of files or folders without translating file contents.
```

新增规则：

1. `翻译字幕/字幕内容` 使用字幕内容翻译。
2. `翻译文件名/文件夹名/重命名/改名` 使用名称翻译。
3. 目录路径默认不递归。
4. 文件路径默认只改文件 basename。
5. 说「所在文件夹」才把 root 改成父目录。
6. 说「整条路径」必须追问起始层级。
7. 名称翻译永远先 create plan。
8. 即使 `auto_execute`，rename apply 也必须等确认。

---

## Store 衔接

`useAgentStore` 建议新增：

```ts
pendingNameTranslationPlan: PendingNameTranslationPlan | null;
setPendingNameTranslationPlan(plan: PendingNameTranslationPlan | null): void;
confirmNameTranslationPlan(planId: string): Promise<void>;
dismissNameTranslationPlan(planId: string): void;
```

`PendingNameTranslationPlan`：

```ts
interface PendingNameTranslationPlan {
  planId: string;
  createdAt: number;
  summary: NameTranslationPlanSummary;
  resolvedAction?: "confirm" | "dismiss" | null;
}
```

RN-006 可以只写入 pending 状态，RN-007 再展示 UI。

---

## 确认识别

`apply_name_translation_plan` 不应该仅因为模型调用了工具就执行。实现一个小的确认判断：

```ts
function isExplicitRenameConfirmation(text: string, planId: string): boolean
```

允许：

- 确认执行
- 应用刚才的重命名计划
- 执行这个 plan
- 确认重命名

不允许：

- 看起来不错
- 可以
- 嗯
- 继续

如果不明确，返回错误并让 Agent 提醒用户明确确认。

---

## 实施步骤

1. 在 `tool-schemas.ts` 添加三个 schema 和类型导出。
2. 在 `tool-executor.ts` 添加三个 execute 函数。
3. 在 `tools.ts` 注册三个工具。
4. 更新 `orchestrator.ts` system prompt。
5. 更新 `useAgentStore` pending rename plan 状态。
6. 创建 plan 后写入 pending 状态和 session log。
7. apply 成功/失败后写 session log。
8. 添加 intent/prompt 相关测试，至少覆盖工具区分。

---

## 验收标准

1. `翻译字幕内容` 不会调用 rename 工具。
2. `翻译文件名` 会调用 rename plan 工具。
3. 目录 `里面的文件名` 默认 children/files。
4. `递归/包括子文件夹` 才 descendants。
5. `整条路径` 缺少起始层级时追问。
6. create plan 后不会自动 apply。
7. apply 需要明确确认。
8. `auto_execute` 模式下 rename 仍只创建预览。

---

## 建议验证

```bash
pnpm test -- src/agent
pnpm test
```

手工对话验证：

1. `把 /tmp/a.srt 翻译成中文`
2. `把 /tmp/a.srt 文件名翻译成中文`
3. `把 /tmp/日剧 里面的文件名翻译成英文`
4. `把 /tmp/日剧 递归翻译成英文`
5. `确认执行刚才的重命名计划`

---

## 交接说明

RN-006 完成后，Agent 应能生成 plan，但用户体验仍可能只是普通工具结果 JSON。RN-007 会把这个结果变成可确认的 UI 卡片。不要在 RN-006 里为了省 UI 工作而放宽 apply 确认规则。

