import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { LONG_TEXT_CHANNELS, type LongTextChangeEvent } from '../../../src/long-text/channels';
import {
  longTextRequestSchemas,
  type LongTextError, type LongTextErrorCode, type LongTextMethod, type LongTextRequest, type LongTextResult, type LongTextValues,
} from '../../../src/long-text/contract';
import { LongTextOperationError } from './repository';
import { LongTextRunError } from './runner';

/**
 * The `long-text:` IPC handlers (design §6.1): one per request schema. Each refuses an untrusted sender
 * with `unavailable`, waits for the module to be ready (`unavailable` when it never got there), parses
 * the request strictly (`invalid_request`), and turns whatever the handler throws into a `LongTextError`.
 */

/** What serves the requests: one method per `longTextRequestSchemas` key, given the parsed request. */
export type LongTextHandlers = { [K in LongTextMethod]: (request: LongTextRequest<K>) => Promise<LongTextValues[K]> };
export type LongTextIpc = Pick<IpcMain, 'handle' | 'removeHandler'>;

export const LONG_TEXT_METHODS = Object.freeze(Object.keys(longTextRequestSchemas) as LongTextMethod[]);

const failure = (code: LongTextErrorCode): LongTextResult<never> => ({ ok: false, error: { code } });

/** The error a renderer sees: the code (and, for model failures, category and provider message) only. */
export function toLongTextError(error: unknown): LongTextError {
  if (error instanceof LongTextRunError) return { ...error.error };
  if (error instanceof LongTextOperationError) {
    if (error.code === 'internal') console.error('[long-text] Internal error', error.cause ?? error);
    return { code: error.code };
  }
  console.error('[long-text] Unexpected error', error);
  return { code: 'internal' };
}

export interface LongTextIpcOptions {
  ipc: LongTextIpc;
  handlers: LongTextHandlers;
  /** Every request waits for it; a rejection makes the module `unavailable`. */
  ready: Promise<unknown>;
  /** Whether the request comes from the main frame of the application window. */
  trust: (event: IpcMainInvokeEvent) => boolean;
}

/** Registers a handler for every request channel; returns the function that removes them all. */
export function registerLongTextIpc({ ipc, handlers, ready, trust }: LongTextIpcOptions): () => void {
  let open = true;
  const invoke = async <K extends LongTextMethod>(method: K, event: IpcMainInvokeEvent, input: unknown): Promise<LongTextResult<LongTextValues[K]>> => {
    if (!open || !trust(event)) return failure('unavailable');
    try {
      await ready;
    } catch {
      return failure('unavailable');
    }
    const schema: z.ZodType = longTextRequestSchemas[method];
    const parsed = schema.safeParse(input);
    if (!parsed.success) return failure('invalid_request');
    try {
      return { ok: true, value: await handlers[method](parsed.data as LongTextRequest<K>) };
    } catch (error) {
      return { ok: false, error: toLongTextError(error) };
    }
  };
  for (const method of LONG_TEXT_METHODS) {
    ipc.handle(LONG_TEXT_CHANNELS[method], (event, input: unknown) => invoke(method, event, input));
  }
  return () => {
    open = false;
    for (const method of LONG_TEXT_METHODS) ipc.removeHandler(LONG_TEXT_CHANNELS[method]);
  };
}

/** Sends change events to the application window while it is alive. */
export function longTextEventSender(getWindow: () => BrowserWindow | null): (event: LongTextChangeEvent) => void {
  return event => {
    const contents = getWindow()?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(LONG_TEXT_CHANNELS.changed, event);
  };
}
