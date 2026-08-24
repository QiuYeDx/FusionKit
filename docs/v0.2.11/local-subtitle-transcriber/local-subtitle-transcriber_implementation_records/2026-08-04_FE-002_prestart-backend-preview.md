# 工作包 FE-002：开始前 backend preview checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：macOS arm64与Windows x64共享IPC/renderer合同；本轮未开放Metal/CUDA production admission或执行目标GPU验证

## 本次实现内容

- 新增fixed public `local-subtitle:preview-backend` channel与`previewBackend({ modelId, devicePreference })` preload方法；不增加generic invoke，也不占用preload-internal channel。
- request严格只允许opaque `modelId`与device preference；result严格只公开`devicePreference`、`resolvedBackend`、`modelId`、`serverArtifactId`和`serverVersion`，拒绝absolute path、model/artifact hash、runtime generation、backend flags及proof字段。
- Job Manager新增只读preview入口，并行解析managed model与owner-bound runtime admission后调用同一main-only backend resolver；返回summary前复核branded proof、preference、runtime generation与model identity。
- preview不解析input/output capability、不reserve lease、不创建ID、不发布batch、不进入队列、不启动带模型server。显式CUDA/Metal在production attestor未接通时继续返回`backend_unverified`，不会显示为CPU fallback。
- pending preview纳入Job Manager的owner/shutdown abort与idle跟踪；owner release或应用关闭会取消并等待只读校验收敛，避免跨过model/runtime teardown顺序。
- LocalSubtitleTranscriber按当前selected ready model与ready runtime请求`auto` preview；request generation与response model/preference identity共同阻止切模型或刷新后的旧响应覆盖。
- preview未就绪、identity不匹配或失败时开始按钮保持关闭；环境区显示main返回的`AUTO -> CPU`及server version。enqueue payload不携带preview结果，开始时仍重新解析并冻结最终proof，以拒绝preview后的model/runtime漂移。
- 四语言补齐解析中、不可用与开始门禁文案；任务提交后继续以batch/task summary的真实`resolvedBackend`为准。

## 修改文件

- `src/type/localSubtitleIpc.ts`
- `electron/preload/local-subtitle-api.ts`
- `electron/main/local-subtitle/job-ipc.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{index.tsx,LocalSubtitleEnvironmentManager.tsx,localSubtitleTranscriberModel.ts}`
- `src/locales/{en,ja,zh,zh-Hant}/subtitle.json`
- IPC/preload/Job Manager/page model与source wiring tests
- Final Design、Execution Plan与本实施记录

## 安全、隐私与职责检查

- renderer不能提交runtime generation、server artifact、path/hash或backend flag，不能从runtime probe自行选择执行backend。
- public summary中的artifact ID与version只用于可见诊断，不是process descriptor或execution proof；enqueue不接受它们。
- preview与enqueue均复核当前owner、managed model、runtime和resolver proof；preview成功不保证稍后的enqueue成功。
- 本地字幕接口仍独立于远端Audio ASR，没有新增`audio:*` channel、远端provider调用或共享任务状态。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/preloadApi.test.ts src/type/localSubtitleIpc.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts
pnpm exec tsc --noEmit
pnpm exec vite build --mode=test
pnpm run i18n:check
git diff --check
```

结果：

- 聚焦6 files / 142 tests通过，覆盖fixed API、strict/path-free contract、无batch publication、`auto -> cpu`、显式Metal fail-closed、owner release pending-preview fence、renderer stale response guard source wiring与开始门禁。
- TypeScript、renderer/main/preload三段Vite test build、四语言locale parity/source usage与diff check通过；build仅有既有dynamic/static import与chunk size warning。
- 本机pnpm为项目预期的8.7.0；未安装依赖、未修改`pnpm-lock.yaml`。
- 未启动Vite/Electron/official server或其他长期服务；未执行视觉QA、真实模型下载、真实Metal/CUDA推理或packaged目标机验证。

## 未完成事项

- Metal/CUDA仍需exact production artifact acquisition、identity-bound positive attestation与Job Manager/Executor admission；不能用renderer probe、stderr或文件名替代。
- 只有真实GPU generation进入production后，才能实现GPU load/OOM/driver/crash后的批次暂停与用户确认CPU新generation；当前CPU-only路径不伪造fallback。
- `FE-002`继续保持进行中，完成上述边界后再进入`FE-003`批量队列。
