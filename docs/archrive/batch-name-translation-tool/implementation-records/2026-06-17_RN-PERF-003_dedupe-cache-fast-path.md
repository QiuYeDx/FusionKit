# 工作包 RN-PERF-003：翻译去重、快路径与内存缓存

## 基本信息

- 日期：2026-06-17
- 状态：已完成
- 对应执行计划工作包：RN-PERF-003

## 本次实现内容

- 新增 renderer 内存翻译缓存，支持 TTL、容量淘汰、默认全局缓存和测试清理入口。
- 新增高置信快路径分类，覆盖空白、纯数字/日期、ASCII 季集号、纯技术 token、纯符号等无需模型翻译的名称。
- 在 planner 翻译前增加 `classifying` 阶段，将扫描目标转换为 translation work items。
- 使用 translation key 对相同 stem 与相同翻译配置的目标去重，模型只请求一次，再 fan-out 到所有 target id。
- 缓存命中和快路径结果直接写入 translation map，不进入模型请求。
- 模型返回后写入缓存，后续同会话相同配置可复用 translated stem。
- progress 和 metrics 补充 `translatableCount`、`cacheHitCount`、`fastPathCount`、`translationCacheHitCount`、`translationFastPathCount`。

## 修改文件

- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationCache.ts`
- `src/services/rename/nameTranslationFastPath.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `src/services/rename/nameTranslationCache.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`

## 接口或数据结构变化

- `CreateNameTranslationPlanDeps` 新增可选 `translationCache?: NameTranslationCache`。
- 新增 `NameTranslationCache`、`NameTranslationCacheEntry`、`MemoryNameTranslationCache`。
- 默认缓存 key 不包含完整路径，也不包含 `outputMode`、`bilingualSeparator` 等本地重组配置。
- 快路径输出通过 `model_note:fast_path:<reason>` 保留可诊断 warning。

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/services/rename/nameTranslationCache.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm run i18n:check
pnpm exec tsc --noEmit
```

结果：

- `src/services/rename/nameTranslationPlanner.test.ts` 与 `src/services/rename/nameTranslationCache.test.ts`：2 files / 17 tests passed。
- rename 相关扩展测试：8 files / 55 tests passed。
- `pnpm run i18n:check`：通过，所有 namespace 多语言 key 数一致。
- `pnpm exec tsc --noEmit`：失败于既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 与 `src/components/qiuye-ui/code-block/code-block-root.tsx` 的 `style jsx global` React 类型问题；本次新增 rename 文件未出现新的类型错误。

## 未完成事项

- 本包仍保留原有串行批次策略；受控并发、限流退避、错误分类细化放入 RN-PERF-004。
- 快路径刻意保守，后续如果要扩展目标语言识别，需要先补误判测试。

## 下一步建议

- 下一轮认领 RN-PERF-004：实现受控并发翻译、错误分类、429 退避和更细 abort 语义。
