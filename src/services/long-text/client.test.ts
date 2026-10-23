import { describe, expect, it } from 'vitest';
import type { LongTextResult } from '@/long-text/contract';
import { errorCodeOf, LongTextClientError, unwrap } from './client';

async function failure(pending: Promise<unknown>): Promise<LongTextClientError> {
  const error = await pending.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LongTextClientError);
  return error as LongTextClientError;
}

describe('unwrap', () => {
  it('returns the value of a successful call', async () => {
    await expect(unwrap(Promise.resolve({ ok: true, value: { changed: 3 } }))).resolves.toEqual({ changed: 3 });
  });

  it('throws the error code and model category, without the provider message', async () => {
    const error = await failure(unwrap(Promise.resolve<LongTextResult<never>>({
      ok: false, error: { code: 'model_failed', category: 'balance', message: 'Insufficient Balance' },
    })));
    expect(error).toMatchObject({ code: 'model_failed', category: 'balance', message: 'model_failed', name: 'LongTextClientError' });
    expect(error).not.toHaveProperty('providerMessage');
  });

  it('drops an unknown category', async () => {
    const error = await failure(unwrap(Promise.resolve({ ok: false, error: { code: 'busy', category: 'weather', message: 42 } } as never)));
    expect(error.code).toBe('busy');
    expect(error.category).toBeUndefined();
  });

  it('treats a malformed reply as internal', async () => {
    for (const reply of [undefined, null, {}, { ok: false }, { ok: false, error: { code: 'nope' } }]) {
      expect((await failure(unwrap(Promise.resolve(reply as never)))).code).toBe('internal');
    }
  });

  it('reads the code of any failure, internal when it is not a client error', () => {
    expect(errorCodeOf(new LongTextClientError('busy'))).toBe('busy');
    expect(errorCodeOf(new Error('x'))).toBe('internal');
    expect(errorCodeOf(undefined)).toBe('internal');
  });

  it('treats a rejected invoke as unavailable and keeps the cause', async () => {
    const cause = new Error("No handler registered for 'long-text:list'");
    const error = await failure(unwrap(Promise.reject(cause)));
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBe(cause);
  });
});
