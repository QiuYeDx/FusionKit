# 工作包 RN-002：名称翻译 Planner

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：已完成
> 优先级：P0  
> 依赖：RN-001

---

## 目标

实现 dry-run plan 生成链路。输入用户选择的路径与范围配置，输出 `NameTranslationPlan`：包含候选目标、AI 翻译后的新名称、冲突状态、跳过原因、预览摘要和 `planId`。此工作包仍然不修改文件系统。

---

## 范围

包含：

1. 新增 renderer 侧 rename service。
2. 调用 RN-001 的 `scan-rename-targets`。
3. 使用任务模型配置翻译名称。
4. 生成并缓存完整 plan。
5. 返回 preview 级摘要给 UI 和 Agent。
6. 实现名称清洗、非法字符处理、冲突检测、自动编号策略。

不包含：

1. 真实 apply。
2. journal 与 rollback。
3. HomeAgent 工具注册。
4. 页面 UI。

---

## 主要文件

新增：

- `src/services/rename/nameTypes.ts`
- `src/services/rename/namePlanStore.ts`
- `src/services/rename/nameTranslationPrompt.ts`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameConflict.ts`
- `src/services/rename/nameSanitize.ts`

可新增测试：

- `src/services/rename/nameConflict.test.ts`
- `src/services/rename/nameSanitize.test.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`

---

## 核心接口

### `createNameTranslationPlan`

```ts
export async function createNameTranslationPlan(
  options: NameTranslationOptions
): Promise<NameTranslationPlanSummary>
```

返回给 UI/Agent 的 summary 需要轻量：

```ts
interface NameTranslationPlanSummary {
  planId: string;
  totalTargets: number;
  previewLimit: number;
  itemsPreview: NameTranslationPlanItem[];
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: string[];
  clarificationRequired?: ClarificationRequired;
  applyable: boolean;
}
```

完整 items 保存在 `namePlanStore`，通过 `planId` 读取。

### `namePlanStore`

```ts
export function rememberNameTranslationPlan(plan: NameTranslationPlan): string;
export function getNameTranslationPlan(planId: string): NameTranslationPlan | null;
export function updateNameTranslationPlan(plan: NameTranslationPlan): void;
export function clearExpiredNameTranslationPlans(): void;
```

要求：

1. 默认保留最近 10 个 plan。
2. plan 默认 30 分钟过期。
3. 过期后 apply 必须失败并提示重新生成。

---

## AI 翻译策略

不要让 HomeAgent 自己生成文件名翻译结果。Planner 应使用任务模型配置，即 `useModelStore.getState().getTaskProfile()`。

每批输入模型的数据：

```ts
interface NameTranslationModelInputItem {
  id: string;
  kind: "file" | "directory";
  originalName: string;
  stem: string;
  extension: string;
  contextPath?: string;
}
```

模型输出：

```ts
interface NameTranslationModelOutputItem {
  id: string;
  translatedStem: string;
  confidence?: "high" | "medium" | "low";
  note?: string;
}
```

提示词必须强调：

1. 只翻译自然语言部分。
2. 保留季集编号、年份、分辨率、编码、字幕组 tag。
3. 不输出扩展名，扩展名由程序拼回。
4. 不输出解释文本。
5. 不输出 `/`、`\`、`:` 等非法文件名字符。

---

## 名称清洗规则

在 `nameSanitize.ts` 中实现：

1. 去除首尾空白。
2. 替换跨平台非法字符：`/ \ : * ? " < > |`。
3. 去除控制字符。
4. Windows 保留名加后缀或标记 blocked：`CON`、`PRN`、`AUX`、`NUL`、`COM1` 等。
5. 避免名称为空。
6. 避免名称以点或空格结尾。
7. 控制 basename 长度，超长标记 blocked 或截断后 warning。
8. `preserveExtension=true` 时，只拼接原扩展名。

---

## 冲突检测

在 `nameConflict.ts` 中实现：

```ts
export function validatePlanItems(
  items: NameTranslationPlanItem[],
  options: NameTranslationOptions
): NameTranslationPlanItem[]
```

检测：

1. `unchanged`
2. `invalid_name`
3. `duplicate_target`
4. `target_exists`
5. `case_only`
6. `swap`
7. `path_too_long`

默认 `collisionPolicy=fail`，冲突标记 `blocked`。

当 `collisionPolicy=append_index` 时：

1. 对同目录同名项追加 ` (1)` 或 `_1`，需要与命名风格一致。
2. 自动编号后仍需再次检测 target exists。
3. 编号应稳定，按原路径排序。

---

## `path_segments` 处理

RN-002 需要完成 plan 级别的 `path_segments` 基础支持：

1. 如果缺少 `pathSegmentStartPath`，返回 `clarificationRequired`，`applyable=false`。
2. `pathSegmentStartPath` 不允许是根目录、Home 根目录、`/Users` 等危险路径。
3. 目标集合由 `startPath` 到 `endPath` 之间的目录 basename，加上可选文件 basename 组成。
4. 预览中保留层级顺序与 warnings。

如果实现复杂度过高，可以先把 `path_segments` 标记为不可应用，并在 RN-008 记录为 Phase 4，但必须不误执行。

---

## 实施步骤

1. 新建 renderer 侧类型文件，并与设计文档的数据模型保持一致。
2. 新建 `namePlanStore.ts`。
3. 新建 `nameSanitize.ts` 和 `nameConflict.ts`，先完成纯函数测试。
4. 新建 `nameTranslationPrompt.ts`，封装提示词构造。
5. 新建 `nameTranslationPlanner.ts`：
   - 校验模型配置。
   - 调 IPC 扫描 targets。
   - 分批调用模型。
   - 合并翻译结果。
   - 清洗新名称。
   - 生成 targetPath。
   - 运行冲突检测。
   - 写入 plan store。
   - 返回 summary。
6. 对模型异常、缺项、重复 id 做重试或 blocked。

---

## 验收标准

1. 调用 planner 不修改文件系统。
2. 能为文件 self、目录 children、目录 descendants 生成 plan。
3. 扩展名默认保留。
4. 冲突项不能 apply。
5. 同名自动编号策略稳定。
6. 大 plan 只返回 preview，完整 items 可通过 `planId` 读取。
7. 模型未配置时返回清晰错误。

---

## 建议验证

```bash
pnpm test -- src/services/rename
pnpm test
```

手工验证：

1. 使用 mock 或临时模型结果测试日文/英文/中文名称。
2. 构造两个文件翻译成同名，确认 blocked。
3. 构造 `append_index`，确认生成稳定编号。
4. 构造非法字符输出，确认被清洗或阻塞。

---

## 交接说明

RN-002 完成后，RN-003 应只消费 `NameTranslationPlan`，不再重新翻译或重新决定 targetPath。RN-004 和 RN-006 都应通过同一个 planner 创建预览，避免手动工具和 Agent 出现两套行为。

---

## 实施结果

- 完成日期：2026-05-19
- 实施记录：`docs/batch-name-translation-tool/implementation-records/2026-05-19_RN-002_name-translation-planner.md`
- 关键文件：
  - `src/services/rename/nameTypes.ts`
  - `src/services/rename/namePlanStore.ts`
  - `src/services/rename/nameTargetResolver.ts`
  - `src/services/rename/nameTranslationPlanner.ts`
  - `src/services/rename/nameTranslationPrompt.ts`
  - `src/services/rename/nameSanitize.ts`
  - `src/services/rename/nameConflict.ts`
  - `src/services/rename/namePath.ts`
  - `src/services/rename/*.test.ts`
- 验证：
  - `pnpm exec vitest run test/rename/scanner.test.ts src/services/rename`
  - `pnpm build`
- 说明：
  - `path_segments` 缺少边界时返回 `clarificationRequired`。
  - 有边界的 `path_segments` 当前仍生成不可应用预览，完整路径片段重命名顺序留给后续阶段，避免误执行高风险路径变更。
