# 名称翻译子项范围空预览修复

> 日期：2026-06-22  
> 类型：fix  
> 范围：手动名称翻译工具的范围切换、目标扫描与空结果反馈

## 背景与现象

选择一个包含文件的目录后：

- “所选名称”可以正常生成目录本身的预览。
- 切换到“直接子项”或“递归子项”后，生成的预览表为空。
- “路径片段”虽然出现在手动页中，但当前实现始终返回延期状态，无法形成可应用计划。
- 扫描结果为零时，页面没有直接解释范围、目标类型或深度参数是否匹配。

## 根因

1. 目录首次加入时，store 会为 `scope=self` 自动推断 `targetKind=directories`。
2. 切换到 `children` / `descendants` 时，旧的 `targetKind=directories` 被原样保留；目录中的文件因此全部被扫描器过滤。
3. renderer 与 planner 对 `scope`、`recursive`、`includeRoot`、`maxDepth` 各自归一化，主进程扫描器只做数值截断。旧的 `maxDepth=0` 到达 `children` 时会在读取目录前提前返回；到达 `descendants` 时也可能阻止进入子目录。
4. 增删混合文件与目录时，仅第一次选择会重新推断目标类型，后续选区变化可能继续使用过期类型。
5. `path_segments` 尚未实现边界输入和路径级重命名顺序，却被当作正常手动选项展示。

## 修复后的行为

- 文件夹从“所选名称”切换到“直接子项”或“递归子项”时，默认目标类型切换为“文件”。
- 用户在子项范围中手动选择“文件夹”或“全部”后，在“直接子项”和“递归子项”之间切换会保留该显式选择。
- 切回“所选名称”时，根据当前选区重新推断文件、文件夹或全部。
- 增删混合路径时，自动推断值会随选区更新；用户显式选择的目标类型不会被无条件覆盖。
- renderer/planner 使用同一个范围归一化函数；主进程扫描器再次做独立防御性归一化：
  - `self` 固定 `maxDepth=0`。
  - `children` 固定 `maxDepth=1`。
  - `descendants` 对残留的 `0/1` 深度恢复为默认深度 `5`。
- 没有匹配目标时，扫描结果包含诊断 warning，预览区域和 toast 都会明确提示调整范围、目标类型或递归深度。
- 手动页暂不展示未完成的“路径片段”；HomeAgent 仍保留 clarification/deferred 安全防护，待 Phase 4 完成后再开放。

## 影响文件

- `electron/main/rename/scanner.ts`
- `src/services/rename/nameTypes.ts`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/locales/{zh,zh-Hant,en,ja}/rename.json`
- `test/rename/scanner.test.ts`
- `src/store/tools/rename/useNameTranslatorStore.test.ts`
- `docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`

## 测试覆盖

新增回归场景：

1. 带有残留 `maxDepth=0` 的直接子项请求仍能扫描第一层文件。
2. 带有残留 `maxDepth=0`、`recursive=false` 的递归请求仍能扫描多层文件。
3. 目标类型没有匹配项时返回明确诊断 warning。
4. 目录从 `self` 切换到 `children` / `descendants` 时默认扫描文件。
5. 子项范围间切换保留用户显式选择的目标类型。
6. `self` 范围中继续加入混合文件和目录后，目标类型更新为 `both`。

## 验证结果

```text
pnpm exec vitest run test/rename/scanner.test.ts
结果：16 tests passed

pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts
结果：12 tests passed

pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts src/agent/tool-schemas.test.ts
结果：12 test files passed，165 tests passed

pnpm run i18n:check
结果：zh / en / ja / zh-Hant 全部通过，共 771 keys

pnpm exec vite build --mode=test
结果：renderer、main、preload 全部构建成功；仅保留既有 chunk size / mixed import 警告

pnpm exec tsc --noEmit
结果：本次改动未新增类型错误；命令仍被两个既有 styled-jsx 类型错误阻塞：
- src/components/qiuye-ui/code-block/code-block-panel.tsx:300
- src/components/qiuye-ui/code-block/code-block-root.tsx:590

git diff --check
结果：通过
```

## 后续建议

- Phase 4 实现 `path_segments` 时，必须同时提供手动页起止边界输入、路径包含关系校验、目录重写顺序测试和 apply/rollback 集成测试，再恢复该入口。
- 可后续把主进程与 renderer 的范围归一化契约抽成跨进程共享模块，进一步消除重复实现；当前保留主进程独立归一化是为了防御旧 renderer 或直接 IPC 请求。
