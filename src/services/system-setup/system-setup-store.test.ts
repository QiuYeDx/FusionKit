import { describe, expect, it, vi } from 'vitest';
import type { SystemSetupApi, VcRuntimeRepairResult, VcRuntimeStatus } from '../../system-setup/contract';
import { SystemSetupStore, vcRuntimeNeedsRepair } from './system-setup-store';

const missing: VcRuntimeStatus = { status: 'missing', requiredVersion: '14.52.36500', bundled: true };
const ok: VcRuntimeStatus = { status: 'ok', installedVersion: '14.52.36500', requiredVersion: '14.52.36500', bundled: true };

function api(overrides: Partial<SystemSetupApi> = {}): SystemSetupApi {
  return {
    getVcRuntimeStatus: vi.fn(async () => missing),
    repairVcRuntime: vi.fn(async () => ({ outcome: 'installed' as const, exitCode: 0, status: ok })),
    detectGpu: vi.fn(async () => ({ status: 'detected' as const, hasNvidia: true, driverOk: true })),
    ...overrides,
  };
}

describe('SystemSetupStore', () => {
  it('needs a repair only when the runtime is missing or too old', () => {
    expect(vcRuntimeNeedsRepair(missing)).toBe(true);
    expect(vcRuntimeNeedsRepair({ ...missing, status: 'outdated' })).toBe(true);
    for (const status of ['ok', 'not_applicable', 'unknown'] as const) expect(vcRuntimeNeedsRepair({ ...missing, status })).toBe(false);
    expect(vcRuntimeNeedsRepair(null)).toBe(false);
  });

  it('reuses a recent check unless forced, and shares one check in flight', async () => {
    let now = 0;
    const system = api();
    const store = new SystemSetupStore({ getApi: () => system, now: () => now, maxAgeMs: 1000 });
    const listener = vi.fn();
    store.subscribe(listener);
    const [first, second] = [store.checkVcRuntime(), store.checkVcRuntime()];
    expect(store.getSnapshot().vcChecking).toBe(true);
    expect(await first).toEqual(missing);
    expect(await second).toEqual(missing);
    expect(system.getVcRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ vc: missing, vcChecking: false });
    await store.checkVcRuntime();
    expect(system.getVcRuntimeStatus).toHaveBeenCalledTimes(1);
    now = 2000;
    await store.checkVcRuntime();
    expect(system.getVcRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(await store.vcRuntimeReady()).toBe(false);
    expect(system.getVcRuntimeStatus).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalled();
    // A recent answer can be used without asking again; an old one cannot.
    expect(store.freshVcRuntime(500)).toEqual(missing);
    now = 2600;
    expect(store.freshVcRuntime(500)).toBeNull();
    expect(store.freshVcRuntime(1000)).toEqual(missing);
  });

  it('repairs once at a time and takes the status the repair reports', async () => {
    let finish!: () => void;
    const system = api({ repairVcRuntime: vi.fn(() => new Promise<VcRuntimeRepairResult>(resolve => { finish = () => resolve({ outcome: 'installed', exitCode: 0, status: ok }); })) });
    const store = new SystemSetupStore({ getApi: () => system });
    await store.checkVcRuntime();
    const first = store.repairVcRuntime();
    expect(store.repairVcRuntime()).toBe(first);
    expect(store.getSnapshot().repairing).toBe(true);
    finish();
    expect(await first).toMatchObject({ outcome: 'installed' });
    expect(store.getSnapshot()).toMatchObject({ repairing: false, vc: ok, repair: { outcome: 'installed' } });
    expect(system.repairVcRuntime).toHaveBeenCalledTimes(1);
    expect(await store.vcRuntimeReady()).toBe(false); // the API in this test still answers "missing"
  });

  it('keeps a declined repair visible while the runtime is still missing, and reports an IPC failure as failed', async () => {
    const declined = api({ repairVcRuntime: vi.fn(async () => ({ outcome: 'cancelled' as const, exitCode: 1602, status: missing })) });
    const store = new SystemSetupStore({ getApi: () => declined });
    await store.repairVcRuntime();
    await store.checkVcRuntime({ force: true });
    expect(store.getSnapshot().repair?.outcome).toBe('cancelled');
    const broken = new SystemSetupStore({ getApi: () => api({ repairVcRuntime: vi.fn(async () => { throw new Error('ipc'); }) }) });
    expect(await broken.repairVcRuntime()).toMatchObject({ outcome: 'failed' });
  });

  it('detects the graphics card once unless refreshed, and does nothing without the API', async () => {
    const system = api();
    const store = new SystemSetupStore({ getApi: () => system });
    await store.detectGpu();
    await store.detectGpu();
    expect(system.detectGpu).toHaveBeenCalledTimes(1);
    await store.detectGpu({ refresh: true });
    expect(system.detectGpu).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().gpu).toMatchObject({ hasNvidia: true });
    const none = new SystemSetupStore({ getApi: () => undefined });
    expect(await none.checkVcRuntime()).toBeNull();
    expect(await none.vcRuntimeReady()).toBe(true);
    expect(await none.repairVcRuntime()).toBeNull();
    expect(await none.detectGpu()).toBeNull();
  });
});
