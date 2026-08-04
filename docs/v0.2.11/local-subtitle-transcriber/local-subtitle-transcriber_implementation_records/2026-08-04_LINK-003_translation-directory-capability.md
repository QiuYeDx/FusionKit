# 工作包 LINK-003：字幕翻译目录 capability 与无路径任务引用

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：LINK-003
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload；不依赖目标 GPU 或 Windows 环境

## 本次认领边界

- 包含：translator-owned 目录选择与 capability registry、task-scoped target handle、generated/legacy 互斥引用、main-only execution adapter、同任务原子重授权、owner/TTL/终态清理和相关测试。
- 不包含：普通页面/Agent 新任务生产者切换、RecoveryDialog/checkpoint 恢复消费者切换、one-shot import token 消费、legacy path 删除；这些继续归 LINK-004、LINK-005 与 LINK-007B。

## 本次实现内容

- 新增独立 `subtitle-translation:*` namespace、固定 `subtitleTranslationApi` 与 document owner session；legacy `window.ipcRenderer` 对整个 namespace fail closed。
- 新增字幕翻译目录 capability registry。main picker 签发只含 token、label、expiry 的 draft authority；draft 原子提升为绑定 owner、taskId、output leaf 与 TTL 的 task target handle 后独立持有。
- 新增严格互斥的 `generated_task_v1` / `legacy_path_v1` task reference schema。generated 分支只有 `generated_content` marker 与 `authorized_directory` opaque target，任何 raw path、混合字段、token/label/fileName 换绑均拒绝。
- main execution adapter 对 generated task 只按 registry authority 解析真实 target；legacy task 统一经过显式 adapter，并拒绝复用 main 已登记的 generated taskId。
- `reauthorizeTaskTarget(taskId)` 先验证同 owner、active task，再打开固定 picker；新目录完整验证与新 handle 提交成功后才撤销旧 handle。失败或取消保留旧 authority，过期 handle 仍允许同 owner 重新授权。
- 目录授权冻结 canonical object identity；启动、checkpoint 前和最终写入前重新校验目录。最终实际 index/overwrite leaf 再做 containment、设备名/分隔符/控制字符/长度与 symlink 检查。
- generated cancel 按 sender 隔离；窗口/reload owner 释放、任务终态和 TTL 到期撤销 task handle。重复 active、配置缺失等执行前拒绝不会误撤销仍可用 handle。
- 保留现有 `originFileURL`、`targetFileURL`、`checkpointPath`、`outputURL` 与历史 `manifest_fragments` 空 source path 兼容行为，没有把任意旧路径升级为 capability。

## 修改文件

- Shared contract：`src/type/subtitleTranslationIpc.ts`、`src/vite-env.d.ts`。
- Preload：`electron/preload/subtitle-translation-api.ts`、`electron/preload/subtitle-translation-channel-policy.ts`、`electron/preload/index.ts`。
- Main registry/IPC：`electron/main/translation/directory-capability.ts`、`electron/main/translation/ipc.ts`、`electron/main/index.ts`。
- Execution write boundary：`electron/main/translation/{typing,translation-service}.ts`、`electron/main/translation/class/{base-translator,srt-translator}.ts`。
- Tests：`test/translation/subtitle-translation-{directory-capability,reference-schema,preload,ipc-service}.test.ts`。

## 接口、状态或数据结构变化

- 新增 `window.subtitleTranslationApi.selectOutputDirectory()`、`revokeOutputDirectory(token)` 与 `reauthorizeTaskTarget(taskId)`；API 不暴露 generic invoke、ownerSessionId 或 raw path。
- 新增 `SubtitleTranslationTaskReference = generated_task_v1 | legacy_path_v1` 严格 runtime schema。
- 新增 `SubtitleTranslationDirectoryCapabilityRegistry` 的 draft authorize/revoke、generated task registration、resolve/revalidate/rotate/terminal/releaseOwner 合同。
- `TranslationService.processTask()` 接受可选 main-only runtime authorization，在生成任务写入前重新验证 target 与实际 output leaf；现有 legacy 调用保持兼容。

## 安全、隐私与许可证检查

- renderer/Store/API response 只看到 token、label、taskId 与 expiry；registry 内的 canonical path/identity 不离开 main。
- preload 内部 channel 不进入 public generic bridge；main 同时验证 fixed channel request、64 KiB secure envelope、trusted sender、frame/session identity 与 owner 当前性。
- capability/token 只驻留内存，不持久化；owner release、终态、TTL 和显式 revoke 都清理 authority。
- 未新增第三方依赖、网络下载、二进制或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/services/subtitle src/store/tools/subtitle src/agent test/translation
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：25 个测试文件 / 141 项测试；TypeScript；renderer/main/preload 三段 Vite test build；diff check。
- Vite 只有既有 chunk-size 与 `useModelStore` 动态/静态 import 提示，无新增构建失败。
- 未运行 Electron 人工 picker/窗口矩阵、packaged 或 Windows 目标机测试；本包为跨平台底层合同，相关产品验证继续归 QA。

## 产生的证据

- 测试和构建输出仅在当前会话终端；未生成需提交的截图、模型或 runtime 资产。
- 未启动 Vite/Electron 常驻服务。

## 未完成事项

- 新 API/refs 尚未切换 SubtitleTranslator 页面、Agent 与 RecoveryDialog；这些消费者继续通过显式 legacy adapter 工作。
- generated checkpoint/recovery 仍等待 LINK-005 的 `checkpointRef` / v2 self-contained manifest cutover。
- LINK-006 one-shot token 尚未由 translator import coordinator 消费；main-private candidate、target handle 所有权转移、完整 receipt 与 cleanup 归 LINK-007B。
- `outputURL`、`originFileURL`、`targetFileURL`、`checkpointPath` 继续保留，不能提前删除。

## 下一步建议

- 进入 LINK-007B：消费 one-shot import token，在 main 创建 path-free candidate、taskId/handoffKey 与 LINK-003 target handle，并接完整 import receipt/release cleanup。
- 随后按 LINK-004 切换普通页面与 Agent 新建任务生产者，再由 LINK-005 迁移 checkpoint/recovery 消费者并最终清理 legacy path。
