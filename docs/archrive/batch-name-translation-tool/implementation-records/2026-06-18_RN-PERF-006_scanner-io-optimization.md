# 工作包 RN-PERF-006：扫描器 IO 优化与稳定排序

## 基本信息

- 日期：2026-06-18
- 状态：已完成
- 对应执行计划工作包：RN-PERF-006

## 本次实现内容

- 在 `electron/main/rename/scanner.ts` 中新增 Dirent 快路径。
- 普通文件和普通目录直接由 `Dirent` 构造 `PathInfo`，不再对每个目录项额外执行 `lstat` + `stat`。
- symlink 或 Dirent 无法确认类型的目录项仍回退到完整 `getPathInfo`，保留 symlink directory skip 与 other 类型判断。
- 新增有限并发目录扫描队列，默认每批最多处理 32 个目录任务。
- 单目录 entries 也使用有限并发构造 `PathInfo`，并保持 entries 的 `localeCompare` 顺序。
- `buildScanResult` 对最终 targets 按 `(anchorRoot, depthFromRoot, absolutePath)` 排序，避免并发读取影响预览顺序。
- 扩展 scanner 测试，覆盖 Dirent 快路径减少 stat/lstat、重复扫描顺序稳定。

## 修改文件

- `electron/main/rename/scanner.ts`
- `test/rename/scanner.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`

## 接口或数据结构变化

- 无对外 IPC 或 renderer 类型变化。
- `NameTranslationTarget.size`、`modifiedAt` 仍为可选字段；Dirent 快路径下普通目录项不再为了填充这些可选字段额外 stat。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/scanner.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm run i18n:check
pnpm exec tsc --noEmit
```

结果：

- scanner 最小验证：1 file / 12 tests passed。
- rename 与 store 扩展验证：9 files / 66 tests passed。
- `pnpm run i18n:check`：通过，所有 namespace 多语言 key 数一致。
- `pnpm exec tsc --noEmit`：失败于既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 与 `src/components/qiuye-ui/code-block/code-block-root.tsx` 的 `style jsx global` React 类型问题；本次 scanner 改动未出现新的类型错误。

## 未完成事项

- 本包未新增真实目录规模 benchmark；性能回归测试和最终验收记录进入 RN-PERF-007。
- 并发扫描已保持稳定排序，但 maxTargets 截断仍按扫描队列处理到达顺序生效，符合现有“达到上限即截断”的安全口径。

## 下一步建议

- 下一轮认领 RN-PERF-007：新增 fake model 性能回归测试，补充验收记录，并回填 final design / execution plan 中的最终实现状态。
