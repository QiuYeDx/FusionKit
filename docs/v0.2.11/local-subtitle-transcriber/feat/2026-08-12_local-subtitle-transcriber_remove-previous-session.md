# 删除本地转写“上一会话”功能

## 背景

本地转写页原有“上一会话”模块只展示脱敏诊断摘要，不支持继续、重试、打开产物或重新交接。该模块容易被理解为任务恢复，却不能完成任何后续操作，因此从产品中删除。

## 最终行为

- 本地转写任务只存在当前应用会话的live session中，不持久化或展示历史任务。
- 应用退出、更新、renderer重载或异常终止后，未完成任务不恢复；用户重新选择源文件后从头开始。
- 已原子提交到用户输出位置的SRT/LRC继续保留。
- overwrite recovery与字幕翻译checkpoint属于独立合同，不受本次删除影响。
- 应用升级后，启动清理会删除旧版本遗留的exact`session-summary.v1.json`及其owned temporary，不扫描任意用户路径。

## 实现范围

- 删除`LocalSubtitleRecoveredSession`组件、测试和四语言文案。
- 删除recovered task/batch/session共享类型、IPC schema、renderer reducer/runtime字段。
- 删除main的session-summary repository、测试和Session Registry persistence sink。
- Session snapshot只保留当前会话的`batches`与`resourceJobs`。
- 保留server/media orphan清理，并增加旧摘要文件兼容清理测试。

## 验证

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/services/local-subtitle src/pages/Tools/Subtitle/LocalSubtitleTranscriber
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

- 本地字幕测试：67 passed files / 1256 passed tests，4个opt-in real-native tests按既有条件跳过。
- 四语言键一致：每种语言1783个总键，其中subtitle 622个键。
- 源码i18n引用：1605 calls、1649 resolved keys，全部解析。
- TypeScript与renderer/main/preload三段test build通过；仅有既有dynamic-import与chunk-size warning。
