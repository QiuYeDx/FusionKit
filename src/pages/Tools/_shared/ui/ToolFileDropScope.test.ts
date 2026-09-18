import { describe, expect, it, vi } from "vitest";
import { isToolFileDrag, selectToolFileDropTarget } from "./ToolFileDropScope";

describe("tool file drop routing", () => {
  const subtitles = ["subtitles", { label: "Subtitles", onDrop: vi.fn() }] as const;
  const media = ["media", { label: "Media", onDrop: vi.fn() }] as const;

  it("routes page whitespace and controls to the only import target", () => {
    expect(selectToolFileDropTarget([subtitles])).toBe(subtitles);
    expect(selectToolFileDropTarget([subtitles], "subtitles")).toBe(subtitles);
  });

  it("requires an explicit destination when multiple targets are visible", () => {
    expect(selectToolFileDropTarget([subtitles, media])).toBeUndefined();
    expect(selectToolFileDropTarget([subtitles, media], "media")).toBe(media);
    expect(selectToolFileDropTarget([subtitles, media], "subtitles")).toBe(subtitles);
  });

  it("does not redirect a disabled target to another importer", () => {
    const disabledMedia = ["media", { ...media[1], disabled: true }] as const;
    expect(selectToolFileDropTarget([disabledMedia])).toBeUndefined();
    expect(selectToolFileDropTarget([subtitles, disabledMedia])).toBeUndefined();
    expect(selectToolFileDropTarget([subtitles, disabledMedia], "media")).toBeUndefined();
    expect(selectToolFileDropTarget([subtitles, disabledMedia], "subtitles")).toBe(subtitles);
  });

  it("keeps explicitly local targets inside their own drop region", () => {
    const local = ["local", { ...media[1], pageWide: false }] as const;
    expect(selectToolFileDropTarget([local])).toBeUndefined();
    expect(selectToolFileDropTarget([local], "local")).toBe(local);
  });

  it("does not fall through an unregistered or inactive nested destination", () => {
    expect(selectToolFileDropTarget([subtitles], "inactive-media")).toBeUndefined();
    expect(selectToolFileDropTarget([])).toBeUndefined();
  });
});

describe("file drag detection", () => {
  it("recognizes OS drags while the file list is still protected", () => {
    expect(isToolFileDrag({ types: ["Files"], files: { length: 0 } } as unknown as DataTransfer)).toBe(true);
  });

  it("accepts a populated file list at drop time", () => {
    expect(isToolFileDrag({ types: [], files: { length: 1 } } as unknown as DataTransfer)).toBe(true);
  });

  it("leaves text, links and internal reorder drags alone", () => {
    for (const types of [["text/plain"], ["text/uri-list", "text/html"], []]) {
      expect(isToolFileDrag({ types, files: { length: 0 } } as unknown as DataTransfer)).toBe(false);
    }
  });
});
