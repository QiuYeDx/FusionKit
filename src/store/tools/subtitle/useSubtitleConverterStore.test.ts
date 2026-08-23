import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleFileType } from "@/type/subtitle";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
  return values;
});

vi.mock("@/utils/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/utils/notification", () => ({
  showSystemNotification: vi.fn(),
}));

beforeEach(() => {
  storage.clear();
  vi.resetModules();
});

describe("subtitle converter configuration persistence", () => {
  it("persists every reusable field and excludes task payloads", async () => {
    const { default: store } = await import("./useSubtitleConverterStore");

    store.getState().setToFormat(SubtitleFileType.VTT);
    store.getState().setDefaultDurationSec("6.5");
    store.getState().setStripMediaExt(false);
    store.getState().setOutputMode("source");
    store.getState().setConflictPolicy("overwrite");
    store.setState({
      notStartedTasks: [
        {
          fileName: "private.srt",
          fileContent: "private subtitle content",
        } as never,
      ],
    });

    const persisted = storage.get("fusionkit-subtitle-converter") ?? "";
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      state: {
        toFormat: "VTT",
        defaultDurationSec: "6.5",
        stripMediaExt: false,
        outputMode: "source",
        conflictPolicy: "overwrite",
      },
    });
    expect(persisted).not.toMatch(/private\.srt|private subtitle content/u);
  });

  it("restores sanitized preferences while discarding dirty runtime queues", async () => {
    localStorage.setItem(
      "fusionkit-subtitle-converter",
      JSON.stringify({
        version: 1,
        state: {
          toFormat: "LRC",
          defaultDurationSec: "4",
          stripMediaExt: false,
          outputURL: "D:\\Exports",
          outputMode: "custom",
          conflictPolicy: "overwrite",
          pendingTasks: [{ fileName: "must-not-hydrate.srt" }],
        },
      }),
    );

    const { default: store } = await import("./useSubtitleConverterStore");
    expect(store.getState()).toMatchObject({
      toFormat: SubtitleFileType.LRC,
      defaultDurationSec: "4",
      stripMediaExt: false,
      outputURL: "D:\\Exports",
      outputMode: "custom",
      conflictPolicy: "overwrite",
      notStartedTasks: [],
      pendingTasks: [],
      resolvedTasks: [],
      failedTasks: [],
    });
  });
});
