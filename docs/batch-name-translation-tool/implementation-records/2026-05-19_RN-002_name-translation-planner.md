# 工作包 RN-002：名称翻译 Planner

## 基本信息

- 日期：2026-05-19
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-002_name-translation-planner.md`

## 本次实现内容

- 新增 renderer 侧 rename 类型、路径工具、目标 resolver、plan store、prompt builder、名称清洗、冲突检测和 dry-run planner。
- `createNameTranslationPlan(options)` 会调用 RN-001 的 `scan-rename-targets`，分批使用任务模型生成 `translatedStem`，清洗新名称，生成 `targetPath`，校验冲突，并把完整 plan 缓存在 `namePlanStore`。
- plan summary 只返回 preview 级清单；完整 `items` 通过 `getNameTranslationPlan(planId)` 读取，默认最多保留 10 个 plan，30 分钟过期。
- 名称清洗覆盖非法字符、控制字符、Windows 保留名、空名称、尾部点/空格、basename 长度和扩展名保留。
- 冲突检测覆盖 `unchanged`、`duplicate_target`、`target_exists`、`case_only`、`swap`、`path_too_long`，并支持 `append_index` 稳定自动编号。
- 模型未配置时抛出 `NameTranslationPlannerError`，调用方可直接展示“未配置任务执行模型，请在设置页面配置。”。
- `path_segments` 缺少边界时返回 clarification；有边界时当前仍不可应用，避免在 apply/journal 未完成前误执行路径片段重命名。

## 修改文件

- `src/services/rename/nameTypes.ts`
- `src/services/rename/namePath.ts`
- `src/services/rename/namePlanStore.ts`
- `src/services/rename/nameTargetResolver.ts`
- `src/services/rename/nameTranslationPrompt.ts`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameSanitize.ts`
- `src/services/rename/nameConflict.ts`
- `src/services/rename/nameSanitize.test.ts`
- `src/services/rename/nameConflict.test.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-002_name-translation-planner.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-19_RN-002_name-translation-planner.md`

## 接口或数据结构变化

- 新增 `createNameTranslationPlan(options, deps?)`：
  - 正常业务调用只需要传 `options`。
  - `deps` 用于单元测试或后续集成测试注入 scanner、translator、exists checker。
- 新增 `namePlanStore`：
  - `rememberNameTranslationPlan`
  - `getNameTranslationPlan`
  - `updateNameTranslationPlan`
  - `clearExpiredNameTranslationPlans`
- `NameTranslationPlan` 额外包含完整 `items` 和 `expiresAt`，方便 RN-003 apply 前校验过期状态。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/scanner.test.ts src/services/rename
pnpm build
```

结果：

- rename 相关测试：4 files passed，19 tests passed。
- `pnpm build`：通过；electron-builder 产生 macOS arm64 DMG/zip，构建日志仅保留既有 chunk size warning、package description missing 和未签名提示。

## 未完成事项

- RN-003 需要消费 `NameTranslationPlan` 完成 apply 前复验、两阶段 rename、journal 和回滚。
- RN-004/RN-006 需要接入 `createNameTranslationPlan`，分别服务手动工具页和 HomeAgent。
- `path_segments` 的完整可应用计划仍未开放，应在 apply/journal 顺序确定后再启用。

## 下一步建议

- 下一会话优先认领 RN-003：实现 `electron/main/rename/planner-validation.ts`、`apply.ts`、`journal.ts` 和对应 IPC，使 RN-002 生成的 ready plan 可以安全应用并写 journal。
