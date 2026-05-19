# 工作包 RN-003：安全 Apply + Journal

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：未开始  
> 优先级：P0  
> 依赖：RN-001, RN-002

---

## 目标

实现真实重命名执行层，并确保它只执行已生成、已确认、可应用的 plan。执行过程中必须写 journal，支持失败诊断和基础回滚。

---

## 范围

包含：

1. 主进程 `apply-rename-plan`。
2. 主进程 `validate-rename-plan`。
3. 主进程 `rollback-rename-journal`。
4. 两阶段 rename 算法。
5. case-only、swap、目录 rename 路径重写。
6. journal 写入和读取。

不包含：

1. UI 确认弹窗。
2. HomeAgent 确认卡片。
3. AI 翻译。

---

## 主要文件

新增：

- `electron/main/rename/apply.ts`
- `electron/main/rename/journal.ts`
- `electron/main/rename/planner-validation.ts`

修改：

- `electron/main/rename/ipc.ts`
- 必要时扩展 `electron/main/rename/types.ts`

测试：

- `electron/main/rename/apply.test.ts`
- `electron/main/rename/journal.test.ts`

---

## 执行前校验

`validateRenamePlan(plan, items)` 必须检查：

1. plan 未过期。
2. `applyable=true`。
3. 没有 `blocked` 项。
4. 每个 `ready` 项的 `sourcePath` 仍存在。
5. source 类型仍是文件或目录。
6. target parent 仍存在。
7. target 不与外部路径冲突。
8. target basename 合法。
9. 不触及危险目录。
10. 文件系统变化导致的差异应返回 validation error，而不是继续执行。

---

## 两阶段 Rename 算法

执行分两阶段：

1. `sourcePath -> tempPath`
2. `tempPath -> targetPath`

临时名格式：

```text
.fusionkit-renaming-<planId>-<itemShortId>.tmp
```

目录内遇到同名临时文件时应重新生成 suffix，不覆盖。

### 阶段一顺序

1. 目录按 `depthFromRoot` 降序。
2. 文件按路径字典序。

原因：先把深层目录移到临时名，可以降低父目录改名导致子路径失效的概率。

### 阶段二顺序

1. 目录按 `depthFromRoot` 升序。
2. 文件按路径字典序。

执行中维护 `currentPathMap`，每次目录 rename 后重写后续项的 current source/temp/target parent。

---

## Journal 设计

journal 存储路径：

```text
app.getPath("userData")/rename-journals/<journalId>.json
```

接口：

```ts
export async function createRenameJournal(plan, items): Promise<RenameJournal>;
export async function updateJournalOperation(journalId, itemId, patch): Promise<void>;
export async function finishRenameJournal(journalId, status): Promise<void>;
export async function readRenameJournal(journalId): Promise<RenameJournal | null>;
```

每完成一步都要 flush 到磁盘。不要只在内存里维护，应用中途退出时也要能看到最后状态。

---

## 回滚策略

回滚是尽力而为：

1. 只回滚 journal 中 `final_done` 或 `temp_done` 的项。
2. 倒序回滚，降低父目录路径影响。
3. 回滚前校验当前路径存在。
4. 如果目标已被外部移动或修改，标记 `rollback_blocked`。
5. 回滚过程也写回 journal。

不承诺：

1. 外部程序同时修改的路径完全恢复。
2. 失败前未执行的项做任何处理。

---

## IPC 契约

### `validate-rename-plan`

输入：

```ts
interface ValidateRenamePlanParams {
  plan: NameTranslationPlan;
  items: NameTranslationPlanItem[];
}
```

输出：

```ts
interface ValidateRenamePlanResult {
  valid: boolean;
  errors: Array<{ itemId?: string; code: string; message: string }>;
  warnings: string[];
}
```

### `apply-rename-plan`

输入：

```ts
interface ApplyRenamePlanParams {
  plan: NameTranslationPlan;
  items: NameTranslationPlanItem[];
}
```

输出见最终设计文档 14.3。

### `rollback-rename-journal`

输入：

```ts
interface RollbackRenameJournalParams {
  journalId: string;
}
```

输出：

```ts
interface RollbackRenameJournalResult {
  journalId: string;
  successCount: number;
  failedCount: number;
  failures: Array<{ itemId: string; path: string; error: string }>;
}
```

---

## 实施步骤

1. 在 `planner-validation.ts` 实现 apply 前校验。
2. 在 `journal.ts` 实现 journal 文件读写。
3. 在 `apply.ts` 实现两阶段 rename。
4. 在 `ipc.ts` 注册 validate/apply/rollback。
5. 使用临时目录写集成测试：
   - 普通文件 rename。
   - case-only rename。
   - A/B swap。
   - 目录 rename。
   - 父目录和子文件同时 rename。
   - target_exists 阻止。
   - 中途失败后 journal 可读。
   - 回滚可恢复已执行项。

---

## 验收标准

1. apply 只执行 `ready` 项，跳过 `unchanged/skipped`。
2. 校验失败时不执行任何 rename。
3. case-only rename 在 macOS/Windows 上可工作。
4. A/B 互换可工作。
5. 目录 rename 后子项路径不会丢失。
6. 每次执行都会写 journal。
7. 回滚能恢复基础成功项，失败项有明确原因。

---

## 建议验证

```bash
pnpm test -- electron/main/rename
pnpm test
```

手工验证：

1. 用临时目录跑一组包含目录和文件的 plan。
2. 执行后检查路径树。
3. 执行 rollback 后检查路径树。
4. 模拟 target 已存在，确认 apply 被阻止。

---

## 交接说明

RN-003 是整个功能的安全边界。后续 UI 和 Agent 不应直接调用 `fs.rename`，只能通过 `apply-rename-plan`。如果发现 planner 生成的 plan 仍有风险，应在 RN-003 的 validate 阶段阻止，而不是相信上游已经完全正确。

