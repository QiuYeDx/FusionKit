# 工作包 RN-PERF-002：Store/UI 规划进度与取消入口

## 基本信息

- 日期：2026-06-17
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md` 中的 `RN-PERF-002`

## 本次实现内容

- 在名称翻译 store 中新增 `planningProgress` 状态和 `cancelPlanning` action。
- `createPreview` 创建 `AbortController`，向 planner 传入 `progress` callback 和 `signal`。
- 通过 request id 防止取消后 late planner result 覆盖当前状态或提交半成品 plan。
- `reset` 会取消当前 planning request，避免重置后旧异步结果回写。
- planner 增加 abort 检查，在阶段边界取消并上报 `cancelled`，防止取消后继续写入 plan store。
- 工具页将 `planningProgress` 传入预览表。
- 预览表新增生成预览进度面板，展示阶段、目标/批次计数、进度条和取消按钮。
- 取消后保留用户已选路径和 options，不写入新 plan。
- 补齐中英日繁 `rename` 文案。
- 补充 store 和 planner 测试，覆盖 progress commit、取消后忽略 late result、planner abort 不写入 plan store。

## 修改文件

- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/store/tools/rename/useNameTranslatorStore.test.ts`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `src/locales/zh/rename.json`
- `src/locales/en/rename.json`
- `src/locales/ja/rename.json`
- `src/locales/zh-Hant/rename.json`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`
- `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-002_store-ui-progress-cancel.md`

## 接口或数据结构变化

- `useNameTranslatorStore` 状态新增：
  - `planningProgress: NameTranslationPlanningProgress | null`
- `useNameTranslatorStore` action 新增：
  - `cancelPlanning(): void`
- `PlanPreviewTable` props 新增：
  - `planningProgress`
  - `onCancelPlanning`
- `rename.json` 新增：
  - `preview.planning.*`
  - `messages.planning_cancelled`

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts
```

结果：

- 通过：2 个测试文件，17 个测试。

执行命令：

```text
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
```

结果：

- 通过：7 个测试文件，49 个测试。

执行命令：

```text
pnpm run i18n:check
```

结果：

- 通过：四种语言所有 namespace 键数量一致，未发现缺失。

执行命令：

```text
pnpm exec tsc --noEmit
```

结果：

- 未通过，失败点仍为既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 和 `src/components/qiuye-ui/code-block/code-block-root.tsx` 中 `<style jsx global>` 属性类型问题，和本工作包改动无关。

## 未完成事项

- 尚未实现翻译 key 去重、快路径跳过和内存缓存。
- 尚未实现受控并发翻译。
- 尚未把进度显示接入 HomeAgent 工具调用卡片。

## 下一步建议

- 下一次优先认领 `RN-PERF-003`，减少模型请求数量：实现翻译 key 去重、快路径和 renderer 内存缓存。

