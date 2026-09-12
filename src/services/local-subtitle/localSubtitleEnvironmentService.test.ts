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
  it('refreshes external installs off-route, coalesces invalidations and probes only terminal catalog changes', async () => {
    let changed!: (event: { revision: number }) => void;
    const unsubscribe = vi.fn();
    let current = [{ resourceId: 'model-a', status: 'ready' }] as LocalSubtitleManagedResourceSummary[];
    const probeRuntime = vi.fn(async () => ({ ok: true, data: runtime }));
    const listManagedResources = vi.fn(async () => ({ ok: true, data: current }));
    const service = new LocalSubtitleEnvironmentService({
      getApi: () => ({ probeRuntime, listManagedResources }) as unknown as LocalSubtitleRendererApi,
      sharedResources: { onChanged: listener => { changed = listener; return unsubscribe; }, getStatus: vi.fn(async () => ({ shared: true as const, revision: 1, busyResourceIds: [], migrationIssues: [], cleanupPending: false })) },
    });
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    await service.ensureInitialized();
    changed({ revision: 1 }); await settle();
    changed({ revision: 2 }); await settle();
    expect(probeRuntime).toHaveBeenCalledOnce();
    current = [{ resourceId: 'model-a', status: 'installing' }] as LocalSubtitleManagedResourceSummary[];
    changed({ revision: 3 }); await settle();
    expect(probeRuntime).toHaveBeenCalledOnce();
    const oldRevision = service.getState().backendPreviewRevision;
    current = [{ resourceId: 'model-a', status: 'not_installed' }] as LocalSubtitleManagedResourceSummary[];
    changed({ revision: 4 }); await settle();
    expect(probeRuntime).toHaveBeenCalledTimes(2);
    expect(service.getState().backendPreviewRevision).toBeGreaterThan(oldRevision);
    expect(service.getState().resources[0].status).toBe('not_installed');
    const reads = listManagedResources.mock.calls.length;
    changed({ revision: 3 }); await settle(); expect(listManagedResources).toHaveBeenCalledTimes(reads);
    service.resetForTests(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not lose an external deletion that arrives during an earlier resource read', async () => {
    let changed!: (event: { revision: number }) => void;
    let finish!: (value: unknown) => void;
    const probeRuntime = vi.fn(async () => ({ ok: true, data: runtime }));
    const listManagedResources = vi.fn().mockResolvedValue({ ok: true, data: resources });
    const service = new LocalSubtitleEnvironmentService({
      getApi: () => ({ probeRuntime, listManagedResources }) as unknown as LocalSubtitleRendererApi,
      sharedResources: { onChanged: listener => { changed = listener; return () => {}; }, getStatus: vi.fn(async () => ({ shared: true as const, revision: 2, busyResourceIds: [], migrationIssues: [], cleanupPending: false })) },
    });
    const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    await service.ensureInitialized();
    listManagedResources.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    changed({ revision: 1 }); await settle();
    changed({ revision: 2 });
    const deleted = [{ resourceId: 'model-a', status: 'not_installed' }];
    listManagedResources.mockResolvedValue({ ok: true, data: deleted });
    finish({ ok: true, data: resources }); await settle();
    expect(service.getState().resources[0].status).toBe('not_installed');
    expect(probeRuntime).toHaveBeenCalledTimes(2);
    service.resetForTests();
  });
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

  it('does not reuse a pending backend preview after resource invalidation', async () => {
    let finish!: (value: unknown) => void;
    const previewBackend = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, data: { ...preview, serverVersion: 'new' } });
    const service = new LocalSubtitleEnvironmentService({ getApi: () => ({ previewBackend }) as unknown as LocalSubtitleRendererApi });
    const request = { modelId: 'model-a', devicePreference: 'auto' } as const;
    const old = service.requestBackendPreview('key', request); await Promise.resolve();
    service.clearBackendPreviews();
    const latest = await service.requestBackendPreview('key', request);
    expect(previewBackend).toHaveBeenCalledTimes(2);
    finish({ ok: true, data: preview }); await old;
    expect(service.getCachedBackendPreview('key')).toEqual(latest.ok ? latest.data : undefined);
    service.resetForTests();
  });
});
