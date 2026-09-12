import { describe, expect, it, vi } from 'vitest';
import { createApplicationShutdown } from '../electron/main/app-shutdown';

describe('application runtime shutdown composition', () => {
  it('awaits every runtime and retries only failed cleanup targets', async () => {
    const failure = new Error('first target failed');
    let finish!: () => void;
    const first = { shutdown: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
    const second = { shutdown: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const application = createApplicationShutdown([first, second]);
    const work = application.shutdown('update');
    const settled = vi.fn(); void work.then(settled, settled);
    expect(application.shutdown('app_quit')).toBe(work);
    await vi.waitFor(() => expect(second.shutdown).toHaveBeenCalledWith('update'));
    expect(settled).not.toHaveBeenCalled();
    finish();
    await expect(work).rejects.toMatchObject({ errors: [failure] });
    await application.shutdown('update');
    expect(first.shutdown).toHaveBeenCalledTimes(2);
    expect(second.shutdown).toHaveBeenCalledTimes(1);
  });

  it('caches the shared promise before a target reenters and contains synchronous failures', async () => {
    let nested: Promise<void> | undefined;
    const failure = new Error('sync cleanup error');
    const second = { shutdown: vi.fn(async () => {}) };
    const application = createApplicationShutdown([
      { shutdown: () => { nested = application.shutdown('fatal'); throw failure; } }, second,
    ]);
    const outer = application.shutdown('fatal');
    await expect(outer).rejects.toMatchObject({ errors: [failure] });
    expect(nested).toBe(outer);
    expect(second.shutdown).toHaveBeenCalledOnce();
  });
});
