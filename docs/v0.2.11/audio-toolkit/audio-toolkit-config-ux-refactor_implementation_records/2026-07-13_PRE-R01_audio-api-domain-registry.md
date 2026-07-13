# 工作包 PRE-R01：音频 API 领域类型与 Provider Registry

## 基本信息

- 日期：2026-07-13
- 状态：已完成
- 对应执行计划工作包：`PRE-R01`

## 本次实现内容

- 建立独立音频 API 领域类型：provider preset、transport、provider-neutral TTS mode、route、profile、assignment、verification 与 legacy migration metadata。
- 保留旧 `AudioApiDialect`、`MimoSpeechSynthesisMode`、`AudioModelProfile` 和 assignment alias，确保后续迁移期间现有 IPC/adapter 持续可编译。
- 新增无 UI 副作用的 Provider Registry，统一 OpenAI、MiMo、自定义 OpenAI-compatible 的默认 route、endpoint strategy 和字段/格式/stream constraints。
- 提供默认 route 安全 clone、任务 eligibility、可用 TTS mode、route resolution 和 legacy provider 推导 helper。
- 把设置页、SpeechSynthesizer config、MiMo adapter 的 MiMo 三模式 model 映射收敛到 Registry 单一事实来源。
- 扩展音频 endpoint canonicalization，支持 `/responses` 并移除完整 endpoint 的 query/hash。
- 固定 v4/v5 legacy envelope 与确定性目标 fixtures，覆盖文本-only、有效/缺失/共享 connection、已知/自定义 MiMo model、Realtime fallback、assignment repair 和已有目标幂等场景。
- 补齐 Final Design 列出的 10 个中英日繁翻译 key，保留旧 mismatch 文案供尚未迁移的当前 UI 使用。

## 修改文件

- `src/type/audio.ts`
- `src/lib/audio-provider-registry.ts`
- `src/lib/audio-provider-registry.test.ts`
- `src/lib/audio-endpoint.ts`
- `src/lib/audio-endpoint.test.ts`
- `test/audio/fixtures/legacyAudioSettings.ts`
- `test/audio/audioApiMigrationFixtures.test.ts`
- `src/pages/Setting/components/AudioModelConfig.tsx`
- `src/store/tools/audio/speechSynthesizerConfig.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `src/locales/{zh,en,ja,zh-Hant}/audio.json`
- 本需求 Final Design、Execution Plan、版本入口与版本级台账

## 接口或数据结构变化

- 新增 `AudioProviderPreset`、`AudioTransport`、`SpeechSynthesisMode`。
- 新增 `AudioRoute`、`AudioApiRoutes`、`AudioApiProfile`、`AudioTaskAssignment`、`AudioRouteVerification`。
- 新增 `getAudioProviderDefinition()`、`createDefaultAudioApiRoutes()`、`getSpeechRouteConstraints()`、`getAvailableSpeechSynthesisModes()`、`canAudioApiHandleTask()`、`resolveAudioApiRoute()` 与 `inferAudioProviderPresetFromLegacy()`。
- 新 `AudioApiProfile` 不含 `connectionProfileId`、profile-level dialect、扁平 capabilities 或任务 defaults，也不依赖文本侧 `Model` enum。
- `normalizeAudioEndpoint()` 新增 `responses_endpoint`，避免旧 `/responses` URL 被派生成 `/responses/audio/*`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/lib/audio-endpoint.test.ts test/audio/audioApiMigrationFixtures.test.ts test/audio/audioCapability.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioRuntimeClient.test.ts test/audio/mimoStreamingTts.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/tools/audio src/lib/audio-profile.test.ts src/store/useModelStore.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
```

结果：

- 重点 Registry/endpoint/fixture/runtime/streaming 验证通过：7 files / 51 tests。
- 音频相关回归通过：19 files / 116 tests。
- TypeScript 检查通过。
- i18n 检查通过：9 namespaces、四语言各 1420 keys；仅有既存同值 warning。
- `git diff --check` 通过。
- 未运行 pnpm，未修改 `pnpm-lock.yaml`。
- 未启动 Vite、Electron 或其他前端服务。

## 评审修复

- 独立审查发现自定义 OpenAI-compatible 默认 routes 为空时，显式新增 route 仍缺少可用 constraints。
- 已保持默认 routes 为空，同时补齐标准兼容 ASR/TTS/Realtime constraints，并增加显式 TTS route 的 eligibility/constraints 测试。

## 未完成事项

- 独立 `fusionkit-audio-settings` store、真实 legacy transformation、跨 key bootstrap 和文本 store 解耦尚未实现，归 `CORE-R01`。
- provider-neutral IPC intent 与 main `resolveRoute` 尚未实现，归 `BE-R01`。
- 新设置页和工具页条件渲染尚未实现，归 `FE-R01`/`FE-R02`/`FE-R03`。
- 源码 i18n usage checker 尚未实现，归 `I18N-R01`。

## 下一步建议

- 下一会话认领 `CORE-R01`。bootstrap 必须直接读取 `fusionkit-model` v4/v5 原始 envelope，并在旧 `useModelStore` hydration 过滤悬空 audio profile 前完成迁移。
- 只有成功写入 `fusionkit-audio-settings` 后才能记录 completion；写入失败时保留旧 audio 字段与删除保护。
- 迁移保持旧 audio profile ID，幂等匹配使用 `migration.sourceId`，不得自动合并共享 connection 的多个旧 profile。
