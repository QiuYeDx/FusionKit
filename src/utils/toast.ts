import { toast } from "sonner";

const DEDUP_WINDOW_MS = 1500;
const recentToasts = new Map<string, number>();

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = recentToasts.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recentToasts.set(key, now);
  if (recentToasts.size > 20) {
    for (const [k, ts] of recentToasts) {
      if (now - ts >= DEDUP_WINDOW_MS) recentToasts.delete(k);
    }
  }
  return false;
}

export const showToast = (
  message: string,
  type: "default" | "success" | "error" | "loading" = "default",
) => {
  if (isDuplicate(`${type}:${message}`)) return;

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
