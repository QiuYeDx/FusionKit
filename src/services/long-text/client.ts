import { isModelErrorCategory, type ModelErrorCategory } from '@/lib/model-error-category';
import { LONG_TEXT_ERROR_CODES, type LongTextErrorCode, type LongTextResult } from '@/long-text/contract';

/**
 * A failed `window.longText` call. `code` selects the message; `category` is the cause of a
 * `model_failed`. The provider's own words are left out: they show only in the run notice's fold (U10).
 */
export class LongTextClientError extends Error {
  constructor(
    readonly code: LongTextErrorCode,
    readonly category?: ModelErrorCategory,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'LongTextClientError';
  }
}

/** The code of a failed call; anything that is not a `LongTextClientError` is `internal`. */
export const errorCodeOf = (error: unknown): LongTextErrorCode => error instanceof LongTextClientError ? error.code : 'internal';

const isErrorCode = (value: unknown): value is LongTextErrorCode =>
  typeof value === 'string' && (LONG_TEXT_ERROR_CODES as readonly string[]).includes(value);

/**
 * The value of a successful call; otherwise throws `LongTextClientError`. A rejected invoke means the
 * main-process module never registered its handlers (`unavailable`); a malformed reply is `internal`.
 */
export async function unwrap<T>(pending: Promise<LongTextResult<T>>): Promise<T> {
  let result: LongTextResult<T>;
  try {
    result = await pending;
  } catch (cause) {
    throw new LongTextClientError('unavailable', undefined, { cause });
  }
  if (result?.ok === true) return result.value;
  const error: unknown = result?.ok === false ? result.error : undefined;
  if (!error || typeof error !== 'object' || !('code' in error) || !isErrorCode(error.code)) throw new LongTextClientError('internal');
  const category = 'category' in error && isModelErrorCategory(error.category) ? error.category : undefined;
  throw new LongTextClientError(error.code, category);
}
