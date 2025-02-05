import useThemeStore from "@/store/useThemeStore";
import toast from "react-hot-toast";

/**
 * 通用的 toast 提示工具函数
 * @param message 提示信息
 * @param type toast 类型（可选，默认为 'default'）
 */
export const showToast = (
  message: string,
  type: "default" | "success" | "error" | "loading" = "default"
) => {
  const isDark = useThemeStore.getState().isDark; // 直接读取 Store 的当前状态

  // 根据主题设置 toast 样式
  const toastStyle = {
    background: isDark ? "#333" : "#fff",
    color: isDark ? "#fff" : "#333",
    borderRadius: "8px",
    padding: "12px 16px",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
  };

  // 根据类型调用不同的 toast 方法
  switch (type) {
    case "success":
      toast.success(message, { style: toastStyle });
      break;
    case "error":
      toast.error(message, { style: toastStyle });
      break;
    case "loading":
      toast.loading(message, { style: toastStyle });
      break;
    default:
      toast(message, { style: toastStyle });
      break;
  }
};
