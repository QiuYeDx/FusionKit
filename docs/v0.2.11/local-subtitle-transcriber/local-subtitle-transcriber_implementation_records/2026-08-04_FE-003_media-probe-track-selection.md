# 工作包 FE-003：媒体探测与多音轨选择结项

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：`FE-003`
- 目标平台/硬件：跨平台 Renderer 与 Electron main 合同；本轮不声明 packaged 产品或真实 GPU 验收通过

## 本次认领边界

- 包含：逐文件 media probe 摘要、多音轨 Radio、probe readiness、显式 stream selection 的 draft-to-task 生命周期与回归测试。
- 不包含：artifact 内容预览/复制/partial result/error dialog（`FE-004`），以及窄窗口、键盘、cancel race、批量部分授权失败产品态等人工矩阵（`QA-002`）。

## 本次实现内容

- draft 文件严格串行调用 fixed `probeMedia(fileToken)`，防止同一 owner 的 media operation policy 被并发 probe 触发；文件替换、移除、重试与过期 generation 均不会让旧结果覆盖新草稿。
- 文件列表显示大小、时长、音轨数、probe 错误与重试入口；probe pending/failed 时阻止开始。
- 多音轨文件使用真实 `ToolRadioButtonGroup` 交互面，新增向后兼容的纵向布局；默认保持 `auto`，只有用户显式覆盖时才提交 main 签发的 opaque `audioStreamId`。
- 原子 enqueue 在 capability commit 前验证 owner、file token、exact input identity、runtime generation 与 stream id，并把 selected-track proof 提升为 task-owned main record。记录只保留 duration/table signatures 与 selected track，不复制完整音轨表。
- enqueue 回滚释放已创建 binding 并恢复 draft capability；retryable failed task 保留 binding；completed、cancelled、non-retryable failed、remove、owner release 与 shutdown 均释放 binding。
- 四语言补齐媒体探测、音轨、默认选择、失败与 readiness 文案。

## 修改文件

- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/index.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{index,LocalSubtitleDraftMediaList,localSubtitleTranscriberModel}.tsx/ts`
- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`
- 对应 Renderer/main tests 与 `src/locales/{zh,zh-Hant,en,ja}/subtitle.json`
- Final Design、Execution Plan、`FK-PIT-0072` 与本实施记录

## 接口、状态或数据结构变化

- 未新增 IPC channel、持久化字段或 renderer path/selector authority；继续复用 fixed `probeMedia(fileToken)` 与既有 enqueue schema。
- `deriveLocalSubtitleStartIssue()` 新增 `media_probe_loading` / `media_probe_failed` readiness。
- `LocalSubtitleJobManager` 新增 main-only media selection registry 依赖；显式选择在 enqueue 期间从 draft proof 提升为 task authority。
- `ToolRadioButtonGroup` 新增可选 `orientation="vertical"`，默认水平行为不变；Radix item 仍是完整 click/roving-tabindex/arrow/Home/End 交互面。

## 安全、隐私与许可证检查

- renderer 只接收脱敏 probe DTO 与 opaque stream id；未引入 raw path、FFmpeg selector、runtime generation、track signature 或 full track table 持久化。
- task-owned binding 仅驻留 main 内存，并按任务/owner/shutdown 生命周期释放。
- 未新增依赖、native artifact、模型、runtime 或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx src/pages/Tools/Subtitle/LocalSubtitleTranscriber test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：7 files / 142 tests；TypeScript；四语言各 1670 keys 与 source usage；renderer/main/preload 三段 Vite test build；diff check。
- 覆盖：draft LRU 淘汰后 committed selection 仍有效、stale/forged/cross-owner selection、enqueue rollback、retry retention、terminal/remove/owner/shutdown release，以及纵向 Radio 结构。
- Vite 仅报告既有 dynamic-import 与 chunk-size warning。
- 未执行 Electron 人工矩阵；按用户当前开发策略移交 `QA-002`，不阻塞代码工作包结项。
- 本轮未执行 `pnpm`，未修改 `pnpm-lock.yaml`，未启动 Vite/Electron 常驻服务。

## Pitfall 边界

- `FK-PIT-0012`：Radio primitive 保持完整可见交互面，不使用隐藏 item 加外层 label。
- `FK-PIT-0014`：除 locale parity 外同时执行 source usage 检查。
- `FK-PIT-0048`：Electron 三段构建只使用 root `vite build --mode=test`。
- `FK-PIT-0072`：draft probe LRU 不能拥有已提交任务的唯一 selection authority；显式选择必须在原子 enqueue 内提升。

## 未完成事项与风险

- Electron 窄窗口、普通点击/键盘、cancel race 与批量部分授权失败产品态归 `QA-002`。
- 本记录不证明真实 FFmpeg、模型、CUDA/Metal 或 packaged 产品矩阵。

## 下一步建议

- 进入 `FE-004`，优先复用 `readArtifactText()` 的受验证 `rawText/plainText/cueCount` 实现预览与复制，再补 partial format 和错误详情；手动翻译交接只保留入口，实际 coordinator 继续归 `LINK-007`。
