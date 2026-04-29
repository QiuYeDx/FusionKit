# FusionKit — TODO & 优化清单

> 基于项目当前状态（v0.2.4）的全面梳理，涵盖待开发功能、代码质量优化、架构改进、测试与文档等维度。

---

## 一、待开发新功能 🚀

### 1.1 路线图中已规划但未实现的工具

> [!NOTE]
> 以下工具暂不作为近期重点，优先级最低，后续视需求再推进。

| 优先级 | 功能 | 当前状态 | 说明 |
|--------|------|----------|------|
| ⚪ 最低 | **批量文件重命名工具** | 仅占位 UI | [Tools/index.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Tools/index.tsx#L115-L141) 已有"重命名工具箱"卡片，显示 Coming Soon |
| ⚪ 最低 | **付费音乐解密转换工具** | 仅占位 UI | [Tools/index.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Tools/index.tsx#L87-L113) 已有"音乐工具箱"卡片，显示 Coming Soon |

### 1.2 现有功能增强

| 优先级 | 功能 | 说明 |
|--------|------|------|
| 🔴 高 | **字幕语言提取通用化** | 当前提取工具实现上绑定了中文/日文的启发式识别逻辑，应重构为**通用的双语字幕单语提取工具** — 不限定具体语言，由用户选择保留哪一种语言（如第一行/第二行），使描述与逻辑均与具体语言解耦 |
| 🟡 中 | **Agent 支持更多工具** | 当前 Agent 仅能驱动字幕三件套（翻译/转换/提取），后续新工具上线需同步扩展 Agent 的 tool schema |
| 🟡 中 | **Agent 会话历史持久化** | 当前会话重置后即丢失（仅支持手动导出/导入 JSON），可考虑自动保存历史会话列表 |
| 🟡 中 | **拖拽文件到 Agent 输入框** | 让用户可以直接拖拽文件/文件夹到对话框，自动识别路径和操作意图 |
| 🟢 低 | **Agent Markdown 渲染** | 助手回复目前以纯文本展示 ([HomeAgent/index.tsx#L815](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/HomeAgent/index.tsx#L815))，可接入 Markdown 渲染（代码块、列表等） |
| 🟢 低 | **Agent 自定义 system prompt** | system prompt 目前仅为英文硬编码 ([orchestrator.ts#L26-L59](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/orchestrator.ts#L26-L59))，可考虑让用户自定义 system prompt 或模板 |
| 🟢 低 | **Linux 平台支持** | README 提及跨平台，Home.tsx 有 Linux 图标 ([Home.tsx#L153-L156](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Home.tsx#L153-L156))，但构建配置 ([electron-builder.json](file:///Users/qiuyedx/Documents/Github/FusionKit/electron-builder.json)) 仅有 mac/win |
| ⚪ 最低 | **VTT 字幕翻译支持** | 当前翻译仅支持 LRC/SRT，但格式转换已支持 VTT；翻译引擎 ([translation/class](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/translation/class)) 需新增 VTTTranslator |

---

## 二、代码质量 & 重构 🔧

### 2.1 待办 TODO / 注释清理

| 文件 | 内容 | 建议 |
|------|------|------|
| [Setting/index.tsx#L7](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Setting/index.tsx#L7) | `TODO: 所有的设置均作为一个配置对象, 存储在用户本地, 应用初始化时优先加载` | 当前各 store 独立持久化到 localStorage，可统一为一个全局配置管理器 |
| [electron/main/index.ts#L68](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L68) | `TODO: 临时关闭 Windows 上的右上角操作按钮` | ~~旧注释~~，Windows 已自行实现了关闭/最小化/全屏操作按钮（仿 macOS 红黄绿圆形按钮风格），**仅需清理该注释即可** |

### 2.2 大文件拆分

| 文件 | 行数 | 建议 |
|------|------|------|
| [HomeAgent/index.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/HomeAgent/index.tsx) | **1210 行** | 这是项目中最大的单文件，包含主页面 + 8 个子组件。建议拆分为独立组件文件：`MessageBubble`, `ToolCallBubble`, `StreamingTextContent`, `TokenStatsBar`, `CapsuleModeSelector`, `PendingExecutionCard`, `SuggestionPill` 等 |
| [ModelConfig.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Setting/components/ModelConfig.tsx) | **27KB** | 模型配置页面较大，可拆分 ProfileEditor / ProfileList 等子组件 |
| [useSubtitleTranslatorStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/tools/subtitle/useSubtitleTranslatorStore.ts) | **18KB** | 翻译 Store 逻辑密集，可考虑抽离任务执行逻辑到独立 service 层 |

### 2.3 代码清理

| 位置 | 问题 | 建议 |
|------|------|------|
| [src/demos/](file:///Users/qiuyedx/Documents/Github/FusionKit/src/demos) | 遗留的 demo 文件（`ipc.ts`, `node.ts`）含 `console.log` | 确认是否仍需保留，否则清理 |
| [electron/main/index.ts#L106-L114](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L106-L114) | 注释掉的 `createToolsWindows` 代码 | 如不再需要多窗口方案则移除 |
| [electron/main/index.ts#L149-L164](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L149-L164) | `open-win` handler 中 `nodeIntegration: true, contextIsolation: false` | 子窗口安全配置较弱，应改用 preload + contextBridge |
| [electron/main/index.ts#L51](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L51) | `// let subtitleWindow` 注释代码 | 清理 |
| [electron/main/translation/contants.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/translation/contants.ts) | 文件名拼写错误 `contants` → `constants` | 重命名 |
| [preload/index.ts#L82](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/preload/index.ts#L82) | Loading 背景色硬编码为 `#282c34` | 应适配主题色 |

### 2.4 类型安全

| 位置 | 问题 |
|------|------|
| [tool-executor.ts#L188](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/tool-executor.ts#L188) | `sliceType: args.sliceType as any` — 多处使用 `as any` 强转 |
| [orchestrator.ts#L280](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/orchestrator.ts#L280) | `const rawPart = part as Record<string, any>` — usage 类型断言不安全 |
| [tool-executor.ts#L339-L345](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/tool-executor.ts#L339-L345) | `readFileContent` 使用 `lines: 999999` 来读整个文件 — 不如使用 `read-file` IPC |

---

## 三、架构 & 性能优化 ⚡

### 3.1 架构优化

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🔴 高 | **统一配置持久化层** | 各 Store（Model / Proxy / Theme / ExecutionMode）各自操作 `localStorage`，缺乏统一管理。可引入统一的 persist middleware（如 zustand/middleware 的 `persist`），或使用 electron-store |
| 🟡 中 | **IPC 通信类型安全** | 主进程与渲染进程间 IPC 通道名为纯字符串（如 `"scan-directory"`, `"read-file-head"`），缺少类型约束。建议定义 IPC channel 契约类型 |
| 🟡 中 | **Agent orchestrator 与 UI 解耦** | [orchestrator.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/orchestrator.ts) 直接通过 `useAgentStore.getState()` 操作 store，耦合较重。可改为事件驱动或回调模式 |
| 🟢 低 | **翻译引擎移至渲染进程外** | 当前翻译调用链：渲染进程 store → IPC → 主进程 TranslationService。如果大量文件并发翻译，主进程可能成为瓶颈。可考虑 Web Worker 或 utility process |

### 3.2 性能优化

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | **Agent 对话虚拟滚动** | [HomeAgent/index.tsx#L543-L584](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/HomeAgent/index.tsx#L543-L584) 消息列表直接渲染所有消息，长对话可能卡顿。可引入 `react-window` 或 `@tanstack/virtual` |
| 🟢 低 | **AnimatePresence 页面切换性能** | 每次路由切换都经过 `AnimatePresence + motion.div` 动画 ([App.tsx#L94-L131](file:///Users/qiuyedx/Documents/Github/FusionKit/src/App.tsx#L94-L131))，二级页面（如翻译工具页）可能闪烁或卡顿 |
| 🟢 低 | **Zustand 选择器优化** | 部分组件使用 `useAgentStore()` 解构全量 state（如 [HomeAgent/index.tsx#L110-L122](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/HomeAgent/index.tsx#L110-L122)），可能触发不必要的重渲染。建议使用 `useAgentStore(selector)` 精细化选择 |
| 🟢 低 | **preload 加载动画** | [preload/index.ts#L119-L126](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/preload/index.ts#L119-L126) 有 `setTimeout(removeLoading, 4999)` 硬编码 5 秒超时，可改为 React 首帧 ready 后立即移除 |

---

## 四、测试 🧪

> [!NOTE]
> 测试部分整体暂不作为近期重点，优先级最低，后续再安排。

| 优先级 | 项目 | 说明 |
|--------|------|------|
| ⚪ 最低 | **补充 E2E 测试** | [test/e2e.spec.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/test/e2e.spec.ts) 仅有 1 个 startup 测试，其余均被注释掉。需要补充关键用户流测试（添加翻译任务、格式转换、设置等） |
| ⚪ 最低 | **补充单元测试** | 项目配置了 Vitest 但未发现任何单元测试文件。核心模块如 `converter.ts`（18KB）、`extractor.ts`、`base-translator.ts`、`tokenEstimate.ts` 等纯逻辑模块应有测试覆盖 |
| ⚪ 最低 | **Agent 工具链测试** | `tool-executor.ts` 中的各 `executeQueue*` 函数逻辑复杂，应有 mock 测试 |
| ⚪ 最低 | **CI 中运行 lint** | [ci.yml](file:///Users/qiuyedx/Documents/Github/FusionKit/.github/workflows/ci.yml) 已有 CI 配置，可考虑加入 ESLint 检查步骤 |

---

## 五、文档 & DX（开发体验）📝

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | **API / IPC 契约文档** | [docs/electron-renderer-api-quick-reference.md](file:///Users/qiuyedx/Documents/Github/FusionKit/docs/electron-renderer-api-quick-reference.md) 已有，但随功能增加可能过时，需定期同步 |
| 🟡 中 | **CONTRIBUTING.md** | README 中有贡献指南段落，但项目缺少独立的 `CONTRIBUTING.md` 文件，可详述代码规范、分支策略、PR 流程 |
| 🟡 中 | **Agent 架构文档** | [docs/home-agent/](file:///Users/qiuyedx/Documents/Github/FusionKit/docs/home-agent) 已有基础文档，但随 AI SDK 升级、工具链扩展，需持续更新 |
| 🟢 低 | **组件 Storybook / 展示** | `components/ui/` 有 24 个 shadcn 组件 + 自定义组件，可建立组件展示页方便开发 |
| 🟢 低 | **package.json description 缺失** | [package.json#L6](file:///Users/qiuyedx/Documents/Github/FusionKit/package.json#L6) `"description": ""` 为空 |

---

## 六、安全 & 发布 🔒

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | **API Key 安全存储** | 当前 API Key 存储在 `localStorage` 中（明文），可考虑迁移到 Electron `safeStorage` 加密存储 |
| 🟡 中 | **open-win 子窗口安全** | [index.ts#L154-L155](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L154-L155) 子窗口启用了 `nodeIntegration: true` 且关闭了 `contextIsolation`，存在安全隐患 |
| 🟢 低 | **CSP 策略** | 未发现 Content-Security-Policy 配置，生产环境应添加 |
| 🟢 低 | **macOS 签名 / 公证** | electron-builder 配置中未配置签名相关选项，影响发布后的用户体验（macOS 会弹安全警告） |

---

## 七、国际化 & 可访问性 🌐

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 🟡 中 | **Agent system prompt 国际化** | 当前 Agent 系统提示词为英文硬编码 ([orchestrator.ts#L26](file:///Users/qiuyedx/Documents/Github/FusionKit/src/agent/orchestrator.ts#L26))，可按用户语言动态切换 |
| 🟡 中 | **select-output-directory 国际化** | [index.ts#L206-L207](file:///Users/qiuyedx/Documents/Github/FusionKit/electron/main/index.ts#L206-L207) 对话框文本硬编码中文 "选择输出目录"、"选择此目录" |
| 🟢 低 | **可访问性（a11y）** | 应确保所有交互元素有 `aria-label`，键盘导航友好 |

---

## 快速行动清单 ⚡

> 优先级最高、投入产出比最好的 5 项：

1. **字幕语言提取通用化** — 消除工具对特定语言的硬编码依赖，使其成为真正通用的双语提取工具
2. **拆分 HomeAgent/index.tsx** — 1210 行大文件，显著影响可维护性
3. **统一配置持久化** — 解决多 Store 独立 localStorage 的一致性问题
4. **API Key 加密存储** — 安全基线提升
5. **清理旧注释与废弃代码** — 快速改善代码整洁度（Windows 标题栏 TODO、注释代码块、demo 文件等）

---

*生成时间：2026-04-27 · 基于 FusionKit v0.2.4 源码分析 · 已根据作者反馈修订优先级*
