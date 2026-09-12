import { describe, expect, it, vi } from 'vitest';
import { StudioRefreshCoordinator, StudioRefreshDisposedError } from '../../src/services/subtitle-studio/refresh-coordinator';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe('document reader refresh coordination', () => {
  it('coalesces a burst and follows an event received during the active read without overlapping readers', async () => {
    const first = gate(); let active = 0; let maximum = 0;
    const refresh = vi.fn(async () => { maximum = Math.max(maximum, ++active); if (refresh.mock.calls.length === 1) await first.promise; active--; });
    const errors = vi.fn(); const reader = new StudioRefreshCoordinator(refresh, errors);
    for (let i = 0; i < 20; i++) reader.requestRefresh();
    await tick(); expect(refresh).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) reader.requestRefresh();
    await tick(); expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve(); await tick();
    expect(refresh).toHaveBeenCalledTimes(2); expect(maximum).toBe(1); expect(errors).not.toHaveBeenCalled(); reader.dispose();
  });

  it('retains a click during a slow refresh and prioritizes it over a pending follow-up read', async () => {
    const first = gate(); const action = gate(); const order: string[] = [];
    const reader = new StudioRefreshCoordinator(async () => { order.push('read'); if (order.length === 1) await first.promise; }, vi.fn());
    reader.requestRefresh(); await tick(); reader.requestRefresh();
    const result = reader.runForeground(async () => { order.push('click'); await action.promise; return 'selected-document'; });
    await tick(); expect(order).toEqual(['read']);
    first.resolve(); await tick(); expect(order).toEqual(['read', 'click']);
    action.resolve(); expect(await result).toBe('selected-document'); await tick(); expect(order).toEqual(['read', 'click', 'read']); reader.dispose();
  });

  it('keeps explicit actions ordered and does not let an event interleave their effects', async () => {
    const pending = gate(); const order: string[] = [];
    const reader = new StudioRefreshCoordinator(async () => { order.push('read'); }, vi.fn());
    const first = reader.runForeground(async () => { order.push('import'); await pending.promise; order.push('published'); });
    reader.requestRefresh(); const second = reader.runForeground(async () => { order.push('open'); });
    await tick(); expect(order).toEqual(['import']); pending.resolve(); await Promise.all([first, second]); await tick();
    expect(order).toEqual(['import', 'published', 'open', 'read']); reader.dispose();
  });

  it('reports a failed background read once and permits a later explicit retry', async () => {
    const error = new Error('unavailable'); const report = vi.fn(); const refresh = vi.fn(async () => { throw error; });
    const reader = new StudioRefreshCoordinator(refresh, report);
    reader.requestRefresh(); await tick(); expect(report).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith(error);
    expect(await reader.runForeground(async () => 'recovered')).toBe('recovered');
    expect(refresh).toHaveBeenCalledTimes(1); reader.dispose();
  });

  it('propagates foreground failures to the caller and still processes pending invalidations', async () => {
    const report = vi.fn(); const refresh = vi.fn(async () => {}); const reader = new StudioRefreshCoordinator(refresh, report);
    const failure = new Error('conflict'); const action = reader.runForeground(async () => { reader.requestRefresh(); throw failure; });
    await expect(action).rejects.toBe(failure); await tick(); expect(refresh).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled(); reader.dispose();
  });

  it('fences unstarted work during StrictMode cleanup and a disposed reader cannot be restarted', async () => {
    const refresh = vi.fn(async () => {}); const action = vi.fn(async () => {}); const reader = new StudioRefreshCoordinator(refresh, vi.fn());
    reader.requestRefresh(); const foreground = reader.runForeground(action); reader.dispose();
    await expect(foreground).rejects.toBeInstanceOf(StudioRefreshDisposedError); await tick();
    expect(refresh).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
    reader.requestRefresh(); await expect(reader.runForeground(action)).rejects.toBeInstanceOf(StudioRefreshDisposedError); await tick(); expect(refresh).not.toHaveBeenCalled();
  });

  it('does not report late failures or start queued reads after disposal', async () => {
    const pending = gate(); const report = vi.fn(); const refresh = vi.fn(async () => { await pending.promise; throw new Error('late'); });
    const reader = new StudioRefreshCoordinator(refresh, report); reader.requestRefresh(); await tick(); reader.requestRefresh();
    const action = vi.fn(async () => {}); const queued = reader.runForeground(action); reader.dispose();
    await expect(queued).rejects.toBeInstanceOf(StudioRefreshDisposedError); pending.resolve(); await tick();
    expect(refresh).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  });
});
