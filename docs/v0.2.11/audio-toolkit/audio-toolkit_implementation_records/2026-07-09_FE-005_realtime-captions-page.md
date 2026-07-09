# 工作包 FE-005：实时字幕页面

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-005`

## 本次实现内容

- 实现实时字幕页面：只读展示全局 realtime captions 配置，页面参数只包含语言、输入音频格式、说话检测、输出格式、助手字幕显示和 realtime instructions。
- 页面通过 `startOpenAIRealtimeWebRtcSession()` 创建 ephemeral session、请求麦克风权限、建立 WebRTC，并处理 `session_started`、`mic_state`、`transcript_delta`、`transcript_final`、`error`、`session_closed` 等标准事件。
- 实时字幕流支持 partial/final 展示、用户/助手角色区分、复制、TXT/SRT 下载、清空、停止和页面卸载 cleanup。
- MiMo/非 Realtime profile 使用分块近实时路径：renderer 将麦克风输入编码为短 WAV chunk，main 进程写临时文件并按全局 ASR 配置逐段转写，返回 final 字幕行。
- 新增录音片段专用 IPC：`audio:transcribe-recorded-chunk` 与 `audio:cancel-recorded-chunk-transcription`；普通音频任务 IPC 仍禁止 raw audio/base64，chunk 字节不进入 Zustand 持久化、日志或错误详情。
- 新增实时字幕 Zustand store，持久化仅保存页面偏好；字幕行、partial、sessionId、错误状态不持久化。
- 新增 realtime captions helper：模式判断、OpenAI session request 构造、偏好归一化、SRT/TXT 格式化和单测。

## 修改文件

- `src/pages/Tools/Audio/RealtimeCaptions/index.tsx`
- `src/pages/Tools/Audio/shared/wavChunkRecorder.ts`
- `src/type/audioIpc.ts`
- `src/type/audioIpc.test.ts`
- `electron/main/audio/ipc.ts`
- `test/audio/audioIpcService.test.ts`
- `src/services/audio/audioServices.test.ts`
- `src/store/tools/audio/realtimeCaptionsConfig.ts`
- `src/store/tools/audio/realtimeCaptionsConfig.test.ts`
- `src/store/tools/audio/useRealtimeCaptionsStore.ts`
- `src/locales/*/audio.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 新增录音片段专用 IPC channel：`audio:transcribe-recorded-chunk` 与 `audio:cancel-recorded-chunk-transcription`。
- 新增 `TranscribeRecordedAudioChunkRequest` / `TranscribeRecordedAudioChunkResult` / cancel 类型与 validation。
- `AudioIpcService` 新增 recorded chunk abort controller map，chunk 转写时使用 `realtimeCaptions` assignment 解析全局模型，然后内部构造临时文件 ASR payload。
- 新增 renderer-only `RealtimeCaptionsPreferences`、`RealtimeCaptionLine`、`RealtimeCaptionsMode` 和 UI store。
- 继续复用 `AudioRealtimeSessionConfig`、`AudioRealtimeSessionEvent` 和 `startOpenAIRealtimeWebRtcSession()`。

## 验证结果

执行命令：

```text
node -e "const fs=require('fs'); for (const file of ['src/locales/zh/audio.json','src/locales/en/audio.json','src/locales/zh-Hant/audio.json','src/locales/ja/audio.json']) { JSON.parse(fs.readFileSync(file,'utf8')); console.log('ok', file); }"
node_modules/.bin/vitest run src/type/audioIpc.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts
node scripts/check-i18n.mjs
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/audioTranscriberConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts src/store/tools/audio/realtimeCaptionsConfig.test.ts
git diff --check
```

结果：

- JSON 解析通过。
- 定向测试通过，4 files / 33 tests。
- i18n 检查通过，`audio` 275 keys x 4 locales；存在专名/格式名相同 warning：`SRT 字幕`、`VTT 字幕`、`OpenAI · MiMo`、`MiMo 音色`。
- TypeScript 检查通过。
- 音频相关回归通过，18 files / 107 tests。
- `git diff --check` 通过。

## 未完成事项

- 未启动 Electron 做麦克风权限和 WebRTC 真实连接验收；该部分仍需 QA-002。
- OpenAI Realtime 与 MiMo/分块近实时真实供应商表现仍需 QA-002 记录。

## 下一步建议

- 认领 `FE-006`，实现 Realtime/WebRTC 双向语音页面。
- 继续复用 OpenAI Realtime session service，确保页面离开释放 mic tracks、peer connection、data channel 和远端音频元素。
