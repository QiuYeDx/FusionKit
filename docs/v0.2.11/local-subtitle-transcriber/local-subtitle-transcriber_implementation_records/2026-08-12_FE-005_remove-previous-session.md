# 工作包 FE-005：删除上一会话功能

## 基本信息

- 日期：2026-08-12
- 状态：已完成
- 对应执行计划工作包：FE-005

## 本次实现内容

- 删除上一会话只读UI、i18n文案、共享recovered schema和renderer状态传递。
- 删除main进程session-summary持久化repository、Session Registry sink与对应测试。
- 将启动清理器改为删除旧版本exact summary和owned temporary，同时保留server/media orphan清理。
- 更新Final Design、Execution Plan和预发布说明，使当前产品合同明确为“不保存、不展示、不恢复本地转写历史”。

## 修改文件

- `electron/main/index.ts`
- `electron/main/local-subtitle/{session-registry,resource-startup-cleaner}.ts`
- `src/type/{localSubtitle,localSubtitleIpc}.ts`
- `src/services/local-subtitle/{localSubtitleSessionReducer,localSubtitleRuntimeService}.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/locales/{zh,en,ja,zh-Hant}/subtitle.json`
- 相关tests与本功能文档
- 删除`electron/main/local-subtitle/session-summary.ts`、`LocalSubtitleRecoveredSession*`与`sessionSummary.test.ts`

## 接口或数据结构变化

- `LocalSubtitleSessionSnapshot`删除可选`recoveredSession`字段。
- 删除`LocalSubtitleRecovered*`类型与`localSubtitleRecoveredSessionSummarySchema`。
- `LocalSubtitleSessionRegistry`不再接收summary sink，也不在任务语义变化时写磁盘。
- startup cleanup result将旧temporary计数改为`removedLegacySessionSummaryFiles`，同时覆盖正式legacy summary与owned temporary。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle/resourceStartupCleaner.test.ts test/local-subtitle/sessionRegistry.test.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/services/local-subtitle/localSubtitleSessionReducer.test.ts src/services/local-subtitle/localSubtitleRuntimeService.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts
node_modules/.bin/vitest run test/local-subtitle src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/services/local-subtitle src/pages/Tools/Subtitle/LocalSubtitleTranscriber
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 定向回归7 files / 147 tests通过。
- 扩大本地字幕回归67 passed files / 1256 passed tests；4个opt-in real-native tests按既有条件跳过。
- TypeScript通过；四语言各1783总键、subtitle各622键；1605个i18n calls与1649个resolved keys全部解析。
- renderer/main/preload三段test build通过；只有既有dynamic-import与chunk-size warning。
- 未启动Vite/Electron前端服务，未执行pnpm命令，`pnpm-lock.yaml`未修改。

## 未完成事项

- 无FE-005代码未完成项。
- packaged升级后旧摘要文件的真实用户目录清理由后续QA产品矩阵确认；组件测试已覆盖exact正式文件、owned temporary和未知近似文件保留。

## 下一步建议

- `QA-001`继续扩大Audio/Subtitle/Agent回归；`QA-002`验证Electron宽窄窗口与任务取消/交接竞态。
