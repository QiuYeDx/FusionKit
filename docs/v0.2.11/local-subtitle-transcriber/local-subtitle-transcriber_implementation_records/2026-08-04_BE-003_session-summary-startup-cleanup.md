# 工作包 BE-003：会话摘要、启动清理与资源水位

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：`BE-003`
- 目标平台/硬件：macOS 开发环境；生产合同同时覆盖 Windows recursive cleanup retry

## 本次认领边界

- 包含：path/content-free session summary、非终态重启中断语义、受控 server/media/session-summary temporary 启动清理、资源水位、只读上一会话 UI、当前进程 Windows cleanup retry。
- 不包含：任意用户输出目录扫描、artifact authority 恢复、任务断点续跑、真实 crash/强杀/OOM/disk-full、Electron 人工矩阵或 packaged 验收。

## 本次实现内容

- 新增固定 `<userData>/local-subtitle/session-summary.v1.json` 的 strict private repository。root 使用 `0700`，temporary 使用 `0600`，写入经过 fsync、atomic rename 与 parent sync；无效 manifest fail closed 且不改写原文件。
- 仅在任务语义状态变化时持久化匿名摘要。display name 生成 `media-task-<n>.<ext>`，落盘字段限制为 task/batch id、generation、状态/阶段、格式、backend/build、时间、稳定 error code、artifact 格式状态和数值 RSS/heap/disk watermarks。
- 明确排除 source/output/model/temp path、token、capability、model hash、artifact ref、字幕正文、segment/word、命令、prompt 与诊断文本。
- 启动读取时将非终态 task 映射为 `interrupted + runtime_crashed`，保留 terminal 摘要；公开 recovered-session schema 与 UI 不提供 reveal、handoff、retry 或重新授权入口。
- 将启动清理扩展到 exact `temp/server-*`、`temp/media/media-*` 与 session-summary temporary。清理前后校验受控 root、containment 和目录对象 identity；未知叶名、symlink、replacement 与成功 artifact 均保留。
- 为当前进程 server/media 递归清理补充 Windows `maxRetries=5`、`retryDelay=200ms`，降低 delete-pending 导致的瞬态失败。

## 修改文件

- `electron/main/local-subtitle/session-summary.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `electron/main/local-subtitle/resource-startup-cleaner.ts`
- `electron/main/local-subtitle/server-session.ts`
- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/index.ts`
- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `src/services/local-subtitle/localSubtitleSessionReducer.ts`
- `src/services/local-subtitle/localSubtitleRuntimeService.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleRecoveredSession.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/locales/{zh,en,ja,zh-Hant}/subtitle.json`
- `test/local-subtitle/sessionSummary.test.ts`
- `test/local-subtitle/resourceStartupCleaner.test.ts`
- `test/local-subtitle/sessionRegistry.test.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleRecoveredSession.test.tsx`

## 接口、状态或数据结构变化

- `LocalSubtitleSessionSnapshot` 新增可选 `recoveredSession`，只承载上一会话的公开诊断摘要。
- 新增 recovered task/batch 的 terminal-or-interrupted 状态合同；`interrupted` 强制使用稳定错误码 `runtime_crashed`。
- 新增 main-private `LocalSubtitleSessionSummarySink`，由 Session Registry 在语义状态变更后 best-effort capture；持久化失败不得破坏 live task authority。
- 启动清理结果新增 session-summary temporary、server session 与 media session 删除计数。

## 安全、隐私与许可证检查

- 路径/capability：manifest 与公开 snapshot 均无 path、token、capability、artifact ref；启动清理只从固定受控 root 和 exact leaf pattern 派生目标。
- 日志/持久化：只保存匿名 label、稳定 code 和数值水位，不保存字幕、媒体内容、命令、prompt、diagnostic text 或 credential。
- 第三方来源与许可：无新增第三方依赖或二进制。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run test/local-subtitle/sessionSummary.test.ts test/local-subtitle/resourceStartupCleaner.test.ts test/local-subtitle/sessionRegistry.test.ts test/local-subtitle/serverSession.test.ts test/local-subtitle/mediaNormalizer.test.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/services/local-subtitle/localSubtitleSessionReducer.test.ts src/services/local-subtitle/localSubtitleRuntimeService.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleRecoveredSession.test.tsx src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：TypeScript；11 test files / 199 tests；四语言各 1706 keys；i18n source usage 1534 calls / 1593 resolved keys；renderer/main/preload 三段 Vite test build；diff check。
- 构建仅出现仓库既有 dynamic-import/chunk-size warning。
- 未运行及原因：真实 crash/强杀/OOM/disk-full、app quit/update 和 Electron 人工矩阵需要专门运行环境，留给 QA；本包不以 fake 测试替代该证据。
- 真实硬件/packaged 范围：未声明。

## 产生的证据

- 实施记录：本文件。
- 未启动 Vite/Electron 前端服务，无需清理服务进程；未修改 `pnpm-lock.yaml`。

## 未完成事项与风险

- 重启摘要有意不恢复 artifact registry、reveal/handoff/retry authority；用户需要重新选择已生成字幕再进入翻译流程。
- 任意用户输出目录中的 crash orphan `.partial` 不在启动扫描范围；未来若要回收，必须新增 main-only、用户授权的 cleanup receipt。
- 真实 Windows Defender delete-pending、强杀时点和资源水位极值仍由 QA/目标环境验证。

## 下一步建议

- 实施 `LINK-006`，把当前 session 的已验证 artifact ref 转换为 owner-bound、短 TTL、one-shot 的内容快照 token；本包不得读取字幕翻译 Store、创建 taskId/handoffKey 或 target handle。
- 随后实施 `LINK-007` 的 translator-owned配置快照与导入协调器，再完成 `FE-004` 手动交接入口。
