import useNotificationStore from "@/store/useNotificationStore";

/**
 * 发送系统通知（受全局开关控制）
 * @param force 为 true 时忽略开关状态（用于测试按钮）
 */
export const showSystemNotification = (
  title: string,
  body: string,
  force = false
) => {
  const { enabled } = useNotificationStore.getState();
  if (!enabled && !force) return;
  window.ipcRenderer.send("show-notification", { title, body });
};
