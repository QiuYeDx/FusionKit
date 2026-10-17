import { describe, expect, it } from "vitest";
import { approvalNeed, customPermission } from "./approval";
import { EXTERNAL_TOOLS } from "./catalog";
import { DEFAULT_EXTERNAL_PERMISSIONS, EXTERNAL_PERMISSION_CODES, externalAgentSettingsUpdateSchema, externalPermissionsSchema } from "./contract";

const read = EXTERNAL_TOOLS.read_studio_document;
const write = EXTERNAL_TOOLS.write_studio_translations;
const always = EXTERNAL_TOOLS.prepare_knowledge_changes;

describe("approval", () => {
  it("never asks for reads, whatever the level", () => {
    for (const trust of ["read_only", "confirm_writes", "auto", "full", "custom"] as const) expect(approvalNeed(trust, read)).toEqual({ kind: "none" });
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

  it("runs every change in full, renames, knowledge changes and overwrites included", () => {
    expect(approvalNeed("full", write)).toEqual({ kind: "none" });
    expect(approvalNeed("full", always)).toEqual({ kind: "none" });
    expect(approvalNeed("full", EXTERNAL_TOOLS.rename_paths)).toEqual({ kind: "none" });
    expect(approvalNeed("full", EXTERNAL_TOOLS.export_studio_document, { destructive: true })).toEqual({ kind: "none" });
  });

  it("follows each permission code in custom, tightened by overwrite_files for calls that replace files", () => {
    const permissions = { ...DEFAULT_EXTERNAL_PERMISSIONS, rename_paths: "allow" as const, write_studio_translations: "deny" as const, convert_subtitle_files: "ask" as const };
    const custom = (tool: keyof typeof EXTERNAL_TOOLS, options: { destructive?: boolean; granted?: boolean } = {}) =>
      approvalNeed("custom", EXTERNAL_TOOLS[tool], { ...options, tool, permissions });
    expect(custom("rename_paths")).toEqual({ kind: "none" });
    expect(custom("write_studio_translations")).toEqual({ kind: "refuse", error: "not_permitted" });
    expect(custom("convert_subtitle_files")).toEqual({ kind: "ask", sessionGrant: true });
    expect(custom("convert_subtitle_files", { granted: true })).toEqual({ kind: "none" });
    expect(custom("prepare_knowledge_changes")).toEqual({ kind: "ask", sessionGrant: false });
    // Allowed exports still ask when they overwrite, and never take the connection allowance.
    expect(custom("export_studio_document")).toEqual({ kind: "none" });
    expect(custom("export_studio_document", { destructive: true, granted: true })).toEqual({ kind: "ask", sessionGrant: false });
    expect(customPermission({ ...permissions, overwrite_files: "deny" }, "export_studio_document", true)).toBe("deny");
    expect(customPermission({ ...permissions, overwrite_files: "allow" }, "convert_subtitle_files", true)).toBe("ask");
  });

  it("has one permission code per tool that changes something, and keeps good codes when one is bad", () => {
    const writes = Object.entries(EXTERNAL_TOOLS).filter(([, definition]) => definition.access !== "read").map(([name]) => name).sort();
    expect(EXTERNAL_PERMISSION_CODES.filter(code => code !== "overwrite_files").sort()).toEqual(writes);
    expect(externalPermissionsSchema.parse({ rename_paths: "allow", split_studio_cue: "maybe", unknown: "deny" }))
      .toEqual({ ...DEFAULT_EXTERNAL_PERMISSIONS, rename_paths: "allow" });
    expect(externalAgentSettingsUpdateSchema.safeParse({ permissions: { rename_paths: "allow" } }).success).toBe(true);
    expect(externalAgentSettingsUpdateSchema.safeParse({ permissions: { nope: "allow" } }).success).toBe(false);
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
