# 工作包 FE-004：文本转音频页面与流式播放

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-004`

## 本次实现内容

- 实现文本转音频页面：只读展示全局音频配置，提供输入文本、voice、输出格式、输出目录、OpenAI instructions/speed、MiMo 专属参数、开始/取消、结果播放器和打开输出目录。
- MiMo 三种 TTS 模式同页支持：预置音色、音色设计、音色复刻；模式与设置页全局 TTS 模型不匹配时阻止提交并提示需要的模型。
- MiMo 流式播放接入 renderer 侧 PCM16 播放器，订阅 `audio:speech-synthesis-stream` 事件边收边播，完成后切换到最终输出文件。
- 非 MiMo dialect 下禁用 MiMo-only 控件；MiMo dialect 下禁用 OpenAI-only `speed` 和 `instructions`，并将非流式格式锁定为 `wav`、流式格式锁定为 `pcm16`。
- 新增非流式 TTS 取消 IPC，页面取消可 abort main 进程中的普通语音合成请求；流式路径继续使用已有 stream cancel。
- 补齐 `audio` namespace 四语言 speech 文案与 TTS helper/store 单测。

## 修改文件

- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
- `src/pages/Tools/Audio/shared/pcm16StreamPlayer.ts`
- `src/store/tools/audio/speechSynthesizerConfig.ts`
- `src/store/tools/audio/speechSynthesizerConfig.test.ts`
- `src/store/tools/audio/useSpeechSynthesizerStore.ts`
- `src/type/audio.ts`
- `src/type/audioIpc.ts`
- `src/type/audioIpc.test.ts`
- `electron/main/audio/ipc.ts`
- `test/audio/audioIpcService.test.ts`
- `src/services/audio/speechSynthesisService.ts`
- `src/services/audio/audioServices.test.ts`
- `src/locales/*/audio.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- `CreateSpeechSynthesisRequest` 新增可选 `requestId`，用于取消正在执行的非流式语音合成请求。
- `AUDIO_IPC_CHANNELS` 新增 `cancelSpeechSynthesis: "audio:cancel-speech-synthesis"`。
- 新增 `CancelSpeechSynthesisRequest` / `CancelSpeechSynthesisResult` 与 IPC validation。
- `AudioIpcService` 新增 speech abort controller map 和 `cancelSpeechSynthesis()`。
- renderer service 新增 `cancelSpeechSynthesis(requestId)` 与 `revealSpeechOutput()`。
- 新增 `SpeechSynthesizerPreferences`、`SelectedVoiceSample`、MiMo 模式/模型匹配 helper、voice sample 校验和 request 构造 helper。

## 验证结果

执行命令：

```text
node -e "const fs=require('fs'); for (const file of ['src/locales/zh/audio.json','src/locales/en/audio.json','src/locales/zh-Hant/audio.json','src/locales/ja/audio.json']) { JSON.parse(fs.readFileSync(file,'utf8')); console.log('ok', file); }"
node_modules/.bin/vitest run src/store/tools/audio/speechSynthesizerConfig.test.ts src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts
node scripts/check-i18n.mjs
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts
git diff --check
```

结果：

- JSON 解析通过。
- 定向测试通过，4 files / 30 tests。
- i18n 检查通过，`audio` 204 keys x 4 locales；存在专名/格式名相同 warning：`SRT 字幕`、`VTT 字幕`、`OpenAI · MiMo`、`MiMo 音色`。
- TypeScript 检查通过。
- 音频相关回归通过，17 files / 99 tests。
- `git diff --check` 通过。

## 未完成事项

- 未启动 Electron 做视觉验收；TTS 页面布局、长文本、窄宽度、播放器状态和输出目录体验仍需 QA-002 复核。
- OpenAI/MiMo 真实 TTS 调用未在本工作包执行；MiMo 三模式非流式与流式低延迟真实供应商验收仍由 QA-002 承接。
- Realtime 字幕与双向语音页面仍未实现，分别由 `FE-005`、`FE-006` 承接。

## 下一步建议

- 认领 `FE-005`，实现实时字幕页面。
- 优先处理麦克风权限、partial/final 字幕流、停止清理、复制/保存结果和 MiMo 分块近实时的清晰标识。
