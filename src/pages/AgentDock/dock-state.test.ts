import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@/agent/types";
import { dockClipPath, hasUnreadReply, isDockRoute } from "./dock-state";

const message = (role: AgentMessage["role"], content = "text"): AgentMessage => ({ id: `${role}-${content}`, role, content, timestamp: 1 });

describe("agent dock state", () => {
  it("offers the panel on every page except the home page", () => {
    expect(isDockRoute("/")).toBe(false);
    expect(isDockRoute("/tools/subtitle/studio")).toBe(true);
    expect(isDockRoute("/setting")).toBe(true);
  });

  it("counts only replies with text after the last seen message as unread", () => {
    const messages = [message("user"), message("assistant", "seen"), message("tool"), message("assistant", " ")];
    expect(hasUnreadReply(messages, 2)).toBe(false);
    expect(hasUnreadReply([...messages, message("assistant", "new")], 2)).toBe(true);
    expect(hasUnreadReply(messages, 1)).toBe(true);
  });

  it("clips the closed panel to a launcher-sized circle at its bottom-left corner", () => {
    expect(dockClipPath(false, { width: 400, height: 620 })).toBe("inset(584px 364px 0px 0px round 18px)");
    expect(dockClipPath(true, { width: 400, height: 620 })).toBe("inset(0px 0px 0px 0px round 16px)");
  });
});
