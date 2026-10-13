import { describe, expect, it } from "vitest";
import { approvalNeed } from "./approval";
import { EXTERNAL_TOOLS } from "./catalog";

const read = EXTERNAL_TOOLS.read_studio_document;
const write = EXTERNAL_TOOLS.write_studio_translations;
const always = EXTERNAL_TOOLS.prepare_knowledge_changes;

describe("approval", () => {
  it("never asks for reads, whatever the level", () => {
    for (const trust of ["read_only", "confirm_writes", "auto"] as const) expect(approvalNeed(trust, read)).toEqual({ kind: "none" });
  });

  it("refuses every change when read-only", () => {
    expect(approvalNeed("read_only", write)).toEqual({ kind: "refuse", error: "read_only" });
    expect(approvalNeed("read_only", always)).toEqual({ kind: "refuse", error: "read_only" });
    expect(approvalNeed("read_only", EXTERNAL_TOOLS.export_studio_document, { destructive: true })).toEqual({ kind: "refuse", error: "read_only" });
  });

  it("asks for writes in confirm_writes, offering the connection allowance, unless already allowed", () => {
    expect(approvalNeed("confirm_writes", write)).toEqual({ kind: "ask", sessionGrant: true });
    expect(approvalNeed("confirm_writes", write, { granted: true })).toEqual({ kind: "none" });
  });

  it("runs writes in auto but always asks for destructive and always-confirmed calls, without an allowance", () => {
    expect(approvalNeed("auto", write)).toEqual({ kind: "none" });
    expect(approvalNeed("auto", EXTERNAL_TOOLS.export_studio_document, { destructive: true })).toEqual({ kind: "ask", sessionGrant: false });
    expect(approvalNeed("auto", always)).toEqual({ kind: "ask", sessionGrant: false });
    expect(approvalNeed("confirm_writes", always, { granted: true })).toEqual({ kind: "ask", sessionGrant: false });
    expect(approvalNeed("confirm_writes", EXTERNAL_TOOLS.export_studio_document, { destructive: true, granted: true })).toEqual({ kind: "ask", sessionGrant: false });
  });

  it("labels each tool for MCP clients and groups the translation tools together", () => {
    expect(EXTERNAL_TOOLS.create_studio_translation_track.group).toBe(EXTERNAL_TOOLS.write_studio_translations.group);
    for (const [name, definition] of Object.entries(EXTERNAL_TOOLS)) {
      const def = definition as { access: string; group?: string; confirm?: string };
      if (def.access === "read") expect(def.group, name).toBeUndefined();
      else expect(!!def.group !== (def.confirm === "always"), name).toBe(true);
    }
  });
});
