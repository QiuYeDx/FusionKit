import { describe, expect, it, vi } from "vitest";
import type {
  LocalSubtitleBackendPreviewSummary,
  LocalSubtitleManagedResourceSummary,
  LocalSubtitleRendererApi,
  LocalSubtitleRuntimeSummary,
} from "@/type/localSubtitleIpc";
import { LocalSubtitleEnvironmentService } from "./localSubtitleEnvironmentService";

const runtime = {
  runtimeGeneration: "a".repeat(64),
} as LocalSubtitleRuntimeSummary;
const resources = [
  { resourceId: "model-a", status: "ready" },
] as unknown as readonly LocalSubtitleManagedResourceSummary[];
const preview = {
  modelId: "model-a",
  devicePreference: "auto",
  resolvedBackend: "cpu",
  serverArtifactId: "server-a",
  serverVersion: "1.0.0",
} as LocalSubtitleBackendPreviewSummary;

describe("LocalSubtitleEnvironmentService", () => {
  it("runs the automatic environment check once and only refreshes on demand", async () => {
    const probeRuntime = vi.fn().mockResolvedValue({ ok: true, data: runtime });
    const listManagedResources = vi
      .fn()
      .mockResolvedValue({ ok: true, data: resources });
    const service = new LocalSubtitleEnvironmentService({
      getApi: () => ({
        probeRuntime,
        listManagedResources,
      }) as unknown as LocalSubtitleRendererApi,
    });

    await Promise.all([
      service.ensureInitialized(),
      service.ensureInitialized(),
    ]);
    await service.ensureInitialized();

    expect(probeRuntime).toHaveBeenCalledOnce();
    expect(listManagedResources).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({
      loading: false,
      runtime,
      resources,
      error: null,
    });

    await service.refresh();
    expect(probeRuntime).toHaveBeenCalledTimes(2);
    expect(listManagedResources).toHaveBeenCalledTimes(2);
  });

  it("reuses successful backend previews across route consumers", async () => {
    const previewBackend = vi
      .fn()
      .mockResolvedValue({ ok: true, data: preview });
    const service = new LocalSubtitleEnvironmentService({
      getApi: () => ({ previewBackend }) as unknown as LocalSubtitleRendererApi,
    });
    const request = { modelId: "model-a", devicePreference: "auto" } as const;
    const key = `${runtime.runtimeGeneration}:model-a:auto`;

    const [first, coalesced] = await Promise.all([
      service.requestBackendPreview(key, request),
      service.requestBackendPreview(key, request),
    ]);
    const cached = await service.requestBackendPreview(key, request);

    expect(first).toEqual({ ok: true, data: preview });
    expect(coalesced).toEqual(first);
    expect(cached).toEqual(first);
    expect(previewBackend).toHaveBeenCalledOnce();
    expect(service.getCachedBackendPreview(key)).toBe(preview);

    service.clearBackendPreviews();
    await service.requestBackendPreview(key, request);
    expect(previewBackend).toHaveBeenCalledTimes(2);
  });
});
