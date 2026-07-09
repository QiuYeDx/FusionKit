# 工作包 FE-001：设置页全局音频模型配置

## 基本信息

- 日期：2026-07-09
- 状态：已完成
- 对应执行计划工作包：`FE-001`

## 本次实现内容

- 新增设置页音频模型配置分区，支持创建、编辑、删除 audio profile。
- Audio profile 复用已有模型连接 profile，只保存音频协议、ASR/TTS/Realtime 模型 ID、默认语言、默认 voice、默认输出格式、MiMo TTS 默认模式和默认流式开关。
- 新增四类全局音频 assignment：音频转文本、文本转音频、实时字幕、双向语音；设置页按 capability 和模型字段禁用不可用 profile。
- 支持 `openai_audio`、`mimo_chat_audio`、`openai_realtime` 三类 dialect 的默认模型与能力展示；MiMo realtime captions 明确标记为分块近实时，不启用 WebRTC 双工。
- 文本模型连接列表增加音频引用保护提示：被 audio profile 引用的 connection profile 删除时给出 toast，不再悄悄 no-op。
- 将设置页已有的长文本模型编辑弹窗迁移到 `ScrollableDialog`，新增音频 profile 表单也使用 `ScrollableDialog`，符合 FusionKit 弹窗滚动避坑要求。
- 补齐 `setting.json` 的 zh / zh-Hant / en / ja 四语言文案。

## 修改文件

- `src/pages/Setting/components/AudioModelConfig.tsx`
- `src/pages/Setting/components/ModelConfig.tsx`
- `src/locales/zh/setting.json`
- `src/locales/zh-Hant/setting.json`
- `src/locales/en/setting.json`
- `src/locales/ja/setting.json`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_final_design.md`
- `docs/v0.2.11/audio-toolkit/audio-toolkit_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 未新增持久化字段；复用 `CORE-001` 已落地的 `audioProfiles`、`audioAssignment`、`addAudioProfile()`、`updateAudioProfile()`、`removeAudioProfile()`、`setAudioAssignment()`。
- 新增 UI 层默认值映射：
  - OpenAI Audio：`gpt-4o-transcribe`、`gpt-4o-mini-tts`。
  - MiMo Chat Audio：`mimo-v2.5-asr`、`mimo-v2.5-tts` / `mimo-v2.5-tts-voicedesign` / `mimo-v2.5-tts-voiceclone`。
  - OpenAI Realtime：`gpt-realtime`。

## 验证结果

执行命令：

```text
node -e "for (const f of ['src/locales/zh/setting.json','src/locales/zh-Hant/setting.json','src/locales/en/setting.json','src/locales/ja/setting.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log(f, 'ok'); }"
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run src/store/useModelStore.test.ts src/lib/audio-profile.test.ts test/audio/audioCapability.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/store/useModelStore.test.ts src/lib/audio-profile.test.ts src/lib/audio-endpoint.test.ts src/services/audio/audioServices.test.ts
git diff --check
```

结果：

- 四个 `setting.json` 均可 JSON parse。
- `node_modules/.bin/tsc --noEmit` 通过。
- `node scripts/check-i18n.mjs` 通过，setting namespace 为 178 keys x 4 locales。
- store/audio capability 测试通过，3 files / 16 tests。
- 音频相关回归通过，14 files / 79 tests。
- `git diff --check` 通过。

## 未完成事项

- 未启动 Electron 做设置页视觉验收；后续进入 FE-002/FE-003 时建议一并复核设置页滚动弹窗、移动端宽度、长模型 ID 截断和四类 assignment 下拉状态。
- 工具入口、路由和四个工具页尚未实现，仍在后续 FE-002 至 FE-006。

## 下一步建议

- 下一步认领 `FE-002`：工具入口、音频路由、共享状态与 i18n 基线。
- FE-002 应让工具页能够读取并展示当前全局 audio assignment 摘要，但仍不得在工具页保存 provider、API Key、base URL、dialect 或模型 ID。
