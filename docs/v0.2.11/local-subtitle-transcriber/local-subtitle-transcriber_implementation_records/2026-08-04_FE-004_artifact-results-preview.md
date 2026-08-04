# 工作包 FE-004：Artifact 结果与预览 checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-004`
- 目标平台/硬件：跨平台 Renderer 与既有 fixed artifact API；本轮不声明 packaged 产品或真实 Electron 人工验收通过

## 本次认领边界

- 包含：按格式 full/partial result、artifact 分页预览、纯文本复制、逐 artifact reveal、结构化错误详情和长内容横向约束。
- 不包含：手动翻译交接 authority/coordinator（`LINK-006`/`LINK-007`）、更完整会话诊断来源（`BE-003`）、Electron overflow/artifact-expiry/copy-failure 人工矩阵（`QA-002`）。

## 本次实现内容

- completed task 不再只展示单个 SRT，而是按请求格式展示 `full` / `partial` 及每项 `committed` / `failed` / `skipped`；成功 artifact 分别提供预览与 reveal。
- 新增 artifact preview `ScrollableDialog`。只消费 fixed `readArtifactText(artifactRef)` 返回的 validated `rawText/plainText/cueCount`，renderer 不解析 SRT/LRC，也不以正则剥离时间轴。
- raw preview 以每页 12,000 字符限制 DOM 内容，Header/Footer 固定，支持上一页/下一页；复制操作使用完整 `plainText`，不受当前预览页影响。
- 新增 error details `ScrollableDialog`，展示 message/code/stage/retryable/field/cause 以及 main 已脱敏且有界的 diagnostic summary/lines/metadata/truncated 状态。
- 两个 dialog 都收紧 Radix ScrollArea viewport 的内部 wrapper，并对运行时文本使用 `min-w-0`、`max-w-full`、`whitespace-pre-wrap` 与 `overflow-wrap:anywhere`，防止无断点诊断制造内部横向溢出。
- `handoffArtifact` 当前在 main 按合同返回 `configuration_not_ready`；本 checkpoint 不暴露一个必然失败的用户按钮。

## 修改文件

- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleTaskQueue.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleTaskDetailsDialogs.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{LocalSubtitleTaskDetailsDialogs,localSubtitleTranscriberPage}.test.ts(x)`
- `src/locales/{zh,zh-Hant,en,ja}/subtitle.json`
- Final Design、Execution Plan 与本实施记录

## 接口、状态或数据结构变化

- 未新增 IPC channel、domain schema、Store 字段或持久化数据；复用 `readArtifactText()` / `revealArtifact()` 与 task completion schema。
- `LocalSubtitleTaskQueue` 的 artifact action 从 task-level 单 SRT 改为显式接收 `GeneratedSubtitleArtifactSummary`，支持 SRT/LRC 独立操作。
- 新增纯函数 `createLocalSubtitleArtifactPreviewPage()`，只负责有界字符串分页，不解释字幕语义。

## 安全、隐私与许可证检查

- dialog 不接收 raw path、token、命令、header 或未脱敏 stderr；artifact ref 只交给 fixed preload 方法。
- 复制内容来自 main shared parser 生成并经 schema 验证的 `plainText`，renderer 不产生第二套解析语义。
- 未新增依赖、runtime、模型、native artifact 或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/mediaNormalizer.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：8 files / 145 tests；TypeScript；四语言各 1701 keys 与 source usage；renderer/main/preload 三段 Vite test build；diff check。
- preview pagination 覆盖越界 page、默认 page size 与无内容丢失；page wiring 检查 fixed API、ScrollableDialog、clipboard 和 viewport containment。
- Vite 仅报告既有 dynamic-import 与 chunk-size warning。
- 未运行 Electron 人工矩阵；按当前开发策略移交 `QA-002`，不阻塞本代码 checkpoint。
- 本轮未执行 `pnpm`，未修改 `pnpm-lock.yaml`，未启动 Vite/Electron 常驻服务。

## Pitfall 边界

- `FK-PIT-0003`：长预览和诊断均使用项目 `ScrollableDialog`，不直接拼 shadcn Dialog 或手写滚动容器。
- `FK-PIT-0014`：新增四语言文案同时执行 locale parity 与 source usage。
- `FK-PIT-0020`：长诊断使用 block wrapping surface，并约束 ScrollArea viewport 内部 wrapper。
- `FK-PIT-0048`：三段 Electron build 只运行 root `vite build --mode=test`。

## 未完成事项与风险

- `LINK-006`/`LINK-007`完成 one-shot import token 和 translator-owned coordinator 后，再开放手动“一键送入字幕翻译”入口及状态。
- `BE-003`继续提供会话摘要、资源水位、启动清理与更完整诊断来源。
- artifact expiry、clipboard denial、超长真实 diagnostics 与窄窗口内部 overflow 仍归 `QA-002`人工矩阵。

## 下一步建议

- 优先进入 `BE-003`，补齐 FE-004 依赖的会话摘要/诊断来源；之后按 `LINK-006` → `LINK-007` 顺序接通手动交接，避免 renderer 直接消费尚不存在的 import authority。
