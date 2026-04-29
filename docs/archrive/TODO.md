# FusionKit — TODO 工作追踪

> 本文档用于记录和追踪 FusionKit 项目各项 TODO 的开发进度。  
> 状态说明：`⬜ 待开始` · `🔵 进行中` · `✅ 已完成` · `⏸️ 暂缓` · `❌ 取消`  
> 最后更新：2026-04-29 15:10

---

## 总览

| 分类 | 总计 | ✅ | 🔵 | ⬜ | ⏸️ |
|------|------|-----|-----|-----|-----|
| 一、新功能 | 10 | 1 | 0 | 5 | 4 |
| 二、代码质量 | 13 | 8 | 0 | 5 | 0 |
| 三、架构 & 性能 | 8 | 1 | 0 | 7 | 0 |
| 四、测试 | 4 | 0 | 0 | 0 | 4 |
| 五、文档 & DX | 5 | 0 | 0 | 5 | 0 |
| 六、安全 & 发布 | 4 | 0 | 0 | 4 | 0 |
| 七、国际化 | 3 | 0 | 0 | 3 | 0 |
| **合计** | **47** | **10** | **0** | **29** | **8** |

---

## 一、待开发新功能 🚀

### 🔴 高优先级

- ✅ **T-01** 字幕语言提取通用化
  - 重构为通用的双语字幕单语提取工具，消除对中文/日文的硬编码依赖
  - 涉及文件：`electron/main/extraction/`、`src/store/tools/subtitle/useSubtitleExtractorStore.ts`、`src/pages/Tools/Subtitle/SubtitleLanguageExtractor/`
  - 备注：已完成 (2026-04-28)，基于 Unicode Script 检测重构，支持 ZH/JA/EN/KO/FR/DE/ES/RU/PT 九种语言

### 🟡 中优先级

- ⬜ **T-02** Agent 支持更多工具
  - 后续新工具上线时同步扩展 Agent 的 tool schema
  - 涉及文件：`src/agent/tool-schemas.ts`、`src/agent/tool-executor.ts`、`src/agent/tools.ts`
  - 备注：

- ⬜ **T-03** Agent 会话历史持久化
  - 自动保存历史会话列表，当前仅支持手动导出/导入 JSON
  - 涉及文件：`src/store/agent/useAgentStore.ts`、`src/agent/session-io.ts`
  - 备注：

- ⬜ **T-04** 拖拽文件到 Agent 输入框
  - 支持拖拽文件/文件夹到对话框，自动识别路径和操作意图
  - 涉及文件：`src/pages/HomeAgent/index.tsx`
  - 备注：

### 🟢 低优先级

- ⬜ **T-05** Agent Markdown 渲染
  - 助手回复接入 Markdown 渲染（代码块、列表等）
  - 涉及文件：`src/pages/HomeAgent/index.tsx` (MessageBubble)
  - 备注：

- ⬜ **T-06** Agent 自定义 system prompt
  - 让用户自定义 system prompt 或选择模板
  - 涉及文件：`src/agent/orchestrator.ts`
  - 备注：

- ⬜ **T-07** Linux 平台支持
  - 补充 electron-builder 中的 Linux 构建配置
  - 涉及文件：`electron-builder.json`
  - 备注：

### ⚪ 最低优先级（暂缓）

- ⏸️ **T-08** 批量文件重命名工具
  - 备注：先放一放，后续视需求推进

- ⏸️ **T-09** 付费音乐解密转换工具
  - 备注：先放一放，后续视需求推进

- ⏸️ **T-10** VTT 字幕翻译支持
  - 备注：不紧急，后续视需求推进

---

## 二、代码质量 & 重构 🔧

### 2.1 TODO / 注释清理

- ✅ **Q-01** 清理 `Setting/index.tsx#L7` 的 TODO 注释
  - 统一配置持久化的改造见 A-01，此处仅清理或更新注释
  - 备注：已完成 (2026-04-28)，配合 A-01 一并处理

- ✅ **Q-02** 清理 `electron/main/index.ts#L68` 旧 TODO 注释
  - Windows 标题栏操作按钮已实现，仅需删除该行注释
  - 备注：已完成 (2026-04-27)

### 2.2 大文件拆分

- ⬜ **Q-03** 拆分 `HomeAgent/index.tsx`（1210 行）
  - 拆出子组件：MessageBubble、ToolCallBubble、StreamingTextContent、TokenStatsBar、CapsuleModeSelector、PendingExecutionCard、SuggestionPill
  - 备注：

- ⬜ **Q-04** 拆分 `ModelConfig.tsx`（27KB）
  - 拆出 ProfileEditor / ProfileList 等子组件
  - 备注：

- ✅ **Q-05** 拆分 `useSubtitleTranslatorStore.ts`（18KB）
  - 抽离任务执行逻辑到独立 service 层
  - 备注：已完成 (2026-04-29)，新增 renderer 侧 `translatorQueueService` 与 `translatorExecutionService`，`useSubtitleTranslatorStore` 保留 facade；补充队列状态机单测并修复失败/取消后 waiting 队列补位问题。相关 commit：`3bfdcf0`

### 2.3 代码清理

- ✅ **Q-06** 清理 `src/demos/` 遗留 demo 文件
  - 已移除 `src/demos/` 目录及 `main.tsx` 中对应的 import
  - 备注：已完成 (2026-04-27)

- ✅ **Q-07** 移除 `electron/main/index.ts` 中注释掉的 `createToolsWindows` 代码
  - 同时移除了 `subtitleWindow` 注释和 `createToolsWindows()` 调用注释
  - 备注：已完成 (2026-04-27)

- ⬜ **Q-08** 修复 `open-win` handler 安全配置（L149-L164）
  - 改用 preload + contextBridge 替代 `nodeIntegration: true`
  - 备注：

- ✅ **Q-09** 清理 `// let subtitleWindow` 注释代码（L51）
  - 备注：已完成 (2026-04-27)，与 Q-07 一并处理

- ✅ **Q-10** 重命名 `contants.ts` → `constants.ts`
  - 路径：`electron/main/translation/constants.ts`
  - 备注：已完成 (2026-04-27)，已更新 4 处 import 和 1 处注释引用

- ✅ **Q-11** preload Loading 重写视觉效果 & 适配主题
  - 重写为 FusionKit Logo 呼吸动画 + shimmer 进度条，自动检测 localStorage 主题与系统偏好
  - 备注：已完成 (2026-04-28)

### 2.4 类型安全

- ⬜ **Q-12** 消除 `tool-executor.ts` 和 `orchestrator.ts` 中的 `as any` 类型断言
  - 涉及：`sliceType as any`、`rawPart as Record<string, any>` 等
  - 备注：

- ⬜ **Q-13** 优化 `readFileContent` 读取方式
  - 当前使用 `lines: 999999` 读整个文件，改用专用的 `read-file` IPC
  - 备注：

---

## 三、架构 & 性能优化 ⚡

### 3.1 架构优化

- ✅ **A-01** 统一配置持久化层 `🔴 高`
  - 引入 zustand persist middleware，统一管理 Model / Proxy / Theme / ExecutionMode / Notification / Subtitle 工具配置
  - 涉及文件：`src/store/useModelStore.ts`、`useProxyStore.ts`、`useThemeStore.ts`、`useAgentStore.ts`、`useNotificationStore.ts`、`useSubtitleTranslatorStore.ts`、`useSubtitleConverterStore.ts`、`useSubtitleExtractorStore.ts`、`App.tsx`、`Setting/index.tsx`、`theme-provider.tsx`
  - 备注：已完成 (2026-04-28)，所有 store 已迁移至 persist middleware，旧 localStorage key 自动迁移

- ⬜ **A-02** IPC 通信类型安全 `🟡 中`
  - 定义 IPC channel 契约类型，替代纯字符串通道名
  - 涉及文件：`electron/preload/index.ts`、各 `ipc.ts`
  - 备注：

- ⬜ **A-03** Agent orchestrator 与 UI 解耦 `🟡 中`
  - 改为事件驱动或回调模式，减少对 `useAgentStore.getState()` 的直接依赖
  - 涉及文件：`src/agent/orchestrator.ts`
  - 备注：

- ⬜ **A-04** 翻译引擎优化 `🟢 低`
  - 大量文件并发翻译时考虑 Web Worker 或 utility process
  - 备注：

### 3.2 性能优化

- ⬜ **A-05** Agent 对话虚拟滚动 `🟡 中`
  - 引入 `react-window` 或 `@tanstack/virtual`
  - 涉及文件：`src/pages/HomeAgent/index.tsx` (消息列表区域)
  - 备注：

- ⬜ **A-06** AnimatePresence 页面切换性能 `🟢 低`
  - 二级页面切换闪烁/卡顿优化
  - 涉及文件：`src/App.tsx`
  - 备注：

- ⬜ **A-07** Zustand 选择器优化 `🟢 低`
  - 将 `useAgentStore()` 解构改为 `useAgentStore(selector)` 精细化选择
  - 涉及文件：`src/pages/HomeAgent/index.tsx` 等
  - 备注：

- ⬜ **A-08** preload 加载超时优化 `🟢 低`
  - `setTimeout(removeLoading, 4999)` 改为 React 首帧 ready 后移除
  - 涉及文件：`electron/preload/index.ts`
  - 备注：

---

## 四、测试 🧪

> 整体暂缓，后续再安排

- ⏸️ **E-01** 补充 E2E 测试
  - 当前仅 1 个 startup 测试
  - 备注：

- ⏸️ **E-02** 补充单元测试
  - 覆盖 converter / extractor / base-translator / tokenEstimate 等核心模块
  - 备注：

- ⏸️ **E-03** Agent 工具链 mock 测试
  - 备注：

- ⏸️ **E-04** CI 集成 ESLint
  - 备注：

---

## 五、文档 & DX 📝

- ⬜ **D-01** 同步 API / IPC 契约文档 `🟡 中`
  - 文件：`docs/electron-renderer-api-quick-reference.md`
  - 备注：

- ⬜ **D-02** 创建 CONTRIBUTING.md `🟡 中`
  - 详述代码规范、分支策略、PR 流程
  - 备注：

- ⬜ **D-03** 更新 Agent 架构文档 `🟡 中`
  - 目录：`docs/home-agent/`
  - 备注：

- ⬜ **D-04** 组件展示 / Storybook `🟢 低`
  - 备注：

- ⬜ **D-05** 补充 package.json description `🟢 低`
  - 备注：快速任务

---

## 六、安全 & 发布 🔒

- ⬜ **S-01** API Key 加密存储 `🟡 中`
  - 迁移到 Electron `safeStorage`
  - 涉及文件：`src/store/useModelStore.ts`、`electron/main/` 需新增加密 IPC
  - 备注：

- ⬜ **S-02** 修复 open-win 子窗口安全配置 `🟡 中`
  - 同 Q-08
  - 备注：

- ⬜ **S-03** 添加 CSP 策略 `🟢 低`
  - 备注：

- ⬜ **S-04** macOS 签名 / 公证 `🟢 低`
  - 配置 electron-builder 签名选项
  - 备注：

---

## 七、国际化 & 可访问性 🌐

- ⬜ **I-01** Agent system prompt 国际化 `🟡 中`
  - 按用户语言动态切换 system prompt
  - 涉及文件：`src/agent/orchestrator.ts`
  - 备注：

- ⬜ **I-02** select-output-directory 对话框国际化 `🟡 中`
  - 硬编码中文 "选择输出目录"、"选择此目录"
  - 涉及文件：`electron/main/index.ts#L206-L207`
  - 备注：

- ⬜ **I-03** 可访问性（a11y）`🟢 低`
  - 交互元素添加 `aria-label`，确保键盘导航
  - 备注：

---

## 快速行动清单 ⚡

> 当前最应优先推进的 5 项：

| # | 编号 | 任务 | 状态 |
|---|------|------|------|
| 1 | T-01 | 字幕语言提取通用化 | ✅ |
| 2 | Q-03 | 拆分 HomeAgent/index.tsx | ⬜ |
| 3 | A-01 | 统一配置持久化 | ✅ |
| 4 | S-01 | API Key 加密存储 | ⬜ |
| 5 | Q-02 + Q-06~Q-10 | 清理旧注释与废弃代码 | ✅ |

---

## 变更日志

| 日期 | 变更内容 |
|------|----------|
| 2026-04-27 | 初始创建，基于 v0.2.4 源码分析，含 47 项任务 |
| 2026-04-27 | 完成 Q-02、Q-06、Q-07、Q-09、Q-10（清理旧注释与废弃代码），5/47 ✅ |
| 2026-04-28 | 完成 Q-11（preload Loading 重写视觉效果 & 适配主题），6/47 ✅ |
| 2026-04-28 | 完成 A-01 + Q-01（统一配置持久化层 + 清理 Setting TODO），8/47 ✅ |
| 2026-04-28 | 完成 T-01（字幕语言提取通用化），9/47 ✅ |
| 2026-04-29 | 完成 Q-05（拆分 `useSubtitleTranslatorStore.ts`，抽离字幕翻译队列与 IPC 执行 service），10/47 ✅ |

<!-- 
使用说明：
- 完成一项任务后，将 ⬜ 改为 ✅，并在"备注"中记录完成日期和相关 commit
- 开始一项任务时，将 ⬜ 改为 🔵
- 暂缓的任务标记为 ⏸️
- 取消的任务标记为 ❌ 并注明原因
- 定期更新顶部"总览"表格中的计数
-->
