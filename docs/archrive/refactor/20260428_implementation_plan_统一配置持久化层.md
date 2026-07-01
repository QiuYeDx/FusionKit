# A-01 + Q-01：统一配置持久化层

## 背景

当前 FusionKit 的配置持久化存在以下问题：

1. **持久化方式碎片化** — 每个 store 各自手写 `localStorage.getItem/setItem` 逻辑，存在大量重复代码
2. **存储 key 分散** — 至少存在 10+ 个不同的 localStorage key，无法统一管理
3. **初始化流程不一致** — `useModelStore` 和 `useProxyStore` 需要手动调用 `initialize*()`，`useThemeStore` 也需要外部调用 `initializeTheme()`，`useAgentStore` 的 `executionMode` 在创建时直接读取，`useNotificationStore` 在创建时直接读取
4. **无迁移机制** — 除了 `useModelStore` 有 v1→v2 迁移外，其他 store 无版本管理

### 当前各 store 持久化方式盘点

| Store | localStorage Key(s) | 持久化方式 | 初始化方式 |
|-------|---------------------|------------|------------|
| `useModelStore` | `modelConfig` | 手写 `persist()` 函数 + `initializeModel()` | `App.tsx` useEffect |
| `useProxyStore` | `proxyConfig` | 手写 `_persist()` 闭包 + `initializeProxy()` | `App.tsx` useEffect |
| `useThemeStore` | `theme` | 直接 `localStorage.getItem/setItem` + `initializeTheme()` | `App.tsx` useEffect |
| `useAgentStore` | `agent-execution-mode` | 独立的 `loadExecutionMode()` / `persistExecutionMode()` | 创建时直接读 |
| `useNotificationStore` | `notification-enabled` | 创建时 `getStoredEnabled()` 读取 | 创建时直接读 |
| `useSubtitleTranslatorStore` | `subtitle-translator-output-url` | `getSavedOutputURL()` / `saveOutputURL()` | 创建时直接读 |
| `useSubtitleConverterStore` | `subtitle-converter-*` (4 keys) | `loadString()` / `loadBoolean()` / `persist()` | 创建时直接读 |
| `useSubtitleExtractorStore` | `subtitle-extractor-*` (3 keys) | `loadString()` / `persist()` | 创建时直接读 |

---

## 方案选型

使用 **zustand 内置的 `persist` middleware**，理由如下：
- 项目已使用 `zustand@^5.0.3`，内置 `persist` middleware 无需额外依赖
- `persist` 提供开箱即用的 `partialize`（选择性持久化）、`version` + `migrate`（数据迁移）
- 相比 `electron-store`，不需要额外的 IPC 通信，复杂度更低
- `localStorage` 对于 Electron 渲染进程的小量配置数据完全够用

每个 store 保持**独立的 localStorage key**（如 `fusionkit-model`、`fusionkit-proxy` 等），便于调试和排查问题。

---

## 注意事项

> [!WARNING]
> **useThemeStore 的特殊性**
>
> `useThemeStore` 除了读写 `localStorage` 外，还需要调用 `applyTheme()` 来设置 DOM 属性。方案：使用 `persist` 处理存储，同时利用 `onRehydrateStorage` 回调在 rehydrate 完成后触发 `applyTheme()`。

> [!WARNING]
> **useProxyStore 的 IPC 同步**
>
> `useProxyStore` 在变更时需要通过 IPC 将配置同步到主进程。改造后使用 zustand `subscribe` 监听变化，自动触发 IPC 同步，取代现在每个 setter 中的手动 `_syncToMain()` 调用。

> [!NOTE]
> **工具类 store 的任务队列不持久化**
>
> `useSubtitleTranslatorStore`、`useSubtitleConverterStore`、`useSubtitleExtractorStore` 中的任务队列（`notStartedTasks`、`pendingTasks` 等）是运行时数据，不应持久化。只持久化用户配置字段（如 `outputURL`、`outputMode`、`conflictPolicy`、`stripMediaExt`）。

---

## Proposed Changes

### 改造总览

改造顺序：逐一改造每个 store → 清理 App.tsx 初始化逻辑 → 清理 Q-01 注释。

**共涉及 9 个文件改造：**

| 文件 | 操作 | 要点 |
|------|------|------|
| `useModelStore.ts` | MODIFY | persist middleware + v1→v2 migrate |
| `useProxyStore.ts` | MODIFY | persist middleware + subscribe IPC sync |
| `useThemeStore.ts` | MODIFY | persist middleware + onRehydrateStorage |
| `useAgentStore.ts` | MODIFY | persist middleware (仅 executionMode) |
| `useNotificationStore.ts` | MODIFY | persist middleware |
| `useSubtitleTranslatorStore.ts` | MODIFY | persist middleware (仅 outputURL) |
| `useSubtitleConverterStore.ts` | MODIFY | persist middleware (配置字段) |
| `useSubtitleExtractorStore.ts` | MODIFY | persist middleware (配置字段) |
| `App.tsx` | MODIFY | 移除手动 initialize 逻辑 |
| `Setting/index.tsx` | MODIFY | Q-01：删除 TODO 注释 |
| `theme-provider.tsx` | MODIFY | 移除 initializeTheme 调用（如有） |

---

### 核心配置 Store

#### [MODIFY] [useModelStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/useModelStore.ts)

**改造要点：**
- 使用 `persist` middleware 包裹 store
- `partialize` 只持久化 `profiles` 和 `assignment`
- 利用 `version: 2` + `migrate` 函数替代现有的 `migrateFromV1` 手工迁移
- 移除手写的 `persist()` 函数、`STORAGE_KEY` 常量
- **移除 `initializeModel()` 方法**
- localStorage key：`fusionkit-model`（`onRehydrateStorage` 中做旧 key `modelConfig` 的一次性迁移）
- 每个 action（`addProfile`、`updateProfile`、`removeProfile`、`setAssignment`）中移除手动 `persist(next)` 调用，只保留纯 `set()` 逻辑

---

#### [MODIFY] [useProxyStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/useProxyStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 只持久化 `proxyConfig`
- **移除 `initializeProxy()` 方法**
- 移除手写的 `_persist()` 闭包和 `STORAGE_KEY`
- 使用 `subscribe` 监听变化触发 IPC 同步
- 使用 `onRehydrateStorage` 在 rehydrate 后首次同步到主进程
- localStorage key：`fusionkit-proxy`

---

#### [MODIFY] [useThemeStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/useThemeStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 只持久化 `theme`（`isDark` 是派生状态）
- `onRehydrateStorage` 回调中调用 `applyTheme()` + 更新 `isDark`
- **移除 `initializeTheme()` 方法**
- `setTheme` 中不再手动 `localStorage.setItem`
- 系统主题变化监听保持不变（`mediaQuery.addEventListener`）
- localStorage key：`fusionkit-theme`

---

#### [MODIFY] [useAgentStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/agent/useAgentStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` **仅持久化 `executionMode`**（会话、streaming、tokenStats 等均为运行时）
- 移除独立的 `loadExecutionMode()` 和 `persistExecutionMode()` 函数
- `setExecutionMode` 中移除手动 `persistExecutionMode()` 调用
- `restoreSession` 中移除手动 `persistExecutionMode()` 调用
- localStorage key：`fusionkit-agent`

---

#### [MODIFY] [useNotificationStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/useNotificationStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 持久化 `enabled`
- 移除 `getStoredEnabled()` 和 setter 中的手动 `localStorage.setItem`
- localStorage key：`fusionkit-notification`

---

### 工具类 Store

#### [MODIFY] [useSubtitleTranslatorStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/tools/subtitle/useSubtitleTranslatorStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 只持久化 `outputURL`（任务队列、sliceType 等为运行时数据）
- 移除 `getSavedOutputURL()` 和 `saveOutputURL()` 辅助函数
- `setOutputURL` 中移除手动 `saveOutputURL()` 调用
- localStorage key：`fusionkit-subtitle-translator`

---

#### [MODIFY] [useSubtitleConverterStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/tools/subtitle/useSubtitleConverterStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 持久化配置字段：`outputURL`、`outputMode`、`conflictPolicy`、`stripMediaExt`
- 移除文件顶部的 `loadString()`、`loadBoolean()`、`persist()` 辅助函数
- 各 setter 中移除手动 `persist()` 调用
- localStorage key：`fusionkit-subtitle-converter`

---

#### [MODIFY] [useSubtitleExtractorStore.ts](file:///Users/qiuyedx/Documents/Github/FusionKit/src/store/tools/subtitle/useSubtitleExtractorStore.ts)

**改造要点：**
- 使用 `persist` middleware
- `partialize` 持久化配置字段：`outputURL`、`outputMode`、`conflictPolicy`
- 移除文件顶部的 `loadString()`、`persist()` 辅助函数
- 各 setter 中移除手动 `persist()` 调用
- localStorage key：`fusionkit-subtitle-extractor`

---

### App 初始化与 Q-01 清理

#### [MODIFY] [App.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/App.tsx)

**改造要点：**
- **移除** `initializeTheme()`、`initializeModel()`、`initializeProxy()` 的手动调用和对应 `useEffect`
- 移除不再需要的 `useModelStore` 和 `useProxyStore` 的 import

```diff
- import useModelStore from "@/store/useModelStore";
- import useProxyStore from "@/store/useProxyStore";

  function App() {
-   // 初始化主题, 并添加系统深色模式监听
-   const initializeTheme = useThemeStore((state) => state.initializeTheme);
-   // 初始化模型配置
-   const { initializeModel } = useModelStore();
-   // 初始化代理配置
-   const { initializeProxy } = useProxyStore();
-
-   useEffect(() => {
-     initializeTheme();
-     initializeModel();
-     initializeProxy();
-   }, []);

    return ( /* ... */ );
  }
```

---

#### [MODIFY] [Setting/index.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/pages/Setting/index.tsx)

**Q-01：** 删除 L7 的 TODO 注释（已通过 A-01 实现）。

```diff
- // TODO: 所有的设置均作为一个配置对象, 存储在用户本地, 应用初始化时优先加载
  const Setting: React.FC = () => {
```

---

#### [MODIFY] [theme-provider.tsx](file:///Users/qiuyedx/Documents/Github/FusionKit/src/components/theme-provider.tsx)

检查并移除 `initializeTheme()` 调用（persist 自动 rehydrate 替代）。

---

### 数据迁移兼容

> [!NOTE]
> **旧 key → 新 key 迁移策略**
>
> 对于核心 store（Model / Proxy / Theme / Agent / Notification），在 `persist` 配置的 `merge` 或初始化时检查旧 localStorage key 是否存在。如果存在，读取旧数据写入新 key，然后删除旧 key。这保证现有用户配置不丢失。
>
> 对于工具类 store（subtitle-*），同样检查旧的多个分散 key，合并到单一新 key 后清理。

---

## Verification Plan

### 构建验证
- `pnpm dev` 确保无编译错误

### 浏览器验证
1. 启动应用，确认 localStorage 中出现新的 `fusionkit-*` key
2. 修改设置（主题切换、代理配置、模型配置），刷新后确认配置保持
3. 修改 Agent 执行模式，刷新后确认保持
4. 切换通知开关，刷新后确认保持
5. 字幕工具页面修改输出路径、输出模式、冲突策略，刷新后确认保持

### 迁移验证
1. 在 localStorage 中预写旧格式数据，刷新后确认能正确迁移到新 key 且旧 key 被清理
2. 确认主题切换无闪烁（`applyTheme()` 在 rehydrate 阶段正确触发）
3. 确认代理配置变更后 IPC 正确同步到主进程
