import { toast } from "sonner";

/**
 * 通用的 toast 提示工具函数
 * @param message 提示信息
 * @param type toast 类型（可选，默认为 'default'）
 */
export const showToast = (
  message: string,
  type: "default" | "success" | "error" | "loading" = "default"
) => {
  // 根据类型调用不同的 toast 方法
  switch (type) {
    case "success":
      toast.success(message);
      break;
    case "error":
      toast.error(message);
      break;
    case "loading":
      toast.loading(message);
      break;
    default:
      toast(message);
      break;
  }
};
