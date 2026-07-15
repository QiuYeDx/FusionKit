# 工作包 NT-UX-002：计划警告换行与高风险确认详情

## 基本信息

- 日期：2026-07-15
- 状态：已完成
- 对应执行计划工作包：`NT-UX-002`

## 本次实现内容

- 新增 `riskSummary.ts`，把计划级警告与所有可应用条目的警告聚合为结构化详情，并让警告数量、风险原因、摘要列表和确认弹窗使用同一事实来源。
- 新增共享 `PlanWarningsList`：每条警告显示来源和完整诊断内容，使用可收缩容器、任意位置断词和多行排版，不再把不可信长度字符串放进单行 Badge。
- 应用摘要区展示前 5 条警告，其余数量通过四语言提示引导用户在确认弹窗中完整查看。
- 高风险确认弹窗增加说明、完整警告详情和来源；迁移到 `ScrollableDialog`，固定 Header/Footer，仅滚动中间内容。
- 局部覆盖 Radix ScrollArea viewport 的 table 宽度行为，修复长无空格警告推动指标网格和内容横向裁切的问题。
- 新增稳定 `data-testid`，Electron 场景使用真实临时文件和 Fake Responses API 触发“批次失败 → 拆分重试”警告；只打开并取消确认弹窗，不执行真实重命名。
- 四语言新增警告来源、剩余数量、弹窗说明和警告详情文案；风险原因 union 可被 AST usage checker 静态展开，因此删除过期动态 manifest 条目。
- 新增 `FK-PIT-0020`，记录 Radix ScrollArea 与无空格诊断文本组合导致宽度扩张的项目规则。

## 修改文件

- 页面与组件：`ApplySummaryPanel.tsx`、`RiskConfirmDialog.tsx`、`PlanWarningsList.tsx`、`PathPickerPanel.tsx`、`NameTranslator/index.tsx`。
- 模型与测试：`riskSummary.ts`、`riskSummary.test.ts`、`PlanWarningsList.test.tsx`、`test/e2e.spec.ts`。
- i18n：`src/locales/{zh,zh-Hant,en,ja}/rename.json`、`scripts/i18n-usage-manifest.mjs`。
- 文档：本主题 final design、execution plan、版本入口/台账、`CHANGELOG.md` 与项目 pitfall guard。

## 接口或数据结构变化

- 新增 `RenameWarningDetail`、`RenameRiskReason` 和 `RenameRiskSummary.warningDetails`，均为 renderer 内部展示模型，不改变 Electron IPC 或持久化格式。
- 风险计数只统计计划级警告与 `ready` 条目警告，保持与实际可应用范围一致；blocked 条目仍由既有阻塞规则处理。
- `RiskConfirmDialog` 的确认/取消合同不变，不新增自动应用路径。

## 验证结果

执行命令：

```text
node node_modules/vitest/vitest.mjs run src/pages/Tools/Rename/NameTranslator/riskSummary.test.ts src/pages/Tools/Rename/NameTranslator/components/PlanWarningsList.test.tsx
node node_modules/vitest/vitest.mjs run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts src/pages/Tools/Rename/NameTranslator/riskSummary.test.ts src/pages/Tools/Rename/NameTranslator/components/PlanWarningsList.test.tsx
node node_modules/typescript/bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node node_modules/vite/bin/vite.js build --mode=test
node node_modules/vitest/vitest.mjs run test/e2e.spec.ts -t "name translator wraps warning details and explains them before high-risk apply"
git diff --check
```

结果：

- 定向单元/组件合同：2 files / 4 tests 通过。
- 完整 rename 相关回归：14 files / 172 tests 通过。
- TypeScript 通过。
- 四语言各 1488 keys 对齐，仅保留 9 条既有 same-as-source 提示；usage 扫描 1354 calls / 1382 resolved keys 通过。
- renderer/main/preload test build 通过，仅有既有 dynamic import 和 chunk-size warning。
- Electron 定向 1 passed / 8 skipped；场景覆盖暗色 `786×540`、全局 loading 退出、真实长无空格计划警告、拆分重试警告、摘要区与确认弹窗内容。
- 页面、摘要警告容器、确认弹窗警告区和 ScrollArea viewport 横向溢出断言全部为 false。
- 已人工审查 `test-results/nt-ux-002-warning-summary-786x540.png` 与 `test-results/nt-ux-002-risk-dialog-786x540.png`：指标完整、警告换行、Header/Footer 固定，关键内容未裁切。

## 未完成事项

- 当前保留供应商或模型返回的原始诊断文本，以避免隐藏真实风险；后续如建立稳定错误码合同，可进一步增加面向普通用户的本地化摘要，同时保留技术详情。

## 下一步建议

- 新增或复用任何“诊断/警告详情”组件时，应先复用 `PlanWarningsList` 的可收缩结构，并在 Radix ScrollArea 中验证 viewport 自身的 `scrollWidth`，不能只检查 document。
