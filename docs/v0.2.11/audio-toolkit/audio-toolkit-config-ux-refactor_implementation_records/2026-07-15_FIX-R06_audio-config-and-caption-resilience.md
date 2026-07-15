# 工作包 FIX-R06：音频配置状态、分段控件与字幕静音容错

## 基本信息

- 日期：2026-07-15
- 状态：已完成
- 对应执行计划工作包：`FIX-R06`
- 后续变更：本记录中的 `AudioSegmentedControl` 是历史实现，已由 `FIX-R07` 删除并替换为字幕文件翻译与音频工具共用的 `ToolRadioButtonGroup`；其余 FIX-R06 行为仍有效。

## 本次实现内容

- 移除没有验证入口支撑的音频 API verification UI 和 runtime 失败门禁，旧字段仅保留迁移兼容。
- 当时抽取 Radix `AudioSegmentedControl` 统一四个音频工具的按钮行为；其私有视觉实现随后由
  `FIX-R07` 替换为工具级共享 `ToolRadioButtonGroup`。
- 为 main 可信 recorded-chunk 路径增加空转写容错，静音片段不再停止 MiMo 实时字幕。
- 保持普通文件空转写与所有真实供应商错误的原有失败语义。
- 补齐 focused/full audio/Electron 回归、宽窄截图、fix 文档和两条项目 pitfall 记录。

## 修改文件

- `src/pages/Setting/components/AudioApiConfig.tsx`
- `src/pages/Setting/components/audioApiConfigModel.ts`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `src/pages/Tools/Audio/shared/AudioSegmentedControl.tsx`（历史文件，已由 `FIX-R07` 删除）
- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`（当前替代实现）
- `src/pages/Tools/Audio/{AudioTranscriber,SpeechSynthesizer,RealtimeCaptions,RealtimeVoice}/index.tsx`
- `electron/main/audio/audio-runtime-config.ts`
- `electron/main/audio/audio-runtime-client.ts`
- `electron/main/audio/ipc.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`
- `src/type/audio.ts`、`src/locales/*/{audio,setting}.json`
- 相关 audio/config/Electron tests 与项目文档

## 接口或数据结构变化

- public renderer IPC 没有新增字段。
- main 内部 `AudioRuntimeRequestOptions` 新增 `allowEmptyTranscriptionResult?: boolean`，只由
  recorded-chunk service 设置；renderer 无法伪造或扩大该语义。
- `ResolvedAudioRouteConfig` 和 `AudioRouteResolutionIssue` 删除 verification 状态/错误；
  `AudioApiProfile.verification` 与 runtime snapshot 校验继续保留迁移兼容。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/pages/Setting/components/audioApiConfigModel.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioRuntimeConfig.test.ts test/audio/audioRuntimeClient.test.ts test/audio/audioIpcService.test.ts --reporter=dot
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio src/pages/Setting/components/audioApiConfigModel.test.ts src/lib/audio-provider-registry.test.ts src/lib/audio-api-migration.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts --reporter=dot
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'standalone audio settings|route-aware speech synthesis|route-aware audio transcription|route-aware realtime captions|route-aware realtime voice' --reporter=dot
git diff --check
```

结果：

- focused 6 files / 108 tests、音频回归 31 files / 342 tests、TypeScript 全部通过。
- 四语言各 1482 keys；usage 1343 calls / 1376 resolved keys 通过。
- renderer/main/preload build 通过，仅有既有构建 warning。
- Electron 5 条产品链路通过；宽窄截图与无溢出断言通过。
- 首轮 Electron 捕获键盘焦点回归，修复后 TTS 单条链路与最终五链路均通过。
- 最终 FusionKit Vite/Electron 前端进程表为空。

## 未完成事项

- 未使用用户真实 MiMo Key 或真实麦克风执行“连续静音多个 chunk 后恢复说话”；该项保留在
  `QA-R02`，本轮自动化已覆盖 adapter、IPC、renderer 容错合同。

## 下一步建议

- 继续 `TEST-R01` 完整测试包审计；真实设备验收时重点覆盖静音恢复、402/鉴权错误仍停止会话。
