# 工作包 FE-003：音频转文本页面

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-003`

## 本次实现内容

- 实现音频转文本页面：文件选择、文件信息、语言、输出格式、时间戳、prompt、结果保存模式、开始/取消、结果展示、复制、打开输出目录。
- 工具页继续只读消费设置页全局 audio assignment，不提供 provider、API Key、base URL、dialect 或模型 ID 独立选择。
- MiMo ASR 下禁用 prompt、字幕/详细 JSON、时间戳等 OpenAI-only 控件，并限制文件格式和语言。
- 首版文件流式转写控件保持可见但禁用，避免后端尚未实现文件 ASR 流式事件时误导用户。
- 新增 ASR 取消 IPC：`audio:cancel-transcription`，页面取消可 abort main 进程中的转写请求。
- 扩展 `AudioToolShell` 支持页面插入任务参数与自定义工作区，便于后续 FE-004 至 FE-006 复用。

## 修改文件

- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/store/tools/audio/audioTranscriberConfig.ts`
- `src/store/tools/audio/audioTranscriberConfig.test.ts`
- `src/store/tools/audio/useAudioTranscriberStore.ts`
- `src/type/audio.ts`
- `src/type/audioIpc.ts`
- `src/type/audioIpc.test.ts`
- `electron/main/audio/ipc.ts`
- `test/audio/audioIpcService.test.ts`
- `src/services/audio/audioTranscriptionService.ts`
- `src/services/audio/audioServices.test.ts`
- `src/locales/*/audio.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- `CreateAudioTranscriptionRequest` 新增可选 `requestId`，用于取消正在执行的转写请求。
- `AUDIO_IPC_CHANNELS` 新增 `cancelTranscription: "audio:cancel-transcription"`。
- 新增 `CancelAudioTranscriptionRequest` / `CancelAudioTranscriptionResult` 与 IPC validation。
- `AudioIpcService` 新增 transcription abort controller map 和 `cancelTranscription()`。
- renderer service 新增 `cancelAudioTranscription(requestId)`。
- 新增 `AudioTranscriberPreferences`、`SelectedAudioInput` 和纯函数 helper，用于 renderer 侧能力禁用、文件格式/大小预检与请求构造。

## 验证结果

执行命令：

```text
node -e "const fs=require('fs'); for (const file of ['src/locales/zh/audio.json','src/locales/en/audio.json','src/locales/zh-Hant/audio.json','src/locales/ja/audio.json']) { JSON.parse(fs.readFileSync(file,'utf8')); console.log('ok', file); }"
node_modules/.bin/vitest run src/store/tools/audio/audioTranscriberConfig.test.ts src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts
git diff --check
```

结果：

- JSON 解析通过。
- 定向测试通过，4 files / 26 tests。
- TypeScript 检查通过。
- i18n 检查通过，`audio` 108 keys x 4 locales；存在专名/格式名相同 warning：`SRT 字幕`、`VTT 字幕`、`OpenAI · MiMo`、`MiMo 音色`。
- 音频相关回归通过，16 files / 90 tests。
- `git diff --check` 通过。

## 未完成事项

- 未启动 Electron 做视觉验收；后续 FE-004 或 QA-002 建议一起复核音频工具详情页布局、文件选择、输出目录和结果展示。
- OpenAI/MiMo 真实 ASR 调用仍需 QA-002 验证。
- 文件 ASR 流式事件未在首版页面启用；实时字幕能力由 FE-005 承接。

## 下一步建议

- 认领 `FE-004`，实现文本转音频页面与 MiMo 三模式流式播放。
- 继续复用全局音频配置摘要，保持工具页不保存独立 API 生效配置。
