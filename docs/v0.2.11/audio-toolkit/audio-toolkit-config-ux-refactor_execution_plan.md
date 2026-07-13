# 音频 API 配置与语音合成 UX 重构 Execution Plan

> 日期：2026-07-13
> Feature Slug：`audio-toolkit-config-ux-refactor`
> 对应设计文档：`docs/v0.2.11/audio-toolkit/audio-toolkit-config-ux-refactor_final_design.md`
> 当前状态：`PRE-R01`、`CORE-R01`、`BE-R01`、`FE-R01` 已完成；下一步 `FE-R02`

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
| CORE-R01 | 已完成 | 2026-07-13 | 独立 audio store、legacy migration 与文本 store 解耦基础设施 | `src/store/useAudioApiStore.ts`、`src/lib/audio-api-migration.ts`、`src/store/useModelStore.ts`、migration/store/bootstrap tests | CORE 5 files / 46 tests；音频 24 files / 168 tests；`tsc --noEmit`；四语言 1420 keys；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_CORE-R01_audio-api-store-migration.md` | 不得单独发布 CORE；现有 BE/FE 仍使用 legacy facade，`FE-R03` 在最后消费者切换后移除旧 CRUD/selectors 与文本删除 guard |
| BE-R01 | 已完成 | 2026-07-13 | standalone runtime snapshot、provider-neutral intent 与可信 `resolveRoute` | `src/type/audioIpc.ts`、`electron/main/audio/audio-runtime-config.ts`、`electron/main/audio/ipc.ts`、`electron/main/audio/realtime-ipc.ts`、`electron/main/audio/audio-output-directory.ts`、`electron/preload/index.ts`、`electron/preload/audio-channel-policy.ts`、audio services/adapters/tests | IPC 1 file / 42 tests；音频 29 files / 244 tests；全量 83 files / 691 tests；`tsc --noEmit`；四语言 1425 keys；Vite test build；Electron 2 tests（4 routes × 4 locales × 2 sizes）；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_BE-R01_standalone-audio-runtime-routing.md` | `FE-R01` 已停止设置页 legacy 写入；`FE-R02` 仍需移除 legacy speech input 并完成 voice-clone token UI，`FE-R03` 迁移其余工具消费者 |
| FE-R01 | 已完成 | 2026-07-13 | 独立“设置 -> 音频”页面与首次配置链路 | `src/pages/Setting/index.tsx`、`settingNavigation.ts`、`AudioApiConfig.tsx`、`audioApiConfigModel.ts`、`useAudioApiStore.ts`、`src/locales/*/setting.json`、`test/e2e.spec.ts` | 设置/Store 3 files / 27 tests；音频 31 files / 261 tests；全量 85 files / 709 tests；TypeScript；四语言 1505 keys；Vite test build；Electron E2E 3 tests；截图审查；`git diff --check` | `audio-toolkit-config-ux-refactor_implementation_records/2026-07-13_FE-R01_standalone-audio-settings.md` | M1 已达成；`FE-R02` 迁移 TTS store/UI，`FE-R03` 再清理 legacy audio CRUD/selectors |
| FE-R02 | 未开始 | — | TTS store v4、条件渲染、三模式 intent 与配置 CTA | SpeechSynthesizer page/store/config、AudioToolShell | component/config/IPC tests、Electron | — | 依赖 CORE-R01、BE-R01 |
| FE-R03 | 未开始 | — | ASR、实时字幕、双向语音迁移到独立配置 | 其余三工具、shared shell/config、`useModelStore` legacy facade cleanup | audio tool tests、Electron、文本/音频生命周期隔离 tests | — | 依赖 CORE-R01、BE-R01；最后消费者切换后移除旧 audio CRUD/selectors、connection 删除 guard，legacy 字段仅留只读备份 |
| I18N-R01 | 未开始 | — | 清理旧语义并增加源码翻译 key 门禁 | `scripts/check-i18n-usage.mjs`、`src/locales/*` | 两个 i18n scripts、raw-key smoke | — | 10 个已知缺失 key 先随 PRE-R01 补齐 |
| TEST-R01 | 未开始 | — | 迁移、registry、runtime、builder 与组件自动化矩阵 | audio tests/fake server | targeted + full vitest、tsc | — | 依赖实现包 |
| QA-R01 | 未开始 | — | Electron 四语言两尺寸交互矩阵 | e2e/验收记录 | 4 locales x 2 sizes；等待 loading 退出 | — | 依赖 FE/I18N/TEST |
| QA-R02 | 未开始 | — | 真实 OpenAI/MiMo 与真实设备验收 | 验收记录 | 真实 ASR/TTS/realtime/mic/speaker | — | 不得记录 Key、Base64 或敏感 payload |
| DOC-R01 | 未开始 | — | 发布文档、旧设计关系与迁移说明收口 | README/CHANGELOG/design/plan | 文档检查、diff check | — | 依赖 QA |

## 6. 最近完成工作包：FE-R01

目标：让用户不创建文本模型档案即可在独立“设置 -> 音频”页面完成 API CRUD、
四类任务默认分配和首次配置返回链路，同时停止设置页写 legacy audio。

实施范围：

- 设置页新增由 search params 直接驱动的 `audio` tab；同 pathname 下 query 变化无需
  重挂载即可切换内容，`returnTo` 仅接受四条精确音频工具路径。
- `ModelConfig` 停止挂载 legacy `AudioModelConfig`；旧组件与 facade 暂留到
  `FE-R03` 最后消费者迁移后清理，不建立新旧 Store 双写。
- 独立页面提供四任务 assignment、API 列表、provider/verification/使用状态，以及
  基于 `ScrollableDialog` 的新建、编辑和使用中删除。
- OpenAI/MiMo routes 直接来自 provider registry；自定义兼容 API 显式启用任务并
  填写 model。跨供应商切换清空旧 API Key，列表不展示 Key 片段。
- 第一条 API 只自动分配兼容且未分配任务，持久 Alert 明示结果；延迟撤销采用
  compare-and-clear，不覆盖用户随后手选的 assignment。
- 编辑 route 在同一次 Store 提交中清理不兼容 assignment；保存并返回时仍通过全局
  反馈列出清理任务。使用中删除逐任务选择兼容替代或取消分配，全量校验后原子提交。
- 四语言补齐独立音频设置文案；Electron 使用临时 userData 验证首次 MiMo 配置、
  撤销/重分配、跨供应商清 Key、route 收缩、返回反馈和宽窄对话框布局。

验收口径：

- 定向设置/Store 3 files / 27 tests；扩展音频矩阵 31 files / 261 tests；全量 Vitest
  85 files / 709 tests 全部通过。
- `node_modules/.bin/tsc --noEmit`、四语言 i18n 各 1505 keys、Vite test build、
  `git diff --check` 通过；构建只有既有 dynamic-import/chunk-size warning。
- Electron E2E 3 tests 通过，覆盖首次配置主链路及 4 路由 × 4 语言 × 2 窗口尺寸；
  1280×800 设置页与 786×540 `ScrollableDialog` 截图确认 loading 已退出、footer
  固定、内容可滚动且无横向溢出。
- 未使用 pnpm，`package.json`/`pnpm-lock.yaml` 未改；验证结束后无 FusionKit
  Vite/Electron 残留进程。

过渡边界：

- M1“独立配置可用”已达成；下一步 `FE-R02` 完成 TTS store v4、三模式条件渲染、
  provider-neutral intent 与 voice-clone token UI，闭环 M2。
- 其余音频工具仍由 `FE-R03` 迁移到独立配置；最后消费者切换前不得提前删除 legacy
  audio CRUD/selectors、文本 connection 删除保护或只读备份字段。

## 7. 实施记录模板

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
