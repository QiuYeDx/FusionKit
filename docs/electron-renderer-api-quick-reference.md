# Electron / Renderer 开发速查（优先使用的 API & 封装）

适用范围：FusionKit（Electron 24+；当前依赖 `electron@^33`），默认安全配置（`contextIsolation: true`，不启用 `nodeIntegration`）。

## 分层原则（先记住这个）

- **Renderer（React）**：只做 UI、状态管理、文件内容读取（`File.text()`），不直接使用 Node/Electron 特权能力。
- **Preload**：用 `contextBridge.exposeInMainWorld()` 暴露“白名单 API”，作为 Renderer 的唯一特权入口。
- **Main**：所有涉及系统能力（文件系统、对话框、shell、进程、电源、网络等）优先放在 Main，通过 IPC 提供服务。

## 常见需求：应该优先用哪个 API？

| 需求 | 首选 API/封装 | 在哪里用 | 说明/注意事项 |
| --- | --- | --- | --- |
| 读取用户选择的字幕文件内容 | `await file.text()` | Renderer | 最简单可靠；适合字幕等文本文件。 |
| 获取 `File` 的真实绝对路径（用于“输出到源目录”等） | `getFilePathFromFile(file)`（内部优先走 `window.electronUtils.getPathForFile(file)`） | Renderer：`src/utils/filePath.ts` | **不要**直接用 `file.path`；在 `contextIsolation: true` 下经常为 `undefined`。 |
| 从 `File` 推导源目录 | `getSourceDirFromFile(file)` | Renderer：`src/utils/filePath.ts` | 内部做了跨平台分隔符处理（`/`、`\`）。 |
| 选择输出目录（打开系统目录选择器） | `window.ipcRenderer.invoke("select-output-directory", options)` | Renderer → Main | Main 使用 `dialog.showOpenDialog()` 实现；这是请求/响应型 IPC 的推荐方式。 |
| 执行字幕转换（写入输出文件） | `window.ipcRenderer.invoke("convert-subtitle", payload)` | Renderer → Main | 计算/写盘属于特权操作，建议放 Main；Renderer 只传入内容与配置。 |
| 处理“带进度/推送”的事件 | `window.ipcRenderer.on(channel, listener)` | Renderer | 适合进度推送、日志推送；请求/响应优先用 `invoke/handle`。 |
| Toast 提示 | `showToast(message, "success" \| "error")` | Renderer：`src/utils/toast.ts` | 统一风格与交互。 |
| 系统通知（任务完成/失败等） | `showSystemNotification(title, body, force?)` | Renderer：`src/utils/notification.ts` | 受全局开关控制；`force=true` 忽略开关（测试用）。详见 `docs/system-notification.md`。 |
| 生成可预览/缓存的临时 URL | `URL.createObjectURL(file)` | Renderer | 适合本地预览；用完建议 `URL.revokeObjectURL(url)` 避免内存泄漏。 |

## 文件路径：优先级与最佳实践

### 为什么不要用 `File.path`

在 Electron 24+ 且 `contextIsolation: true` 的默认安全模型下，Renderer 拿到的 `File` 往往**不再包含**可用的 `path` 字段（或不可访问）。这会导致“无法读取源文件路径”。

### 正确做法（本项目约定）

- **Renderer 侧统一走封装**：`src/utils/filePath.ts`
  - `getFilePathFromFile(file)`：优先走 `window.electronUtils.getPathForFile(file)`
  - `getSourceDirFromFile(file)`：从路径推导目录
- **Preload 侧暴露白名单 API**：`electron/preload/index.ts`
  - `window.electronUtils.getPathForFile(file)` → `webUtils.getPathForFile(file)`
- **类型声明同步**：`src/vite-env.d.ts`

Renderer 侧示例：

```ts
import { getSourceDirFromFile } from "@/utils/filePath";

const dir = getSourceDirFromFile(file);
if (!dir) {
  // 兜底：提示用户切换“自定义输出目录”，或走自定义输出路径
}
```

## IPC：什么时候用 invoke/handle，什么时候用 send/on？

- **优先用 `invoke/handle`**：有明确请求/响应的调用（选择目录、执行转换、一次性查询等）。
- **用 `send/on`**：需要持续推送（进度、日志、状态变更广播等）。

建议：

- **Main**：`ipcMain.handle("xxx", async () => ...)` 提供能力
- **Renderer**：`window.ipcRenderer.invoke("xxx", payload)` 调用
- **Preload**：只暴露 `ipcRenderer.invoke/on/off/send` 这类“受控入口”，不要把整套 Electron/Node API 暴露到 Renderer

## 新增特权能力时的 Checklist（避免踩坑）

1. **先判断是否必须要特权能力**：能在 Renderer 做就不要上 IPC（例如纯 UI、纯文本处理）。
2. **必须要特权能力**（文件系统/对话框/shell/系统信息）：
   - 在 Main 实现能力（或新增 IPC handler）
   - 在 Preload 用 `contextBridge` 暴露最小必要 API
   - 在 `src/vite-env.d.ts` 补齐 Window 类型
3. **不要为了省事去开 `nodeIntegration` / 关 `contextIsolation`**：这会把安全债务滚大。
4. **跨平台路径**：
   - Main 优先用 Node `path` 模块
   - Renderer 侧尽量不做复杂路径拼接；已存在的字符串处理优先复用 `src/utils/filePath.ts`

## 相关文件速查

- Preload 白名单：`electron/preload/index.ts`
- Renderer 类型声明：`src/vite-env.d.ts`
- 文件路径工具：`src/utils/filePath.ts`
- 目录选择 IPC：`electron/main/index.ts`（`select-output-directory`）
- 字幕转换 IPC：`electron/main/conversion/ipc.ts`（由 `setupConversionIPC()` 注册）
- 系统通知工具：`src/utils/notification.ts`
- 系统通知 IPC：`electron/main/index.ts`（`show-notification`）
- 通知开关 Store：`src/store/useNotificationStore.ts`
