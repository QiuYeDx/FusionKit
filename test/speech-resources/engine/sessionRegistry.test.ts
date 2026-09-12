import { describe, expect, it } from 'vitest';
import { LocalSubtitleSessionRegistry } from '../../../electron/main/speech-resources/engine/session-registry';
import type { LocalSubtitleResourceJobSummary } from '../../../src/speech-resources/contracts';

const owner = Object.freeze({ webContentsId: 711, ownerSessionId: 'shared-resource-registry' });
const job = (jobId: string): LocalSubtitleResourceJobSummary => ({
  jobId, resourceId: 'large-v3-q5_0', resourceType: 'model', status: 'queued', progress: 0,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
});

describe('resource-only registry publication', () => {
  it('orders nested publication after all listeners of the current revision', () => {
    const registry = new LocalSubtitleSessionRegistry();
    const delivered: string[] = [];
    registry.onResourceEvent(owner, event => {
      delivered.push(`a${event.revision}`);
      if (event.revision === 1) registry.upsertResourceJob(owner, job('nested'));
    });
    registry.onResourceEvent(owner, event => { delivered.push(`b${event.revision}`); });
    registry.upsertResourceJob(owner, job('first'));
    expect(delivered).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(registry.getSnapshot(owner)).toMatchObject({ revision: 2, batches: [], resourceJobs: [job('first'), job('nested')] });
  });

  it('fences owner release during delivery and discards already queued events', () => {
    const registry = new LocalSubtitleSessionRegistry();
    const delivered: number[] = [];
    registry.onResourceEvent(owner, event => {
      delivered.push(event.revision);
      registry.upsertResourceJob(owner, job('nested'));
      registry.releaseOwner(owner);
    });
    registry.onResourceEvent(owner, () => { delivered.push(99); });
    registry.upsertResourceJob(owner, job('first'));
    expect(delivered).toEqual([1]);
    expect(() => registry.upsertResourceJob(owner, job('late'))).toThrow(expect.objectContaining({ code: 'owner_released' }));
  });

  it('keeps authoritative resource state despite a throwing or rejecting subscriber', async () => {
    const registry = new LocalSubtitleSessionRegistry();
    const delivered: number[] = [];
    registry.onResourceEvent(owner, () => { throw new Error('subscriber unavailable'); });
    registry.onResourceEvent(owner, async () => { throw new Error('asynchronous subscriber unavailable'); });
    registry.onResourceEvent(owner, event => { delivered.push(event.revision); });
    registry.upsertResourceJob(owner, job('one'));
    await Promise.resolve();
    expect(delivered).toEqual([1]);
    expect(registry.getResourceJob(owner, 'one')).toEqual(job('one'));
  });

  it('bounds resources per owner and keeps shutdown promise identity', async () => {
    const registry = new LocalSubtitleSessionRegistry();
    for (let index = 0; index < 100; index++) registry.upsertResourceJob(owner, job(`job-${index}`));
    expect(() => registry.upsertResourceJob(owner, job('overflow'))).toThrow(expect.objectContaining({ code: 'limit_exceeded' }));
    const operation = registry.shutdown();
    expect(registry.shutdown()).toBe(operation);
    await operation;
    expect(() => registry.getSnapshot(owner)).toThrow(expect.objectContaining({ code: 'owner_released' }));
  });
});
