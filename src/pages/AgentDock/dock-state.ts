import type { AgentMessage } from "@/agent/types";

/** The home page is the full assistant; every other page offers the floating panel. */
export function isDockRoute(pathname: string): boolean {
  return pathname !== "/";
}

/** Whether a reply arrived after the panel was last seen. */
export function hasUnreadReply(messages: readonly AgentMessage[], seenCount: number): boolean {
  return messages.slice(seenCount).some((message) => message.role === "assistant" && !!message.content.trim());
}

/** Closed: a 36px circle at the panel's bottom-left corner. Open: the whole panel. */
export function dockClipPath(open: boolean, size: { width: number; height: number }, launcher = 36): string {
  if (open) return "inset(0px 0px 0px 0px round 16px)";
  return `inset(${Math.max(0, size.height - launcher)}px ${Math.max(0, size.width - launcher)}px 0px 0px round ${launcher / 2}px)`;
}
