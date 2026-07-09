# 工作包 FE-002：工具入口、路由、共享状态与 i18n 基线

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-002`

## 本次实现内容

- 新增音频工具箱四个工具入口：音频转文本、文本转音频、实时字幕、双向语音。
- 新增四条音频工具路由和页面占位，后续 FE-003 至 FE-006 可在同一 shell 上继续实现具体交互。
- 新增共享 `audioToolConfig` helper，用于从全局 audio assignment 解析工具页只读配置摘要，并避免暴露 API Key。
- 新增 `AudioToolShell`，统一展示全局音频 Profile、协议、模型、连接和能力状态。
- 新增 `audio` i18n namespace，并补齐 `tools` 与 `common` 四语言菜单/卡片文案。

## 修改文件

- `src/pages/Tools/_shared/toolMeta.ts`
- `src/pages/Tools/index.tsx`
- `src/App.tsx`
- `src/constants/router.ts`
- `src/index.css`
- `src/i18n/constants.ts`
- `src/i18n/resources.ts`
- `src/store/tools/audio/audioToolConfig.ts`
- `src/store/tools/audio/audioToolConfig.test.ts`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `src/pages/Tools/Audio/RealtimeVoice/index.tsx`
- `src/locales/*/audio.json`
- `src/locales/*/tools.json`
- `src/locales/*/common.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 新增工具 key：`audioTranscriber`、`speechSynthesizer`、`realtimeCaptions`、`realtimeVoice`。
- 新增路由：`/tools/audio/transcriber`、`/tools/audio/speech-synthesis`、`/tools/audio/realtime-captions`、`/tools/audio/realtime-voice`。
- 新增 `resolveAudioToolConfigSummary()`，输入全局 model store 兼容状态与 `AudioAssignmentKey`，输出不含 API Key 的只读工具配置摘要。
- 新增 `MIMO_VOICE_PRESETS`，供后续 TTS 页面复用。

## 验证结果

执行命令：

```text
node -e "const fs=require('fs'); const files=['src/locales/zh/tools.json','src/locales/en/tools.json','src/locales/zh-Hant/tools.json','src/locales/ja/tools.json','src/locales/zh/common.json','src/locales/en/common.json','src/locales/zh-Hant/common.json','src/locales/ja/common.json','src/locales/zh/audio.json','src/locales/en/audio.json','src/locales/zh-Hant/audio.json','src/locales/ja/audio.json']; for (const file of files) { JSON.parse(fs.readFileSync(file,'utf8')); console.log('ok', file); }"
node_modules/.bin/vitest run src/store/tools/audio/audioToolConfig.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts
git diff --check
```

结果：

- JSON 解析通过。
- `audioToolConfig.test.ts` 通过，1 file / 3 tests。
- TypeScript 检查通过。
- i18n 检查通过，`audio` 36 keys、`tools` 45 keys、`common` 67 keys 四语言对齐；存在专名相同 warning：`OpenAI · MiMo`、`MiMo 音色`。
- 音频相关回归通过，15 files / 82 tests。
- `git diff --check` 通过。

## 未完成事项

- 四个工具页目前是入口和全局配置摘要占位，尚未实现实际 ASR、TTS、实时字幕和双向语音交互。
- 本工作包未启动 Electron 做视觉验收；后续 FE-003 进入真实页面交互时建议补一次 Electron 视觉/路由人工复核。

## 下一步建议

- 认领 `FE-003`，实现音频转文本页面。
- 继续遵守“工具页只读消费全局音频配置”的约束，不在页面内保存 provider、API Key、base URL、dialect 或模型 ID。
