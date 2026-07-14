# 音频 API 配置与语音合成 UX 重构 Execution Plan

> 日期：2026-07-13
> Feature Slug：`audio-toolkit-config-ux-refactor`
> 对应设计文档：`docs/v0.2.11/audio-toolkit/audio-toolkit-config-ux-refactor_final_design.md`
> 当前状态：`PRE-R01`、`CORE-R01`、`BE-R01`、`FE-R01`、`FE-R02`、`FE-R03` 已完成；下一步 `I18N-R01`

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须：

1. 阅读 `docs/v0.2.11/README.md` 与版本级 execution plan。
2. 完整阅读本需求 Final Design 和本执行计划。
3. 检查第 5 节进度台账，认领一个最小可闭环工作包。
4. 检查 `git status --short`，保留用户已有改动。
5. 如需运行包管理命令，先确认使用项目兼容的 pnpm 8.x；优先直接使用 `node_modules/.bin/*`，不得用新 pnpm 改写 lockfile v6。
6. 如需启动 Vite、Electron、Playwright Electron 或其他前端服务，记录进程并在最终回复前关闭。

每次实现会话结束前必须：

1. 运行工作包验证，或准确记录未执行原因。
2. 更新第 5 节进度台账与版本级台账。
3. 在 `audio-toolkit-config-ux-refactor_implementation_records/` 新增或更新实施记录。
4. 只有代码、测试、文档、台账和验证均闭环时才标记 `已完成`。
5. 如实现证明设计假设不成立，先更新 Final Design 或新增 feat/fix 文档，不能静默偏离。
6. 关闭本次启动的全部前端服务，并确认没有 FusionKit Vite/Electron 残留进程。

## 2. 状态规则

工作包状态只允许使用：`未开始`、`进行中`、`已完成`、`阻塞`、`废弃`。

- `未开始`：尚未产生实现或验证工作。
- `进行中`：已有实现或验证，但尚未满足完整验收口径。
- `已完成`：实现、验证、实施记录和台账已经闭环。
- `阻塞`：存在明确外部阻塞，当前会话无法继续推进。
- `废弃`：设计更新后明确不再实施，并已记录替代方案。

## 3. 推进原则与约束

1. 先固定独立音频 API 类型、provider registry、route constraints 和迁移 fixture，再切 Store、IPC 与 UI。
2. 先打通“独立配置可创建 -> assignment 可解析 -> MiMo 三模式自动路由 -> TTS 条件渲染”的最小闭环，再迁移其他音频工具。
3. 旧 `AudioModelProfile` 在迁移期只读保留；新 `AudioApiProfile` 不得引用 `connectionProfileId`，文本模型与音频 API 生命周期必须解耦。
4. 音频 API 不保存 TTS mode、voice、语言、格式、stream 或输出目录等任务偏好。
5. renderer task payload 不得携带 API Key、Base URL、provider、transport 或 model；main 继续维护 sender/revision、文件 token、输出 token 与取消边界。
6. 一条 MiMo API 同时提供三种 TTS route；mode 到 model 的映射只能存在于共享 registry。
7. 与当前 route 无关的字段不进入 DOM；长表单对话框使用 `ScrollableDialog`。
8. locale parity 和源码 key 存在性必须分别验证；Electron 验收必须等待 preload loading 完全退出。

## 4. 里程碑

| 里程碑 | 达成条件 |
| --- | --- |
| M0 新领域基线 | `PRE-R01` 完成，新类型、registry、constraints 与迁移 fixture 可复用 |
| M1 独立配置可用 | `CORE-R01`、`FE-R01` 完成，独立 store、迁移、设置页 CRUD 与 assignment 可用 |
| M2 可信路由闭环 | `BE-R01`、`FE-R02` 完成，main 按 intent 解析 route，TTS 三模式可提交 |
| M3 四工具迁移 | `FE-R03`、`I18N-R01` 完成，四个工具只消费独立配置且无 raw key |
| M4 自动化候选 | `TEST-R01`、`QA-R01` 完成，类型、单测、Electron 交互矩阵通过 |
| M5 发布候选 | `QA-R02`、`DOC-R01` 完成，真实供应商/设备与发布文档闭环 |

## 5. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-R01 | 已完成 | 2026-07-13 | 新音频 API 类型、Provider Registry、route constraints 与迁移 fixture | `src/type/audio.ts`、`src/lib/audio-provider-registry.ts`、`src/lib/audio-endpoint.ts`、registry/fixture tests、MiMo 映射消费者、`src/locales/*/audio.json` | 重点 7 files / 51 tests；音频相关 19 files / 116 tests；`tsc --noEmit`；四语言 1420 keys；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_PRE-R01_audio-api-domain-registry.md` | hydration 前跨 key bootstrap 已由 `CORE-R01` 完成 |
| CORE-R01 | 已完成 | 2026-07-13 | 独立 audio store、legacy migration 与文本 store 解耦基础设施 | `src/store/useAudioApiStore.ts`、`src/lib/audio-api-migration.ts`、`src/store/useModelStore.ts`、migration/store/bootstrap tests | CORE 5 files / 46 tests；音频 24 files / 168 tests；`tsc --noEmit`；四语言 1420 keys；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_CORE-R01_audio-api-store-migration.md` | 最后 legacy facade 已由 `FE-R03` 移除；旧字段仅保留一个版本的只读备份 |
| BE-R01 | 已完成 | 2026-07-13 | standalone runtime snapshot、provider-neutral intent 与可信 `resolveRoute` | `src/type/audioIpc.ts`、`electron/main/audio/audio-runtime-config.ts`、`electron/main/audio/ipc.ts`、`electron/main/audio/realtime-ipc.ts`、`electron/main/audio/audio-output-directory.ts`、`electron/preload/index.ts`、`electron/preload/audio-channel-policy.ts`、audio services/adapters/tests | IPC 1 file / 42 tests；音频 29 files / 244 tests；全量 83 files / 691 tests；`tsc --noEmit`；四语言 1425 keys；Vite test build；Electron 2 tests（4 routes × 4 locales × 2 sizes）；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_BE-R01_standalone-audio-runtime-routing.md` | 后续 FE 工作包已停止设置页 legacy 写入并完成四工具消费者迁移 |
| FE-R01 | 已完成 | 2026-07-13 | 独立“设置 -> 音频”页面与首次配置链路 | `src/pages/Setting/index.tsx`、`settingNavigation.ts`、`AudioApiConfig.tsx`、`audioApiConfigModel.ts`、`useAudioApiStore.ts`、`src/locales/*/setting.json`、`test/e2e.spec.ts` | 设置/Store 3 files / 27 tests；音频 31 files / 261 tests；全量 85 files / 709 tests；TypeScript；四语言 1505 keys；Vite test build；Electron E2E 3 tests；截图审查；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_FE-R01_standalone-audio-settings.md` | M1 已达成；legacy audio CRUD/selectors 已由 `FE-R03` 清理 |
| FE-R02 | 已完成 | 2026-07-14 | TTS store v5、route-aware 条件渲染、三模式 intent、配置 CTA 与 voice token 生命周期 | `SpeechSynthesizer/index.tsx`、`AudioToolShell.tsx`、speech store/config、provider registry、audio IPC/preload/service、四语言 audio locale、`test/e2e.spec.ts` | 定向 6 files / 113 tests；全量非 Electron 85 files / 727 tests；TypeScript；四语言各 1514 keys；Vite test build；Electron E2E 4 tests；4 张宽窄/clone 截图；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-14_FE-R02_route-aware-speech-synthesizer.md` | M2 已达成；终审竞态/撤销/长度/UI/离页任务态闭环见 `fix/2026-07-14_FIX-R02_tts-preflight-capability-contract.md`；其余工具迁移已由 `FE-R03` 完成 |
| FE-R03 | 已完成 | 2026-07-14 | ASR、实时字幕、双向语音迁移及 legacy facade cleanup | 三工具 page/config/store、shared shell、provider registry、audio IPC/service、legacy model store/settings、`test/e2e.spec.ts` | Cleanup focused 7 files / 51 tests；全量非 Electron 88 files / 807 tests；TypeScript；四语言各 1514 keys；Vite test build；route-aware Electron 4 tests；ASR/字幕/Voice 共 8 张宽窄截图；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-14_FE-R03_route-aware-audio-transcriber.md`、`audio-toolkit-config-ux-refactor_implementation_records/2026-07-14_FE-R03_route-aware-realtime-voice.md`、`audio-toolkit-config-ux-refactor_implementation_records/2026-07-14_FE-R03_legacy-audio-facade-cleanup.md` | 四工具只消费 standalone 配置；legacy 字段只读保留一个兼容版本；下一步 `I18N-R01` |
| I18N-R01 | 未开始 | — | 清理旧语义并增加源码翻译 key 门禁 | `scripts/check-i18n-usage.mjs`、`src/locales/*` | 两个 i18n scripts、raw-key smoke | — | 10 个已知缺失 key 先随 PRE-R01 补齐 |
| TEST-R01 | 未开始 | — | 迁移、registry、runtime、builder 与组件自动化矩阵 | audio tests/fake server | targeted + full vitest、tsc | — | 依赖实现包 |
| QA-R01 | 未开始 | — | Electron 四语言两尺寸交互矩阵 | e2e/验收记录 | 4 locales x 2 sizes；等待 loading 退出 | — | 依赖 FE/I18N/TEST |
| QA-R02 | 未开始 | — | 真实 OpenAI/MiMo 与真实设备验收 | 验收记录 | 真实 ASR/TTS/realtime/mic/speaker | — | 不得记录 Key、Base64 或敏感 payload |
| DOC-R01 | 未开始 | — | 发布文档、旧设计关系与迁移说明收口 | README/CHANGELOG/design/plan | 文档检查、diff check | — | 依赖 QA |

## 6. 已完成工作包：FE-R02

目标：让文本转音频完全消费独立音频 API assignment/routes，按 registry constraints
只展示可提交字段，并闭环三模式 intent 与 voice clone 一次性授权。

实施范围：

- Speech store 升至 v5，`mimoMode` 迁为 `speechMode`，删除 profile defaults 播种；
  只持久化 preferences，各模式文本草稿可恢复，runtime 授权和任务状态不 hydration。
- 可用模式只来自当前 profile 的 enabled speech routes；0 route 用精确设置 CTA，1 route
  隐藏模式控件，2～3 route 只显示可用项，失效模式按 preset-first 规则回退并提示。
- voice、instructions、style、design、reference、format、speed、stream 由 constraints
  条件渲染；隐藏字段不进 DOM，也不进入 discriminated intent payload。
- voice clone 选择即授权；token 一次消费后保留 runtime `File` 并自动重新授权。替换、
  清除、profile 变化、离页和迟到响应都执行 owner-bound 幂等 revoke。
- 提交入口使用同步预检锁防止快速双击复用 token；授权回来后校验配置/文件快照。
  `{ ok: false }` 撤销保留在跨路由队列中重试，幂等 `revoked: false` 视为成功。
- speech input/instructions 的公共 4096 上限由共享常量写入所有 route constraints，
  renderer/public IPC/main 按同一合同校验；v4 真实 hydration 证明仅 preferences 进入 v5。
- 共享 shell 的主摘要改为音频 API、状态、供应商和模式；transport/model 收进技术详情，
  设置入口固定为 `/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Fspeech-synthesis`。
- 四语言清除旧 model mismatch/长期 disabled 语义；Electron 覆盖零配置、OpenAI 实际
  生成、MiMo 三模式 × stream on/off、双击防重、二路由 fallback、真实 WAV 授权与 clone。

验收口径：

- 定向 config/store/service/IPC：6 files / 113 tests；全量非 Electron Vitest：
  85 files / 727 tests；Electron E2E：1 file / 4 tests，全部通过。
- TypeScript、四语言 i18n（各 1514 keys）、Vite test build、`git diff --check` 通过；
  构建只有既有 dynamic-import/chunk-size warning。
- 1280×800 双栏/clone 侧栏、786×540 模式区与工作区共 4 张截图确认 loading 已退出、
  字段无溢出、固定底栏不遮挡关键控件；页面级横向溢出为 false。
- 未运行 pnpm，`package.json`/`pnpm-lock.yaml` 未改；Electron/fake server 均由 E2E
  `afterAll` 关闭，最终仍需在回复前再次确认进程表为空。

过渡边界：

- M2“可信路由闭环”已达成；`FE-R03` 已完成四个工具的 standalone 消费者竖切及
  legacy facade cleanup。
- `I18N-R01` 的源码 key usage checker、`TEST-R01`/`QA-R01` 完整门禁及 `QA-R02`
  真实供应商/设备验收保持未完成。

## 7. 最近完成工作包：FE-R03

已完成首段：让音频转文本完全消费 standalone audio assignment/route，并按
`providerPreset + transport + route.model` 解析 GPT Transcribe、Whisper、MiMo 和
custom-compatible 的字段/校验矩阵。

本段同时闭环：

- transcriber store v4 只持久化 preferences，文件、token、结果和任务态不 hydration；
- 输入文件 token 一次消费、二次提交重新授权、替换/清除/离页撤销；
- runtime sync 到 main dispatch 的可取消预检、route/unmount 跨路由取消重试；
- 输出目录选择 generation/mounted guard、owner-bound revoke IPC 和 bounded retry；
- 输出模式使用完整 Radix radio 交互面，覆盖 roving tabindex、方向键、Home/End；
- Electron 实际完成 GPT/Whisper/MiMo 字段切换、双击防重、两次提交与宽窄截图。

实时字幕第二段也已闭环：

- 页面消费 standalone `realtimeCaptions` assignment/route，并按完整
  `providerPreset + transport + route.model` 区分 OpenAI WebRTC 与 MiMo 分块近实时；
  MiMo 语言与 route-aware ASR 共用 `auto/zh/en` 约束。
- captions store 升至 v4，只持久化 sanitized preferences；v3 与同版本污染 envelope
  均不恢复 session、字幕、partial、错误或 profile defaults 播种状态。
- OpenAI 才渲染完整 Radix 输入格式 RadioGroup；MiMo 不渲染 WebRTC-only 字段；
  永久不可用的 turn detection、assistant transcript、instructions 不再进入 DOM。
- route/profile 改变、离页与迟到启动结果使用 generation + AbortController 清理；chunk
  sync→dispatch 接入 signal gate，已 dispatch requestId 与 Realtime session stop 进入带
  timeout/backoff/TTL 的跨路由清理队列，本地媒体释放不等待远端 IPC。
- Electron 覆盖零配置 CTA、OpenAI/MiMo summary 与字段矩阵、MiMo 精确语言集合、
  RadioGroup click/Arrow/Home/End、store persistence、1280×800 与 786×540 三张截图。

双向语音第三段也已闭环：

- 页面消费 standalone `realtimeVoice` assignment/route；无 route 只展示精确设置 CTA。
- Voice store v4 仅持久化 sanitized preferences；profile defaults 和运行时状态不 hydration。
- input/output format 使用完整 Radix RadioGroup；manual turn detection 不进入 DOM。
- route/profile 变化、启动中 Abort、late result、快速双击与 response-scoped interrupt 均闭环。
- `response.done` 与 output buffer 播放生命周期分离；buffer `stopped/cleared` 才确认打断，
  生成完成但缓冲仍播放时仍可打断。
- WebRTC service 支持 RTC 启动步骤 Abort/超时、streamless track、owned remote audio
  detach、late track、play failure 与 local track ended 清理。
- Electron 覆盖 standalone/legacy 隔离、字段矩阵、Store v4、RadioGroup 键盘语义、
  快速双击和宽窄截图。

最后 legacy facade cleanup 也已闭环：

- `AudioToolShell` 只接受必传 standalone summary 和精确设置路径，不再读取
  `useModelStore`。
- `useModelStore` 删除 legacy audio CRUD/selectors/runtime helper 与迁移完成后的永久文本
  删除保护；`audioProfiles/audioAssignment` 仅作为一个兼容版本的只读持久化备份。
- 旧备份不再按文本 connection id 过滤，删除文本 profile 不会级联破坏迁移源；hydration
  前跨 key bootstrap 保持不变。
- 若启动时 bootstrap 写入/校验失败，被旧 audio profile 引用的文本 connection 在本会话
  保持不可删除并提示重启；下一次启动在 Audio Store hydration 前完成重试后才放行。
- 删除未挂载的 `AudioModelConfig.tsx` 和 `audioToolConfig` legacy resolver/selector，
  四个工具显式传入 standalone summary。

状态标记为 `已完成`；下一工作包为 `I18N-R01`。
ASR 终审修复见 `fix/2026-07-14_FIX-R03_asr-lifecycle-accessibility.md`，实时字幕
route/lifecycle 闭环见 `fix/2026-07-14_FIX-R03_realtime-captions-routing-lifecycle.md`，
双向语音闭环见 `fix/2026-07-14_FIX-R03_realtime-voice-routing-lifecycle.md`。

## 8. 实施记录模板

````markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
````
