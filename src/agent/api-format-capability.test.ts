import { describe, expect, it } from "vitest";
import { isAgentApiFormatSupported } from "./api-format-capability";

describe("agent api format capability", () => {
  it("allows the current Chat Completions agent path", () => {
    expect(isAgentApiFormatSupported("chat_completions")).toBe(true);
  });

  it("allows the Responses agent adapter path", () => {
    expect(isAgentApiFormatSupported("responses")).toBe(true);
  });

  it("keeps missing legacy metadata on the Chat path", () => {
    expect(isAgentApiFormatSupported(undefined)).toBe(true);
  });
});
