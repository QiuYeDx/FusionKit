# 工作包 RN-001：类型与 IPC 扫描能力

## 基本信息

- 日期：2026-05-19
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-001_types-and-ipc-scanning.md`

## 本次实现内容

- 新增 rename 主进程类型定义，覆盖 options、target、inspect/scan/select IPC 入参与出参。
- 新增 rename scanner，支持路径检查、`self`/`children`/`descendants` 目标展开、隐藏项跳过、危险目录过滤、符号链接目录跳过、目标上限截断和稳定 target id。
- 新增 `select-rename-paths`、`inspect-rename-paths`、`scan-rename-targets` IPC 注册，并接入 Electron main 启动流程。
- 新增 scanner 单元测试，覆盖名称拆分、危险目录、路径 inspect、三种扫描 scope、默认跳过规则、截断和 `path_segments` 基础 warning。

## 修改文件

- `electron/main/index.ts`
- `electron/main/rename/types.ts`
- `electron/main/rename/scanner.ts`
- `electron/main/rename/ipc.ts`
- `test/rename/scanner.test.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-001_types-and-ipc-scanning.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-19_RN-001_types-and-ipc-scanning.md`

## 接口或数据结构变化

- 新增 IPC：
  - `select-rename-paths`
  - `inspect-rename-paths`
  - `scan-rename-targets`
- `NameTranslationTarget.extension` 当前使用 `path.parse(name).ext`，保留前导点，例如 `.srt`。
- RN-001 仍不包含翻译、冲突合并、真实 `fs.rename`、journal 或回滚能力。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/scanner.test.ts
pnpm build
```

结果：

- `test/rename/scanner.test.ts`：8 tests passed。
- `pnpm build`：通过；electron-builder 产生 macOS arm64 DMG/zip，构建日志仅保留既有 chunk size warning、package description missing 和未签名提示。

## 未完成事项

- RN-002 需要在 renderer service 中调用 `scan-rename-targets`，并生成 dry-run 名称翻译 plan。
- `path_segments` 在 RN-001 只返回基础 warning，完整层级展开和确认逻辑留给 RN-002。
- 真实 apply、journal 和 rollback 留给 RN-003。

## 下一步建议

- 下一会话优先认领 RN-002：实现 `src/services/rename/nameTargetResolver.ts`、`nameTranslationPlanner.ts`、`namePlanStore.ts`，复用 RN-001 的 scan IPC 作为候选目标来源。
