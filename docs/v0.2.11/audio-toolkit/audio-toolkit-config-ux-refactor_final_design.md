# 音频 API 配置与语音合成 UX 重构 Final Design

> 日期：2026-07-12
> 状态：实施中（`PRE-R01`、`CORE-R01`、`BE-R01`、`FE-R01`、`FE-R02`、`FE-R03`、`I18N-R01` 已完成；下一步 `TEST-R01`）
> 范围：独立音频 API 配置、音频任务默认分配、音频运行时路由、文本转音频页面、i18n 与迁移兼容
> 关系：本设计继承原音频工具箱的 adapter、IPC 安全、文件、流式与 Realtime 合同，但正式替代原设计中的配置模型、TTS 模式/模型关系、字段禁用规则和相关验收口径。
> 执行计划：[音频 API 配置与语音合成 UX 重构 Execution Plan](audio-toolkit-config-ux-refactor_execution_plan.md)

## 0. 评审结论

当前问题不是一个按钮条件或一个表单布局问题，而是配置职责设计错误：

- API Key、Base URL 放在通用文本模型档案里，音频用户必须先填写音频运行时根本不会使用的文本模型、API 格式、价格等信息。
- 音频档案只保存一个 TTS 模型，却同时在设置页保存 MiMo TTS 模式、在工具页再次选择模式。
- 工具页模式与全局单一模型要求精确匹配，用户可以切进一个必然无法提交的模式。
- 原设计明确要求“不适用控件继续可见但 disabled”，造成页面长期展示大量与当前供应商、模式无关的灰色配置。
- i18n 校验只比较四种语言是否同构，无法发现四种语言同时遗漏同一源码引用 key。

本次重构的最终决策如下：

1. 新增完全独立的“音频 API”配置实体，直接拥有 API Key、Base URL、供应商模板和音频任务路由，不再引用通用 `ModelProfile`。
2. 设置页新增独立“音频”导航；“模型”页只管理文本/Agent 模型。
3. 音频 API 配置只回答“连接到哪里、凭证是什么、支持哪些任务、每条任务路由使用哪个内部模型”，不保存语言、voice、输出格式、是否流式或 TTS 默认模式。
4. 设置页只选择四类音频任务默认使用哪条音频 API；TTS 生成模式只在工具页选择一次。
5. 一条 MiMo 音频 API 同时提供预置音色、音色设计、音色复刻三条内部路由。用户切模式后，由 main runtime 自动选择相应模型。
6. 工具页只渲染当前供应商、当前模式真正有意义的字段；只有运行中、校验中等暂态可以使用 disabled。
7. renderer 仍不得提交 API Key、Base URL、transport 或任意模型 ID；继续保留 sender-bound snapshot、revision 和文件 token 安全边界。
8. 增加“源码引用 key 必须存在”检查和实际交互测试，不能再用“语言 key 数量相同、页面能挂载”替代产品链路验收。

## 1. 背景与现状

### 1.1 当前用户路径

当前从零开始使用文本转音频，需要经过四层：

```text
创建通用模型档案
  填 API Key / Base URL
  还必须理解文本模型、API 格式、Token 参数、价格
        ↓
创建音频档案
  再选择上一步的“连接 Profile”
  再选 dialect、单一 TTS model、默认 TTS mode
        ↓
在“音频任务分配”中选择该音频档案
        ↓
进入文本转音频工具，再选择一次生成模式
```

对应实现：

- `src/pages/Setting/components/ModelConfig.tsx` 同页依次渲染文本模型分配、文本模型档案和 `AudioModelConfig`。
- `src/pages/Setting/components/AudioModelConfig.tsx` 在没有通用 profile 时禁用“添加音频档案”，创建时必须选择 `connectionProfileId`。
- `src/store/useModelStore.ts` 把 `profiles`、`audioProfiles` 和两套 assignment 混在同一个 `fusionkit-model` 持久化 store。
- `src/type/audio.ts` 的 `AudioModelProfile` 只有一个 `models.speechSynthesis`，同时又保存 `defaults.mimoTtsMode`。
- `src/store/tools/audio/useSpeechSynthesizerStore.ts` 再持久化一份 `preferences.mimoMode`。

### 1.2 当前字段归属

| 信息 | 当前归属 | 音频运行时是否使用 | 问题 |
| --- | --- | --- | --- |
| API Key / Base URL / provider | 通用 `ModelProfile` | 使用 | 音频必须依赖文本模型配置 |
| 通用 modelKey / API format / token pricing | 通用 `ModelProfile` | 不使用 | 用户被迫填写无意义信息 |
| Audio dialect | `AudioModelProfile` | 使用 | 与连接 provider/baseUrl 可任意错配 |
| 单一 ASR/TTS/Realtime model | `AudioModelProfile` | 使用 | 单一 TTS model 无法表达三种模式 |
| MiMo TTS mode | API profile defaults + 工具 preferences | 使用工具页值 | 双重来源、覆盖规则不透明 |
| voice / format / stream / language | API profile defaults + 工具 preferences | 使用工具页值 | API 配置与任务偏好混杂 |

renderer 同步运行时快照时，只从通用 profile 取 `id/provider/apiKey/baseUrl`；通用 modelKey、价格和文本 API format 会被丢弃。也就是说，用户当前填写的大量前置字段只是配置噪声。

### 1.3 MiMo 三模式被锁死的根因

项目在三处复制了相同的 mode → model 映射：

- `src/pages/Setting/components/AudioModelConfig.tsx`
- `src/store/tools/audio/speechSynthesizerConfig.ts`
- `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`

当前约束为：

| 工具页模式 | runtime 期望模型 |
| --- | --- |
| `preset_voice` | `mimo-v2.5-tts` |
| `voice_design` | `mimo-v2.5-tts-voicedesign` |
| `voice_clone` | `mimo-v2.5-tts-voiceclone` |

设置页的一个音频档案只能保存其中一个 `speechSynthesis` model；工具页却始终展示三种模式。`resolveSubmitIssueKey` 要求“工具页模式对应模型 === 全局单一模型”，不相等就产生 `mimo_model_mismatch`，生成按钮随之禁用；main adapter 又做一次同样的拒绝。

因此，配置 `mimo-v2.5-tts` 后只能使用“预置音色”不是偶发 bug，而是当前架构必然产生的死路。

### 1.4 Profile defaults 不是可靠默认值

`useSpeechSynthesizerStore` 使用 `profileDefaultOverrides` 记录用户是否改过 voice、format、mode、stream。该标记不是按 profile 存储，并会持久化：

1. 用户在某个 profile 下改过 `mimoMode`。
2. `profileDefaultOverrides.mimoMode` 永久变成 true。
3. 用户切换到另一个 profile。
4. 新 profile 的 `defaults.mimoTtsMode` 不再生效。
5. 历史模式可能与新 profile 的单一模型不匹配，生成按钮直接禁用。

这说明“API 配置里的任务默认值”不仅职责不正确，而且实现上也无法稳定兑现。

### 1.5 当前 i18n 缺口

四套 `audio.json` 同时缺少以下 10 个源码实际引用的 key：

| 缺失 key | 使用场景 |
| --- | --- |
| `audio:pages.speech.config` | 配置区 sr-only legend |
| `audio:speech.fields.file_name_hint` | 文件名 label |
| `audio:speech.hints.file_name_hint` | 文件名 hint |
| `audio:speech.placeholders.file_name_hint` | 文件名 placeholder |
| `audio:speech.errors.cancel_not_confirmed` | 取消未确认 |
| `audio:speech.errors.playback_failed` | 播放失败 |
| `audio:speech.errors.runtime_failed` | runtime 失败 |
| `audio:runtime_error.technical_details` | 技术详情 |
| `audio:speech.errors.input_too_long` | 输入过长 |
| `audio:speech.errors.instructions_too_long` | instructions 过长 |

`scripts/check-i18n.mjs` 目前只比较各 locale 的 namespace/key 集合。四种语言同时缺失相同 key 时仍会通过，所以“1410 keys 对齐”与页面显示 raw key 可以同时发生。

## 2. 目标、非目标与成功标准

### 2.1 目标

1. 新用户无需任何文本模型配置，即可独立完成音频 API 配置并使用音频工具。
2. 第一条音频 API 从创建到可用于兼容任务，最多一个配置对话框和一次保存。
3. 同一条 MiMo API 在文本转音频页可直接切换三种模式，不需要返回设置页改模型。
4. 设置页不出现“TTS 默认模式”；工具页不要求用户理解“模式对应哪个 model ID”。
5. 不适用于当前供应商/模式的字段不进入 DOM，不用灰色 disabled 控件堆满页面。
6. 工具提交 payload 只包含任务意图和任务参数，模型路由由 main 侧可信配置解析。
7. 旧用户配置自动迁移，文本模型配置、音频 assignment 和可恢复凭证不丢失。
8. 四语言页面不再出现 raw i18n key，且 CI 能阻止同类回归。

### 2.2 非目标

- 不重写已经可工作的 OpenAI Audio、MiMo Chat Audio、OpenAI Realtime adapter 协议转换。
- 不改变文件 token、输出 token、sender/revision、取消和资源清理安全合同。
- 不在本轮增加新的音频供应商。
- 不把 API 配置重新散落到每个工具详情页。
- 不允许 renderer 通过“高级模式”直接覆盖 main 解析出的任意 model ID。
- 不把本设计扩大为四个音频工具页面的整体视觉重做；其他三页只迁移配置入口、摘要和共同的字段显隐原则。

### 2.3 可验收成功标准

- 没有任何文本 `ModelProfile` 时，“设置 → 音频”仍可添加 MiMo/OpenAI 音频 API。
- 音频 API 表单中不存在 connection-profile selector 和 TTS mode selector。
- 一条 MiMo API 下，`3 modes × stream on/off` 六种组合均能进入提交路径并解析到正确模型。
- 页面不存在 `mimo_model_mismatch` 这一用户可触发状态。
- OpenAI 页面 DOM 中不存在 MiMo 模式区、音色设计和音色复刻控件。
- MiMo 每种模式 DOM 中只存在当前模式字段。
- 所有静态/可枚举的翻译 key 均可由 `i18n.exists` 解析。
- Electron 交互测试会实际切换模式、填写必填字段并断言 CTA 可用，而不只检查标题、正文长度或横向溢出。

## 3. 产品职责边界

### 3.1 配置层与使用层

| 层级 | 应回答的问题 | 应包含 | 不应包含 |
| --- | --- | --- | --- |
| 音频 API 配置 | 请求发到哪里、如何鉴权、哪些任务路由可用 | 名称、供应商模板、Base URL、API Key、内部 route/model、验证状态 | TTS 默认模式、voice、语言、输出格式、stream、输出目录 |
| 音频任务默认分配 | 每类工具默认使用哪条 API | transcription / speech / captions / realtime voice assignment | 任何任务参数 |
| 工具详情页 | 这一次任务怎么执行 | 模式、文本、voice、设计描述、参考音频、输出偏好 | API Key、Base URL、任意 model ID |
| main runtime | 本次任务实际走哪条协议和模型 | assignment + task intent → trusted route | 接受 renderer 指定连接或模型 |

核心产品规则是：

> 设置页选择“默认使用哪条音频 API”；工具页选择“这次如何生成”。TTS 模式只选择一次，且只属于工具任务。

### 3.2 字段状态语义

以后统一使用以下规则：

| 状态 | UI 行为 | 示例 |
| --- | --- | --- |
| 与当前供应商/模式无关 | 不渲染 | voice design 时不显示预置 voice |
| 系统推导、用户无法改变 | 文本/Badge 摘要，不伪装成表单控件 | MiMo 流式输出为 PCM16、最终保存 WAV |
| 当前可编辑 | 正常表单控件 | voice clone 的参考音频 |
| 暂时不可编辑 | disabled，并说明暂态原因 | 请求运行中锁定本次请求参数 |
| 配置缺失 | 用设置 CTA 替换无效操作 | 没有 speech assignment 时显示“配置音频 API” |
| 校验失败 | 字段就近错误 + 顶部汇总 | 参考音频超限 |

“供应商不支持”不是暂态，不能用长期 disabled 控件表达。

## 4. 目标信息架构

### 4.1 设置页导航

当前 `TabKey` 为 `general | proxy | model`。重构后：

```text
设置
  通用
  代理
  模型
    文本 / Agent 模型分配
    文本模型档案
  音频
    默认使用
    音频 API
```

“音频”必须是独立导航，不再嵌在 `ModelConfig` 底部。

### 4.2 音频设置页结构

页面由两张主卡片组成：

1. 默认使用
   - 音频转文本
   - 文本转音频
   - 实时字幕
   - 双向语音
   - 每项只选择一条具备相应 route 的音频 API
2. 音频 API
   - API 名称
   - 供应商
   - Base URL 摘要
   - 已配置任务能力
   - 当前被哪些任务使用
   - 验证状态
   - 编辑/删除

模型 ID 和 transport 属于“技术详情/高级设置”，不在列表主视觉中抢占用户注意力。

### 4.3 首次配置流程

```text
工具页检测到未配置
  ↓
“配置音频 API”
  跳转 /setting?tab=audio&returnTo=<current-tool>
  ↓
“添加音频 API”
  选择 OpenAI / MiMo / OpenAI-compatible
  填写名称、Base URL、API Key
  内置模板自动准备任务 routes
  ↓
保存
  若是第一条 API：提示并默认分配所有兼容且尚未分配的任务
  若已有 API：不静默覆盖现有 assignment
  ↓
“保存并返回工具”
```

第一条 API 的自动分配必须在保存结果中明确列出，并提供撤销；撤销必须采用
compare-and-clear，只清理仍指向该新 API 的自动分配，不能覆盖用户随后手选的结果。
`returnTo` 只接受四条精确的音频工具路径；普通“保存”留在设置页展示持久反馈，
“保存并返回”才导航回白名单内的来源工具。

### 4.4 添加/编辑音频 API

对话框继续使用项目的 `ScrollableDialog`，分为三段：

1. 服务
   - OpenAI
   - MiMo
   - 自定义 OpenAI-compatible
2. 连接
   - 配置名称
   - Base URL
   - API Key
   - 代理沿用全局代理设置，只显示状态/跳转，不重复配置
3. 能力与高级路由
   - 内置供应商显示已准备的能力摘要
   - MiMo 默认一次性准备 ASR 和三种 TTS route
   - OpenAI 可在同一 API 配置中同时准备 file audio 与 realtime route，不再因 dialect 单选而创建两份 profile
   - 自定义供应商才展开 route/model 映射

跨供应商切换必须清空上一供应商的 API Key，并重置 Base URL 与 routes；重复选择
当前供应商保持表单不变，避免误清用户正在填写的凭证。

表单中明确禁止出现：

- “连接 Profile”
- “默认 TTS 模式”
- 默认 voice
- 默认语言
- 默认输出格式
- 默认是否流式

这些都是任务偏好，不是 API 连接属性。

### 4.5 编辑与删除

- 修改凭证或路由不应清空工具草稿。
- 编辑 routes 后必须在同一次 Store 提交中重验当前 assignment，并清空不再兼容的
  任务；若“保存并返回”，清理结果仍需通过带任务清单的全局反馈明确告知用户。
- 路由变更后，工具页重新计算可用模式；如果当前模式消失，按“预置音色优先，否则第一条可用 route”回退，并显示一次非阻断提示。
- 删除未使用 API：二次确认。
- 删除正在被 assignment 使用的 API：对话框列出受影响任务，要求选择替代 API
  或确认将这些任务置为未配置；替换 map 全量校验通过后，assignment 更新与 profile
  删除必须在同一次 Store 提交中完成，任一项无效时零写入。
- 文本模型档案与音频 API 生命周期完全解耦，删除任一方不再阻止另一方。

## 5. 目标领域模型

### 5.1 独立音频 API

建议用新的 `useAudioApiStore` 和独立持久化 key `fusionkit-audio-settings`：

```ts
export type AudioProviderPreset =
  | "openai"
  | "mimo"
  | "custom_openai_compatible";

export type AudioTransport =
  | "openai_audio"
  | "mimo_chat_audio"
  | "openai_realtime";

export type SpeechSynthesisMode =
  | "preset_voice"
  | "voice_design"
  | "voice_clone";

export interface AudioRoute {
  transport: AudioTransport;
  model: string;
  enabled: boolean;
}

export interface AudioApiProfile {
  id: string;
  name: string;
  providerPreset: AudioProviderPreset;
  baseUrl: string;
  apiKey: string;
  routes: {
    transcription?: AudioRoute;
    speechSynthesis: Partial<
      Record<SpeechSynthesisMode, AudioRoute>
    >;
    realtimeCaptions?: AudioRoute;
    realtimeVoice?: AudioRoute;
  };
  verification?: Partial<
    Record<string, {
      status: "untested" | "verified" | "degraded" | "failed";
      updatedAt?: string;
    }>
  >;
  migration?: {
    source: "legacy_audio_profile";
    sourceId: string;
    needsAttention?: boolean;
  };
}

export type AudioTaskAssignment = Record<
  "transcription" |
  "speechSynthesis" |
  "realtimeCaptions" |
  "realtimeVoice",
  string | null
>;
```

关键变化：

- 删除 `connectionProfileId`。
- 删除 profile 级单选 `audioDialect`；transport 下沉到每条 route，因此一个 OpenAI API 可以同时服务 file audio 和 realtime。
- 删除扁平 `capabilities`；实际能力从已启用 route 与统一 provider constraints 推导。
- 把 `models.speechSynthesis: string` 改为 `speechSynthesis[mode]`。
- 删除整个 `defaults`，尤其 `mimoTtsMode`。
- 不再复用文本侧 `Model` enum。

### 5.2 单一 Provider Registry

新增无 UI 副作用的共享 registry，例如：

```text
src/lib/audio-provider-registry.ts
```

它是设置页、工具页、main resolver、adapter 校验和测试的共同事实来源，至少包含：

- provider preset 默认 Base URL；
- 默认 route/model；
- 每条 route 支持的任务；
- TTS mode 输入约束；
- 可选输出格式；
- streaming 支持；
- voice、instructions、speed、style、reference audio 等字段能力；
- endpoint normalization strategy。

MiMo 当前三模型映射只保留一份：

```ts
speechSynthesis: {
  preset_voice:  { transport: "mimo_chat_audio", model: "mimo-v2.5-tts" },
  voice_design:  { transport: "mimo_chat_audio", model: "mimo-v2.5-tts-voicedesign" },
  voice_clone:   { transport: "mimo_chat_audio", model: "mimo-v2.5-tts-voiceclone" },
}
```

内置值是产品预设，不是让普通用户先选择“默认模式”。自定义 API 可以在高级区覆盖或补充 route，但所有已配置 route 都同时可用。

### 5.3 工具偏好

`fusionkit-speech-synthesizer` 继续保存用户在工具页的草稿和偏好，但调整为：

- `mimoMode` 重命名为 provider-neutral `speechMode`。
- 删除 `profileSeedKey` 和 `profileDefaultOverrides`。
- API profile 不再向工具 store 播种 task defaults。
- 各模式草稿可以保留，切回模式时恢复；请求构造必须使用 discriminated union，只发送当前模式字段。
- voice sample 等文件授权仍只保存在当前运行会话，不把真实路径持久化。

如果未来确实需要“全局工具默认值”，应新增独立 `AudioToolPreferences`，不能重新塞回 `AudioApiProfile`。

## 6. Runtime 路由与 IPC 合同

### 6.1 从 resolveModel 改为 resolveRoute

`BE-R01` 前 main 只按 assignment 解析一个固定模型：

```text
speechSynthesis assignment
  → AudioModelProfile.models.speechSynthesis
```

`BE-R01` 已实现：

```text
speechSynthesis assignment
  → AudioApiProfile
  → request.speechIntent.mode
  → profile.routes.speechSynthesis[mode]
  → trusted transport + model
  → adapter
```

main 侧解析顺序：

1. 校验 renderer owner 与 config revision。
2. 用 `assignmentKey` 找到默认音频 API。
3. 用 provider-neutral task intent 找到对应 route。
4. 确认 route 已启用且字段能力匹配。
5. 解析文件 token、输出授权与取消 controller。
6. 把可信 `transport/model/apiKey/baseUrl` 交给 adapter。

### 6.2 Provider-neutral TTS 请求

IPC 合同采用可判别的 provider-neutral 任务意图：

```ts
export type SpeechSynthesisIntent =
  | {
      mode: "preset_voice";
      voice: string;
      styleInstruction?: string;
    }
  | {
      mode: "voice_design";
      voiceDesignPrompt: string;
      optimizeTextPreview?: boolean;
    }
  | {
      mode: "voice_clone";
      voiceSampleToken: string;
      styleInstruction?: string;
    };

export interface CreateSpeechSynthesisIpcRequest {
  assignmentKey: "speechSynthesis";
  requestId?: string;
  input: string;
  intent: SpeechSynthesisIntent;
  responseFormat: AudioSpeechResponseFormat;
  instructions?: string;
  speed?: number;
  stream?: boolean;
  outputPathMode?: AudioOutputPathMode;
  outputDirToken?: string;
  fileNameHint?: string;
}
```

renderer 提交 `mode` 是提交用户任务意图，不是提交模型选择。main 根据可信 profile routes 选择模型。

OpenAI 标准 TTS 也可使用 `preset_voice` intent；provider constraints 决定它是否接受 instructions、speed、格式或 stream。

`CreateSpeechSynthesisRequest` 继续作为 main → adapter 的可信内部 DTO：main
在完成 revision、assignment、intent route、字段约束和文件/目录 token 解析后，
才把可信 `voice`、`mimoOptions.voiceSamplePath`、`outputDir` 与 adapter model
写入该 DTO。`FE-R02` 已移除 renderer 侧 legacy speech request 输入；public IPC
只接受 `CreateSpeechSynthesisIpcRequest`，其中 `intent` 是 provider-neutral 用户任务意图，
renderer 无法提交路径或模型配置。

### 6.3 错误合同

删除用户可见的 `mimo_model_mismatch`。新的错误边界：

| 错误 | 含义 | UI |
| --- | --- | --- |
| `audio_api_not_configured` | 当前任务没有 assignment | 设置 CTA |
| `audio_route_not_configured` | API 不再提供当前任务/模式 route | 自动回退；无可回退时设置 CTA |
| `audio_route_unverified` | route 未真实验收 | 可继续时 warning，不伪装为不支持 |
| `invalid_task_parameters` | 当前可见字段不满足约束 | 字段就近提示 |
| `stale_audio_config` | revision 过期 | 自动重同步一次，失败再提示 |

模式与模型的内部映射错误属于开发/迁移错误，应记录脱敏技术详情，不能让普通用户通过正常 UI 进入这种状态。

### 6.4 必须保留的安全边界

- task payload 不得携带 API Key、Base URL、provider preset、transport 或 model。
- runtime snapshot 继续绑定 renderer sender，并使用 revision 防止 sync→invoke 竞态。
- voice clone 参考音频继续使用 main 签发的一次性 token；renderer 不提交可信文件路径。
- 文件 token 撤销必须同时检查 Promise rejection 与 `{ ok: false }`；renderer 在清空 UI
  token 前把 handle 放入跨路由重试队列，`revoked: false` 作为幂等成功处理。
- 输出目录与结果文件继续使用授权 token。
- adapter 错误、日志和文档不得输出 API Key、Base64 音频或完整敏感 payload。
- renderer 只能选择 profile 已声明的 mode，不能把自定义 model 夹带进 task payload。

## 7. 文本转音频页面交互

### 7.1 页面结构

```text
标题：文本转音频
当前使用：MiMo 音频 API · 已就绪        [更改]

┌ 配置区 ───────────────────────────┐
│ 生成模式  [预置音色][音色设计][音色复刻] │
│                                    │
│ 当前模式真正需要的字段              │
│                                    │
│ 输出                               │
│ 生成方式 / 输出位置 / 文件名         │
└────────────────────────────────────┘

┌ 工作区 ───────────────────────────┐
│ 合成文本                            │
│ 当前模式对应的主输入                 │
│ 字段错误                            │
│ [生成音频] [取消]                   │
│ 结果 / 播放器 / 打开输出             │
└────────────────────────────────────┘
```

顶部摘要以“API 名称 + 就绪状态”为主。真实 model/transport 放入“技术详情”，避免再次把内部路由变成用户必须理解的产品概念。

“更改”直接跳转 `/setting?tab=audio`，并携带 returnTo。

### 7.2 模式可用性

`availableModes` 只来自当前音频 API 的 `routes.speechSynthesis`：

- 0 个：显示配置错误 CTA，不显示模式控件和生成按钮。
- 1 个：直接进入该模式，不显示没有选择意义的 segmented control。
- 2～3 个：只渲染可用模式。
- assignment 改变后当前模式仍可用：保持。
- 当前模式不可用：优先回退 `preset_voice`，否则回退第一条 route，并提示“已根据新的音频 API 切换生成模式”。

用户不应看到一个可以点击但必然无法提交的模式。

### 7.3 字段显隐矩阵

`✓` 表示显示；`—` 表示不渲染。

| 字段 | OpenAI/兼容标准 TTS | MiMo 预置音色 | MiMo 音色设计 | MiMo 音色复刻 |
| --- | --- | --- | --- | --- |
| 模式选择 | 仅多 route 时 | ✓ | ✓ | ✓ |
| 合成文本 | ✓ 必填 | ✓ 必填 | ✓；优化预览允许时可选 | ✓ 必填 |
| Voice / 预置音色 | ✓ | ✓ | — | — |
| OpenAI instructions | route 支持时 ✓ | — | — | — |
| 风格指令 | route 支持时 ✓ | ✓ | — | ✓ |
| 语速 | route 支持时 ✓ | — | — | — |
| 音色设计描述 | — | — | ✓ | — |
| optimize text preview | — | — | route 支持时 ✓ | — |
| 参考音频 | — | — | — | ✓ |
| 输出格式选择 | 多个可选格式时 ✓ | — | — | — |
| 流式开关 | 用户可选择且 route 支持时 ✓ | 同左 | 同左 | 同左 |
| 输出位置 | ✓ | ✓ | ✓ | ✓ |
| 文件名 | ✓ | ✓ | ✓ | ✓ |

补充规则：

- 如果某 route 只有一种格式，不显示 disabled 下拉；显示“输出：WAV”等摘要。
- MiMo 流式内部使用 PCM16、最终保存 WAV时，显示说明文字，不展示一个锁死的“PCM16”选择器。
- 自选目录选择器只在 `outputMode === custom_dir` 时渲染。
- OpenAI 下整个 “MiMo 配置”区不存在。
- voice design 下不显示风格指令，因为当前 builder 不会发送它；不能允许用户输入后静默丢弃。
- 生成中可以用 fieldset 锁定本次请求参数，但取消按钮必须保持可用。

### 7.4 模式切换与草稿

- 每个模式的文本字段草稿可在 store 中保留，切换模式时不丢失。
- 隐藏字段不得进入当前请求。
- voice sample 切离 clone 模式后可在本次页面会话保留，离页或 profile 变化时释放 token。
- 结果区不因切换模式自动清空；下一次生成开始时再进入新的 task generation。
- 提交预检、文件重新授权和请求运行中均不允许切换 mode，原因是它会改变本次可信
  route；提交入口用同步锁防止双击复用一次性 token，授权返回后还必须校验
  profile/provider/route/mode/sourceFile 快照。

### 7.5 生成按钮

生成按钮只因以下情况不可用：

- 请求正在预检或运行；
- 当前任务没有音频 API/route；
- 当前可见必填字段缺失或校验失败；
- 文件授权/校验仍在进行；
- 自选输出目录尚未选择。

生成按钮不得因为“当前全局模型与模式不匹配”禁用，因为新架构中 model 由 mode 自动路由。

当配置未就绪时，用“配置音频 API”主按钮替换灰色“生成音频”，不要展示一个用户无法自行修复原因的禁用 CTA。

### 7.6 Voice design 空输入语义

当前 UI 与 IPC 对 `optimizeTextPreview` 的规则不一致。最终合同统一为：

- `optimizeTextPreview = false`：合成文本与 voice design prompt 均按供应商合同校验。
- `optimizeTextPreview = true`：允许合成文本为空；voice design prompt 是否可空必须由 provider registry 的 route constraints 唯一决定。
- renderer、IPC validator、main adapter 和测试都读取同一 constraints，不再各自硬编码。
- 当前公共安全上限为 input 4096 字符；支持 instructions 的 route 同样为 4096。
  常量、registry、renderer 和 main route validator 必须保持一致。

### 7.7 响应式与可访问性

- 1280×800 保持双栏；786×540 使用单栏，不产生横向滚动。
- 三模式 segmented control 在窄宽下等宽换行或切换为 Select，但语义保持 radiogroup。
- 条件渲染后焦点移动到新模式首个主要字段。
- 所有模式按钮提供可读 label、选中态和键盘切换。
- 错误使用 `aria-describedby` 绑定字段，运行/完成状态使用适度 live region。
- 不用 opacity-only 表达不可用能力。

## 8. 其他音频工具的影响

### 8.1 音频转文本

- assignment 改为独立 `AudioApiProfile`。
- language、response format、prompt、timestamp、stream 继续属于工具偏好，不回到 API profile。
- 字段显隐从实际 transcription route constraints 推导。
- Whisper、GPT transcribe、MiMo、unknown-compatible 的矩阵仍保留，但只有可用格式进入 Select；不适用字段不渲染。

### 8.2 实时字幕

- 同一 OpenAI 音频 API 可提供 realtime route；无需为同一 Key 再建一个“OpenAI Realtime 音频档案”。
- MiMo 分块字幕使用 transcription route，UI 继续明确标注“分块近实时”，不得显示为 WebRTC。

### 8.3 双向语音

- 只有存在 `realtimeVoice` route 的 API 可被 assignment。
- 工具页不显示不支持 provider 的灰色会话控件；无 route 时显示可操作的设置 CTA。

### 8.4 共享 AudioToolShell

`AudioToolShell` 摘要调整为：

- 主信息：音频 API 名称、就绪状态。
- 次信息：供应商、当前任务能力。
- 技术详情：transport、实际 model、验证状态。
- 设置入口：精确 deep link 到音频设置，不再只跳到 `/setting`。

## 9. i18n 设计与发布门禁

### 9.1 当前 10 个缺失 key

实施第一批必须补齐第 1.5 节列出的 10 个 key。建议简体中文基线：

| key | zh 建议文案 |
| --- | --- |
| `pages.speech.config` | 语音合成设置 |
| `speech.fields.file_name_hint` | 文件名（可选） |
| `speech.hints.file_name_hint` | 无需填写扩展名，系统会根据输出格式补全。 |
| `speech.placeholders.file_name_hint` | 例如：产品介绍旁白 |
| `speech.errors.cancel_not_confirmed` | 未能确认取消，请稍后重试。 |
| `speech.errors.playback_failed` | 音频播放失败。 |
| `speech.errors.runtime_failed` | 音频生成失败，请检查音频 API 配置或稍后重试。 |
| `runtime_error.technical_details` | 技术详情 |
| `speech.errors.input_too_long` | 合成文本超出当前 API 支持的长度。 |
| `speech.errors.instructions_too_long` | 生成指令超出当前 API 支持的长度。 |

同时删除或改写旧的“模式必须匹配设置页全局 TTS 模型”“非 MiMo 禁用”“MiMo instructions disabled”等已经失去产品语义的文案。

### 9.2 新检查机制

`I18N-R01` 已保留 `scripts/check-i18n.mjs` 的四语言 parity 检查，并实现
`scripts/check-i18n-usage.mjs` source-usage 门禁：

1. 使用 TypeScript compiler API 绑定 `useTranslation` 返回的 `t`、共享 `i18n.t`、
   显式 `TFunction`/`Translate` helper 与 `Trans i18nKey`，不把普通回调 `t` 误认成翻译。
2. 展开字面量、条件分支、有限 string union/template、常量 map 与 metadata key，覆盖
   `resolveSubmitIssueKey` 这类“先返回 key、后调用 t”的间接路径。
3. 无法由类型系统有限证明的表达式必须在 `scripts/i18n-usage-manifest.mjs` 以
   `file#expression` 登记精确 key；未知动态表达式、通配符与过期 selector 均失败。
   Manifest 列表是需评审的有限运行时合同，不宣称能从列表自身证明每个值均可达。
4. 按 i18next 实际 namespace 语义 canonicalize 多冒号 key，并验证每个解析 key 在四种
   locale 中均存在；即使调用提供 `defaultValue` 也不能豁免。
5. 不全局扫描所有 `audio:*` 字面量，因为它会把 `audioIpc.ts` 的 IPC channel 误报为
   翻译；只有绑定后的翻译调用进入检查，外部动态 key 还必须在运行时用相同有限白名单校验。
6. Electron smoke 在 preload loading 退出后检查正文及 `aria-label`、`title`、
   `placeholder`、`alt`，禁止音频与音频设置页面出现 raw `audio:`/`setting:` key。

当前基线为 1342 个翻译调用，其中 1310 个静态/类型有限展开，32 次调用由 26 个精确
manifest selector 覆盖，共验证 1378 个实际引用 key。

发布门禁：

```text
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
```

`pnpm run i18n:check` 已串联上述两层门禁；排查时可分别使用
`i18n:check:locales` 与 `i18n:check:usage`。

## 10. 数据迁移与兼容

### 10.1 新持久化边界

| 数据 | 旧位置 | 新位置 |
| --- | --- | --- |
| 文本 profiles / assignment | `fusionkit-model` | 保持不变 |
| audio profiles / assignment | `fusionkit-model` | `fusionkit-audio-settings` |
| speech tool preferences | `fusionkit-speech-synthesizer` v4（兼容读取 v3） | 同 key 升至 v5 |

音频重构不能改变文本模型迁移结果。

`CORE-R01` 已完成独立 Store 与迁移基础设施，`BE-R01` 已把 runtime snapshot、
main route resolver、ASR/TTS/Realtime IPC 消费者切到独立配置，`FE-R01` 已让设置页
停止挂载和写入 legacy audio UI，`FE-R02` 已迁移 TTS，`FE-R03` 已完成 ASR、实时字幕、
双向语音和最后的 legacy facade cleanup。旧 CRUD/selectors、shared shell fallback、
`AudioModelConfig` 与迁移完成后的文本删除保护均已移除；legacy 字段只作为一个版本的
只读备份继续持久化，不建立新旧 Store 双写，也不会因文本 profile 删除而被级联过滤。
若当前启动的跨 key bootstrap 尚未完成，本会话必须拒绝删除被 legacy audio 引用的
文本 profile 并提示重启。下一次启动会在两个 Store hydration 前重试迁移；只有 target
已完成且 live Audio Store 已从该 target hydration 后，才解除保护，避免源凭证丢失或被
同会话 stale state 覆盖。

### 10.2 Legacy audio profile 迁移

迁移按旧 `AudioModelProfile` 一条对一条物化新的 `AudioApiProfile`，优先保证无损和 assignment 稳定，不先做激进去重：

1. 读取旧 audio profile。
2. 解引用 `connectionProfileId`。
3. 复制 provider、API Key、Base URL 到新的独立音频 API。
4. 把旧 dialect/model 映射为 routes。
5. 用稳定的 old-id → new-id map 重写 audio assignment。
6. 写入新 store 并标记 migration 完成。
7. 至少一个版本内保留旧字段只读备份，不再双写。

### 10.3 MiMo TTS 迁移

对 `mimo_chat_audio`：

- 无论旧 profile 的 `defaults.mimoTtsMode` 是什么，默认生成三条内置 TTS route。
- 旧 `models.speechSynthesis` 若等于三个已知模型之一，用它确认对应 route；其余两条仍用内置映射补齐。
- 旧模型是自定义值时，将其挂到旧 mode 对应 route，并把 profile 标为 `needsAttention`；其余内置 route 可用但需在高级设置中明确展示。
- 不迁移 `defaults.mimoTtsMode`。

这样旧用户配置 `mimo-v2.5-tts` 后，迁移完成即可直接使用三种模式。

### 10.4 Realtime 迁移

- 旧 `models.realtimeTranscription` 和 `models.realtimeVoice` 分别迁移。
- 旧 deprecated `models.realtime` 继续作为两者 fallback，避免历史配置丢失。
- OpenAI file audio 和 realtime profile 若使用相同连接，可先分别迁移为两个独立 API；迁移成功后提供“合并”建议，不在自动迁移中冒险合并。

### 10.5 缺失引用与失败处理

当前迁移会过滤掉找不到 connection 的 audio profile。新迁移禁止静默删除：

- 保留 profile 名称、模型与 assignment 关系。
- 创建 `needsAttention` 配置，明确提示“旧连接缺失，请补充 Base URL/API Key”。
- API Key 不可恢复时只标记缺失，不生成假值。
- 迁移异常记录脱敏诊断，不写入 Key 或完整 endpoint query。
- 新 store 成功落盘前，不解除文本 profile 的旧引用删除保护。

### 10.6 Speech store 迁移

`fusionkit-speech-synthesizer` 升至 v5：

- `preferences.mimoMode` → `preferences.speechMode`。
- 删除/忽略 `profileSeedKey`。
- 删除/忽略 `profileDefaultOverrides`。
- 保留 input、voice、instructions、输出目录、文件名和各模式草稿。
- 对已不支持的 mode 在运行时回退，不覆盖仍可恢复的草稿。

### 10.7 Endpoint canonicalization

迁移和保存时统一 canonicalize Base URL，至少正确剥离：

- `/chat/completions`
- `/responses`
- `/audio/transcriptions`
- `/audio/speech`
- Realtime 完整 endpoint

避免把通用 profile 中的完整 `/responses` URL 错误派生为 `/responses/audio/speech`。

## 11. 模块职责与预计文件

### 11.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/store/useAudioApiStore.ts` | 独立音频 API、assignment、迁移状态 |
| `src/lib/audio-provider-registry.ts` | provider routes、constraints、默认模型的单一事实来源 |
| `src/lib/audio-api-migration.ts` | 从 `fusionkit-model` v5 物化独立配置 |
| `src/pages/Setting/components/AudioApiConfig.tsx` | 独立音频设置页 |
| `scripts/check-i18n-usage.mjs` | 源码 key 存在性检查 |

### 11.2 主要调整

| 文件 | 调整 |
| --- | --- |
| `src/pages/Setting/index.tsx` | 新增 audio tab 与 deep link |
| `src/pages/Setting/components/ModelConfig.tsx` | 移除 `AudioModelConfig` |
| `src/type/audio.ts` | 新 profile/routes/intent/runtime 类型 |
| `src/store/useModelStore.ts` | 停止作为音频配置事实来源；只保留迁移读取和只读备份 |
| `src/store/tools/audio/audioToolConfig.ts` | 从独立 audio store 解析摘要与 available modes |
| `src/store/tools/audio/speechSynthesizerConfig.ts` | provider-neutral intent、字段白名单、删除 mode/model mismatch |
| `src/store/tools/audio/useSpeechSynthesizerStore.ts` | 偏好迁移、删除 profile default seed |
| `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx` | 条件渲染、模式路由、CTA、i18n |
| `src/pages/Tools/Audio/shared/AudioToolShell.tsx` | 新摘要与精确设置入口 |
| `src/services/audio/audioRuntimeConfigService.ts` | 同步 standalone audio profiles，不再同步 connectionProfiles |
| `src/type/audioIpc.ts` | 新 snapshot 与 speech intent validator |
| `electron/main/audio/audio-runtime-config.ts` | `resolveRoute` |
| `electron/main/audio/ipc.ts` | 先按 mode 解析可信 route，再处理文件/adapter |
| `electron/main/audio/adapters/mimo-chat-audio-adapter.ts` | 使用共享 registry，保留 defense-in-depth 校验 |
| `src/locales/*/audio.json` | 缺失 key、新交互文案、删除旧 mismatch 文案 |
| `src/locales/*/setting.json` | 独立音频 API 信息架构文案 |

原 `AudioModelConfig.tsx` 已在 `FE-R03` 迁移完成后删除；独立设置由 `AudioApiConfig.tsx` 承担。

## 12. 测试与验收策略

### 12.1 可复用测试

- OpenAI/MiMo adapter 精确 payload 与错误处理。
- MiMo 三模式非流式、流式、final-only 和 abort。
- Fake audio API server。
- 文件 MIME/大小、PCM/WAV、输出与取消。
- Realtime ephemeral、WebRTC 事件与资源 cleanup。
- IPC 文件 token、sender ownership、revision 和 task payload 禁止敏感配置。

### 12.2 必须重写

- `audio-profile.test.ts`：从 connection 引用过滤改为独立 profile 迁移。
- `useModelStore.test.ts`：删除“音频引用阻止删除文本 profile”的新合同；补文本配置不受影响。
- `audioCapability.test.ts`：runtime 直接从 `AudioApiProfile` resolve route。
- `audioIpc.test.ts`、`audioIpcService.test.ts`：snapshot 不再携带 connectionProfiles。
- `speechSynthesizerConfig.test.ts`：删除 mode/model 不兼容断言，改为 mode 自动选 route。
- `audioToolConfig.test.ts`：summary 不再依赖文本 connection profile。

### 12.3 必须新增

| 层级 | 场景 |
| --- | --- |
| Store migration | 有效引用、缺失引用、多个 audio profile 共用 connection、assignment 保留、二次迁移幂等 |
| Registry | provider preset、route constraints、MiMo 三模式映射只有一个真相源 |
| Runtime | 同一 MiMo API 下三模式分别解析正确 model |
| Runtime | renderer 无法通过 payload 覆盖 model/transport |
| Request builder | 三种 intent 只包含当前模式字段 |
| Component | OpenAI 与 MiMo 三模式字段存在/不存在矩阵 |
| Component | 当前可见必填字段决定 CTA，不再出现 mismatch |
| Component | profile/assignment 切换后的 mode 回退与草稿保留 |
| i18n | 10 个已知缺失 key 与所有静态/枚举 key 可解析 |
| Electron | 从零配置、返回工具、三模式切换、CTA 可用、生成/取消、四语言两窗口 |

### 12.4 关键端到端矩阵

1. 无文本模型配置 → 新建 MiMo 音频 API → 自动 assignment → 返回工具。
2. MiMo preset 非流式/流式。
3. MiMo voice design 非流式/流式。
4. MiMo voice clone 非流式/流式。
5. OpenAI TTS 只出现适用字段并完成一次生成。
6. API assignment 切换时，模式可用集合和字段同步变化。
7. 删除正在使用的 API 时正确提示替代/未配置影响。
8. 四语言均无 raw key。
9. 786×540 与 1280×800 无横向溢出，条件渲染后的焦点和 aria 正确。

### 12.5 验证命令

实施阶段至少运行：

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts
node_modules/.bin/vitest run src/store/tools/audio src/lib/audio-profile.test.ts
git diff --check
```

Electron 视觉/交互验收必须等待 FusionKit preload loading 完全退出；如启动 Vite/Electron，结束前关闭服务并确认没有残留进程。真实供应商验收不得把 Key、输入音频或 Base64 写入日志和文档。

## 13. 实施顺序建议

实施已按下列顺序推进；各工作包完成状态与下一步以 Execution Plan 为准：

1. `PRE-R01`：冻结新类型、provider registry、route constraints 和迁移 fixture。
2. `CORE-R01`：独立 audio store、legacy migration、文本 store 解耦。
3. `BE-R01`：runtime snapshot 与 `resolveRoute`，保留 IPC 安全边界。
4. `FE-R01`：独立“设置 → 音频”页面、首次配置与 deep link。
5. `FE-R02`：SpeechSynthesizer 条件渲染、provider-neutral intent、CTA。
6. `FE-R03`：其余三个音频工具迁移到独立配置并清理 legacy facade；已完成。
7. `I18N-R01`：补齐 10 个 key、清理旧文案、增加 usage check。
8. `TEST-R01`：迁移/registry/runtime/component 自动化。
9. `QA-R01`：Electron 四语言两尺寸交互矩阵。
10. `QA-R02`：真实 OpenAI/MiMo、麦克风/扬声器验收。
11. `DOC-R01`：同步旧设计 superseded 标记、执行台账和发布说明。

最小闭环优先级是：

```text
独立配置可创建
  → assignment 可解析
  → MiMo 三模式自动路由
  → TTS 页面按模式渲染
  → 迁移与 i18n
  → 全量音频工具与真实 QA
```

## 14. 风险与决策

| 风险 | 决策 |
| --- | --- |
| 自定义兼容 API 的能力无法自动判断 | 只在高级区显式配置 routes；普通用户使用 provider preset |
| Provider 模型未来变化 | preset 可随版本迁移；允许高级 override；真实验证状态按 route 记录 |
| 同一 OpenAI Key 同时用于 file/realtime | profile 允许多 transport route，不再把 dialect 作为 profile 单选 |
| 旧配置引用已丢失 | 保留 needsAttention，不静默删除 |
| 工具草稿与 API 切换冲突 | 草稿保留；仅回退当前不可用 mode；payload 严格白名单 |
| registry 与 adapter 再次漂移 | 单一共享 registry + contract tests |
| i18n 动态 key 难静态扫描 | 枚举 manifest + `i18n.exists` + Electron raw-key 检测 |
| 视觉 smoke 再次漏掉主流程 | Electron 必须实际完成配置、切模式和 CTA 断言 |

## 15. 不得违反的实现约束

- 不得重新引入 `AudioApiProfile.connectionProfileId`。
- 不得在 API 配置中保存 TTS mode 或任务默认参数。
- 不得让工具页提交 model/transport/baseUrl/apiKey。
- 不得把一条 MiMo API 再拆成三个需要用户手动 assignment 的 TTS profile。
- 不得保留“所有模式字段常驻，仅 disabled/opacity”的结构。
- 不得用 dialect 的笼统默认 capability 代替 route 真实可用性。
- 不得静默丢弃旧 profile、assignment 或模式字段。
- 不得把 locale parity 通过等同于源码翻译 key 完整。
- 不得用只挂载页面的 Electron smoke 替代可执行产品链路。

## 16. 与原音频工具箱设计的关系

继续有效：

- OpenAI Audio、MiMo Chat Audio、OpenAI Realtime 的协议与 adapter 分层。
- 工具任务 payload 不携带敏感连接配置。
- main 侧 runtime、文件授权、输出 token、stream、取消和 Realtime 生命周期。
- 隐私、日志脱敏与真实供应商 QA 要求。

由本文正式替代：

- 原 `audio-toolkit_final_design.md` §6.1/6.2 的 `connectionProfileId` 配置与固定 model resolution。
- 原 `8` “不适用控件保留可见但 disabled”的规则。
- 原 `9.1` 的音频 Profile 表单与任务 defaults。
- 原 `9.4` 中“单一全局 TTS model + 工具页三模式”的交互。
- 原 `12` 的 mode/model mismatch 用户错误。
- 原 `13` 只验证页面挂载、未覆盖真实配置和模式链路的验收口径。

旧 Final Design、CORE-001、FE-001、FE-004、FIX-006/007 和实施记录保留为历史证据，不倒改历史完成状态；后续实现以本文和新的 execution plan 为准。
