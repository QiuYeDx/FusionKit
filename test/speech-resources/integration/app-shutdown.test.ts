import { describe, expect, it } from 'vitest';
import { createSharedResourceApplicationShutdown } from '../../../electron/main/app-shutdown';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('application resource shutdown ordering', () => {
  it('fences synchronously and waits for both consumer joins before shared services', async () => {
    const legacy = deferred(), studio = deferred(), calls: string[] = [];
    let reentered: Promise<void> | undefined;
    const application = createSharedResourceApplicationShutdown({ resources: {
      fence() { calls.push('fence'); reentered = application.shutdown('app_quit'); },
      async shutdown() { calls.push('resources'); },
    }, runtimes: [{ shutdown() { calls.push('legacy'); return legacy.promise; } },
      { shutdown() { calls.push('studio'); return studio.promise; } }], smokeServer: { async shutdown() { calls.push('smoke'); } } });
    const closing = application.shutdown('app_quit'); expect(reentered).toBe(closing); expect(calls).toEqual(['fence']);
    await Promise.resolve(); await Promise.resolve(); expect(calls).toEqual(['fence', 'legacy', 'studio']);
    legacy.resolve(); await Promise.resolve(); expect(calls).not.toContain('resources');
    studio.resolve(); await closing; expect(calls.slice(-2).sort()).toEqual(['resources', 'smoke']);
  });
  it('retains shared resources when a consumer cannot join and retries only failed consumers', async () => {
    const calls: string[] = []; let fails = true;
    const application = createSharedResourceApplicationShutdown({ resources: {
      fence() { calls.push('fence'); }, async shutdown() { calls.push('resources'); },
    }, runtimes: [{ async shutdown() { calls.push('legacy'); } }, { async shutdown() { calls.push('studio'); if (fails) throw new Error('still active'); } }],
      smokeServer: { async shutdown() { calls.push('smoke'); } } });
    await expect(application.shutdown('update')).rejects.toThrow(); expect(calls).not.toContain('resources'); expect(calls).not.toContain('smoke');
    fails = false; await application.shutdown('update'); expect(calls.filter(value => value === 'legacy')).toHaveLength(1);
    expect(calls.filter(value => value === 'studio')).toHaveLength(2); expect(calls.filter(value => value === 'resources')).toHaveLength(1);
  });
  it('retains resource root ownership until the dedicated smoke process actually joins', async () => {
    const calls: string[] = []; let fails = true;
    const application = createSharedResourceApplicationShutdown({
      resources: { fence() { calls.push('fence'); }, async shutdown() { calls.push('resources'); } },
      runtimes: [{ async shutdown() { calls.push('consumer'); } }],
      smokeServer: { async shutdown() { calls.push('smoke'); if (fails) throw new Error('native process still alive'); } },
    });
    await expect(application.shutdown('app_quit')).rejects.toThrow(); expect(calls).not.toContain('resources');
    fails = false; await application.shutdown('app_quit');
    expect(calls.filter(value => value === 'consumer')).toHaveLength(1);
    expect(calls.slice(-2)).toEqual(['smoke', 'resources']);
  });
});
