# 工作包 FE-R02：Route-aware 文本转音频与 Voice Token 闭环

## 基本信息

- 日期：2026-07-14
- 状态：已完成
- 对应执行计划工作包：`FE-R02`

## 本次实现内容

- `fusionkit-speech-synthesizer` 升至 v5：`mimoMode` 迁为 provider-neutral
  `speechMode`，移除 `profileSeedKey`、`profileDefaultOverrides` 和 profile defaults
  播种；持久化只保留 preferences，runtime token、`File`、结果和任务状态不 hydration。
- 新增各模式输入草稿，切换 preset/design/clone 后可恢复；结果区不会因模式切换清空。
- TTS 页面直接从独立 `useAudioApiStore` assignment/profile routes 计算可用模式：
  0 route 显示精确音频设置 CTA，1 route 不显示选择器，2～3 route 只显示可用项；
  当前模式失效时按 preset-first 回退并给出非阻断提示。
- voice、instructions、style、speed、voice design prompt、optimize preview、reference
  audio、format 和 stream 全部由 provider registry constraints 条件渲染。单格式显示
  摘要，隐藏字段不留 disabled DOM，也不进入请求。
- renderer builder 直接生成三种 discriminated `intent`，删除 legacy speech request
  输入；payload 不携带 API Key、Base URL、provider、transport、model 或 raw path。
- Voice clone 选择文件后立即通过 dedicated preload method 授权。一次性 token 被任务
  消费后清空，但保留本页面会话的 runtime `File`，再次生成自动重新授权，无需重选。
  替换、清除、profile 变化、离页和迟到授权响应都会撤销未消费 token。
- 终审补充同步提交预检锁，阻止快速双击复用一次性 token；授权等待期间锁定配置，
  返回后校验 profile/provider/route/mode/sourceFile 快照，失效请求只撤销 token 不提交。
- 撤销同时处理 rejected Promise 与 resolved `{ ok: false }`：清 UI 前把 token 放入跨
  SPA 路由的重试队列，按退避重试到成功/过期；`revoked: false` 作为幂等成功。
- 新增 `audio:internal:revoke-input-file`：main revoke 绑定 sender owner、幂等返回；
  preload generic `invoke` 仍拒绝所有 internal channel，只有固定 `revokeInputFile()`
  方法可调用该通道。
- `AudioToolShell` standalone 摘要突出音频 API、状态、供应商和生成模式；transport/
  model 收进技术详情。“更改音频 API”和无配置 CTA 使用精确
  `/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Fspeech-synthesis`。
- 四语言新增 standalone 状态、中性模式、授权和回退文案，移除旧的
  `mimo_model_mismatch`、长期 disabled 和“全局 TTS 模型匹配”语义。
- input/instructions 4096 上限提为共享常量并写入所有 speech route constraints；
  renderer、public IPC 与 main route validator 对 MiMo/OpenAI 使用同一边界。
- 运行中离页通过 `invalidateTask` 原子清空活动请求并把运行态转为 `cancelled`；保留
  用户偏好、已有结果和输出目录授权，返回页面后可重新提交，stale cleanup 不影响新任务。
- Electron E2E 新增零配置、OpenAI 实际生成、MiMo 三模式 × stream on/off、双击防重、
  二路由 fallback、真实 WAV 授权与重新授权；clone 侧栏改为纵向 dropzone 并单独取证。

## 修改文件

- 页面与共享 UI：
  `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`、
  `src/pages/Tools/Audio/shared/AudioToolShell.tsx`、
  `src/pages/Tools/_shared/ui/ToolField.tsx`、
  `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`。
- Store、builder 与 registry：
  `src/store/tools/audio/useSpeechSynthesizerStore.ts`、
  `src/store/tools/audio/speechSynthesizerConfig.ts`、
  `src/store/tools/audio/audioToolConfig.ts`、
  `src/lib/audio-provider-registry.ts`。
- IPC、preload 与 renderer service：
  `src/type/audioIpc.ts`、`electron/main/audio/audio-file.ts`、
  `electron/main/audio/ipc.ts`、`electron/preload/index.ts`、
  `src/services/audio/audioRuntimeConfigService.ts`、
  `src/services/audio/speechSynthesisService.ts`。
- i18n：`src/locales/{zh,zh-Hant,en,ja}/audio.json`。
- 测试：speech config/store、audio service/file/IPC/preload policy tests 和
  `test/e2e.spec.ts`。
- 项目经验：`.agents/skills/fusionkit-pitfall-guard/references/`。

## 接口或数据结构变化

- `SpeechSynthesizerPreferences.mimoMode` 改为 `speechMode`，新增
  `modeInputDrafts`；Store version 为 5。
- `SelectedVoiceSample` 只保存 runtime `sourceFile`、nullable `fileToken` 和展示元数据，
  不保存 raw path，也不进入 persisted slice。
- `CreateSpeechSynthesisIpcRequest` 只接受 provider-neutral `intent`；删除 legacy
  renderer input union。
- `AudioRendererApi` 新增 `revokeInputFile(fileToken)`；新增 owner-bound、幂等的
  internal revoke request/result 合同。
- speech route constraints 新增 input/instructions 长度上限，并成为 submit 校验、字段
  可见性和 request 白名单的唯一来源。
- `ToolField` 新增可选稳定 test id，`ToolFileDropZone` 新增 file input test id 与可选
  stacked 布局；不改变既有调用方默认行为。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/store/tools/audio/useSpeechSynthesizerStore.test.ts src/lib/audio-provider-registry.test.ts src/type/audioIpc.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioIpcService.test.ts src/services/audio/audioServices.test.ts --reporter=dot
node_modules/.bin/vitest run --exclude test/e2e.spec.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts --reporter=verbose
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware speech synthesis' --reporter=verbose
git diff --check
ps -axo pid,ppid,command | rg '<FusionKit Vite/Electron process patterns>'
```

结果：

- 定向 config/store/service/IPC：6 files / 113 tests 通过；包含 v4 真实 envelope
  hydration、4096/4097 长度边界、撤销 `{ ok: false }`/rejection 重试、快照失效和
  非流式/流式离页后重新提交。
- 全量非 Electron Vitest：85 files / 727 tests 通过。
- TypeScript 通过；四语言各 1514 个 scalar keys 对齐，其中 audio namespace 各
  390 keys；只有 9 条既有 same-as-source 提示。
- Vite renderer/main/preload test build 通过；只有既有 dynamic-import 和 chunk-size
  warning。
- 完整 Electron E2E：1 file / 4 tests 通过；FE-R02 定向场景另行通过。覆盖 OpenAI
  实际生成、MiMo 三模式 × stream on/off、同步双击防重、二路由 fallback、四语言
  raw-key、真实 WAV file input 与 owner-bound token 重新授权/消费。
- `test-results/fe-r02-speech-1280x800.png`、
  `fe-r02-speech-clone-1280x800.png`、`fe-r02-speech-786x540.png`、
  `fe-r02-speech-workspace-786x540.png` 已审查：preload loading 已退出，双栏/单栏和
  320px clone 侧栏正确，无文本截断、按钮裁切、关键控件遮挡或横向溢出。
- `git diff --check` 通过；未运行 pnpm，`package.json` 与 v6 `pnpm-lock.yaml` 未改。
- Electron 与 fake server 均由 E2E `afterAll` 关闭；最终回复前再次检查进程表。

## 未完成事项

- `FE-R03` 尚未迁移 ASR、实时字幕、双向语音消费者；legacy audio CRUD/selectors、
  `AudioModelConfig` 与文本 connection 删除保护继续保留。
- `I18N-R01` 的 `scripts/check-i18n-usage.mjs` 尚未实施；本工作包已做 locale parity
  和 Electron raw-key smoke，但不能替代源码 usage 门禁。
- `TEST-R01`、`QA-R01` 的完整发布门禁和 `QA-R02` 真实 OpenAI/MiMo、麦克风/
  扬声器验收仍按计划后续执行。

## 下一步建议

- 下一会话认领 `FE-R03`，逐个迁移 AudioTranscriber、RealtimeCaptions、
  RealtimeVoice 到独立 assignment/routes，最后再删除 legacy facade。
- 保持本工作包建立的 constraints 单一事实来源、preload internal-channel 隔离、
  owner-bound token、失败撤销重试和精确设置 deep link，不在其余工具中恢复 raw path
  或双写；ASR 迁移应复用同一授权闭环。
