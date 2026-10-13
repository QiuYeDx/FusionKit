import { randomUUID } from "node:crypto";
import {
  EXTERNAL_AGENT_CHANNELS,
  EXTERNAL_CALL_TIMEOUT_MS,
  EXTERNAL_MAX_BODY_BYTES,
  EXTERNAL_READY_WAIT_MS,
  externalToolResponseSchema,
  type ExternalToolCall,
  type ExternalToolOutcome,
} from "../../../src/agent/external/contract";

/** The part of the main window's webContents the bridge uses. */
export interface BridgeTarget {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

interface PendingCall {
  targetId: number;
  finish: (outcome: ExternalToolOutcome) => void;
}

const unavailable: ExternalToolOutcome = { ok: false, error: "fusionkit_window_unavailable" };

/**
 * Hands tool calls to the window that runs them and waits for its answer. Only the
 * window that declared itself ready, while it stays on the same page, may answer.
 */
export class RendererBridge {
  private readyTarget: number | null = null;
  private readyWaiters = new Set<() => void>();
  private pending = new Map<string, PendingCall>();

  constructor(private readonly options: {
    getTarget: () => BridgeTarget | null;
    readyWaitMs?: number;
    callTimeoutMs?: number;
  }) {}

  get isReady(): boolean {
    const target = this.options.getTarget();
    return !!target && !target.isDestroyed() && target.id === this.readyTarget;
  }

  /** The window's tool host is listening. */
  markReady(targetId: number): void {
    const target = this.options.getTarget();
    if (!target || target.id !== targetId) return;
    this.readyTarget = targetId;
    for (const wake of this.readyWaiters) wake();
    this.readyWaiters.clear();
  }

  /** The window navigated, crashed or closed: its host and every call it held are gone. */
  invalidate(targetId?: number): void {
    if (targetId !== undefined && this.readyTarget !== null && targetId !== this.readyTarget) return;
    this.readyTarget = null;
    for (const [callId, call] of this.pending) {
      if (targetId === undefined || call.targetId === targetId) { this.pending.delete(callId); call.finish(unavailable); }
    }
  }

  private waitForReady(signal?: AbortSignal): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.readyWaiters.delete(wake); signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const wake = () => done(this.isReady);
      const abort = () => done(false);
      const timer = setTimeout(() => done(false), this.options.readyWaitMs ?? EXTERNAL_READY_WAIT_MS);
      this.readyWaiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async call(input: Omit<ExternalToolCall, "callId">, signal?: AbortSignal): Promise<ExternalToolOutcome> {
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    if (!(await this.waitForReady(signal))) return signal?.aborted ? { ok: false, error: "cancelled" } : unavailable;
    const target = this.options.getTarget();
    if (!target || target.isDestroyed()) return unavailable;
    const callId = randomUUID();
    return new Promise<ExternalToolOutcome>(resolve => {
      const finish = (outcome: ExternalToolOutcome) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(callId);
        resolve(outcome);
      };
      const abort = () => {
        if (!this.pending.has(callId)) return;
        if (!target.isDestroyed()) target.send(EXTERNAL_AGENT_CHANNELS.cancel, { callId });
        finish({ ok: false, error: "cancelled" });
      };
      const timer = setTimeout(() => {
        if (!target.isDestroyed()) target.send(EXTERNAL_AGENT_CHANNELS.cancel, { callId });
        finish({ ok: false, error: "tool_timeout" });
      }, this.options.callTimeoutMs ?? EXTERNAL_CALL_TIMEOUT_MS);
      this.pending.set(callId, { targetId: target.id, finish });
      signal?.addEventListener("abort", abort, { once: true });
      target.send(EXTERNAL_AGENT_CHANNELS.call, { ...input, callId } satisfies ExternalToolCall);
    });
  }

  /** An answer from the window; anything not matching a call this window holds is dropped. */
  respond(targetId: number, payload: unknown): boolean {
    const parsed = externalToolResponseSchema.safeParse(payload);
    if (!parsed.success) return false;
    const call = this.pending.get(parsed.data.callId);
    if (!call || call.targetId !== targetId || targetId !== this.readyTarget) return false;
    let outcome = parsed.data.result;
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(outcome)); } catch { /* unserializable counts as too large */ }
    if (size > EXTERNAL_MAX_BODY_BYTES) outcome = { ok: false, error: "result_too_large" };
    call.finish(outcome);
    return true;
  }

  /** Every call still waiting; used on shutdown. */
  close(): void {
    this.invalidate();
    for (const wake of this.readyWaiters) wake();
    this.readyWaiters.clear();
  }
}
