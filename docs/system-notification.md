# 系统通知（System Notification）

跨平台（macOS / Windows）的任务完成/失败系统通知，用户可在「设置 → 常规设置」中启用，默认关闭。

---

## 架构概览

```
Renderer (React)                        Main (Electron)
┌──────────────────────┐               ┌──────────────────────┐
│  showSystemNotification()            │                      │
│    ↓ 检查开关状态                     │                      │
│    ↓ ipcRenderer.send(               │  ipcMain.on(         │
│        "show-notification",   ────►  │    "show-notification"│
│        { title, body })              │  )                   │
│                                      │    ↓                  │
│                                      │  new Notification()   │
│                                      │    .show()            │
└──────────────────────┘               └──────────────────────┘
```

**为什么用 Main 进程的 `Notification` 而非 Web Notification API？**

- Electron 主进程的 `Notification` 类对双平台支持更可靠
- Windows 依赖 `appUserModelId`（已在 `electron/main/index.ts` 中设置）
- 避免 Renderer 权限管理的不确定性

---

## 相关文件

| 文件 | 职责 |
| --- | --- |
| `src/store/useNotificationStore.ts` | Zustand store，管理开关状态，持久化到 `localStorage` |
| `src/utils/notification.ts` | `showSystemNotification()` 工具函数 |
| `src/components/ui/switch.tsx` | Switch 开关 UI 组件 |
| `electron/main/index.ts` | `show-notification` IPC 监听 + `Notification` 调用 |
| `src/pages/Setting/components/GeneralConfig.tsx` | 设置页 UI（开关 + 测试按钮） |
| `src/locales/{zh,en,ja}/setting.json` | 通知相关 i18n 翻译 |

---

## 核心实现

### 1) Store：全局开关

`src/store/useNotificationStore.ts`

```ts
import { create } from "zustand";

interface NotificationStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const useNotificationStore = create<NotificationStore>((set) => ({
  enabled: localStorage.getItem("notification-enabled") === "true",
  setEnabled: (enabled) => {
    localStorage.setItem("notification-enabled", String(enabled));
    set({ enabled });
  },
}));
```

- 默认关闭（`false`）
- 持久化 key：`notification-enabled`

### 2) 工具函数

`src/utils/notification.ts`

```ts
import useNotificationStore from "@/store/useNotificationStore";

export const showSystemNotification = (
  title: string,
  body: string,
  force = false
) => {
  const { enabled } = useNotificationStore.getState();
  if (!enabled && !force) return;
  window.ipcRenderer.send("show-notification", { title, body });
};
```

- `force = true` 时忽略开关状态（用于"测试通知"按钮）
- 使用 `send`（fire-and-forget），通知无需返回值

### 3) Main 进程 IPC 监听

`electron/main/index.ts`

```ts
import { Notification } from "electron";

ipcMain.on("show-notification", (_event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});
```

- `Notification.isSupported()` 做平台兼容检查
- Windows 需要 `app.setAppUserModelId()`（已有）

---

## 如何在新功能中接入通知

### 在组件中（有 `useTranslation`）

```ts
import { showSystemNotification } from "@/utils/notification";

// 任务成功
showSystemNotification(
  "FusionKit",
  t("setting:fields.notification.task_resolved", { file: fileName })
);

// 任务失败
showSystemNotification(
  "FusionKit",
  t("setting:fields.notification.task_failed", { file: fileName })
);
```

### 在非组件代码中（如 IPC 事件监听器）

```ts
import { showSystemNotification } from "@/utils/notification";
import i18n from "@/i18n";

showSystemNotification(
  "FusionKit",
  i18n.t("setting:fields.notification.task_resolved", { file: data.fileName })
);
```

---

## i18n 翻译 Key

所有通知相关翻译位于 `setting:fields.notification` 命名空间下：

| Key | 中文 | English | 日本語 |
| --- | --- | --- | --- |
| `label` | 系统通知 | Notification | システム通知 |
| `test_btn` | 测试通知 | Test | テスト |
| `test_title` | FusionKit | FusionKit | FusionKit |
| `test_body` | 系统通知功能正常！ | System notification is working! | システム通知は正常に動作しています！ |
| `task_resolved` | {{file}} 任务已完成 | {{file}} completed | {{file}} が完了しました |
| `task_failed` | {{file}} 任务失败 | {{file}} failed | {{file}} が失敗しました |

---

## 已接入通知的模块

| 模块 | 触发点 | 文件 |
| --- | --- | --- |
| 字幕翻译器 | `task-resolved` / `task-failed` IPC 事件 | `src/renderer/subtitle.ts` |
| 字幕格式转换 | `startTask` 成功/失败 | `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx` |
| 字幕语言提取 | `startTask` 成功/失败 | `src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx` |

---

## 新增模块接入 Checklist

1. 在任务成功/失败的位置调用 `showSystemNotification()`
2. 如需新的通知文案，在 `src/locales/{zh,en,ja}/setting.json` 的 `fields.notification` 下添加对应 key
3. 通知标题统一使用 `"FusionKit"`
