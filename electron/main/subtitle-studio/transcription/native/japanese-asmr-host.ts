import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { createLocalSubtitleError } from '../../../../../src/subtitle-studio/transcription/domain';

export type JapaneseAsmrHost = Awaited<ReturnType<typeof openJapaneseAsmrHost>>;

/** Owned for exactly one VAD stage. Abort and timeouts join the process before returning. */
export async function openJapaneseAsmrHost(modelPath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const entry = fileURLToPath(new URL(/* @vite-ignore */ './japanese-asmr-worker.js', import.meta.url));
  if (!utilityProcess?.fork) throw createLocalSubtitleError("media_runtime_launch_failed", "ASMR timing requires an Electron utility process.", { stage: "loading_model" });
  const child = utilityProcess.fork(entry, [modelPath], { serviceName: 'FusionKit ASMR VAD', stdio: 'ignore' });
  let exited = false;
  let closeOperation: Promise<void> | undefined;
  let pending: ((result: { data: unknown } | null) => void) | undefined;
  const exit = new Promise<number>(resolve => child.once('exit', code => {
    exited = true;
    pending?.(null);
    resolve(code);
  }));
  const kill = () => { if (!exited) child.kill(); };
  signal.addEventListener('abort', kill, { once: true });
  child.on('message', (data: unknown) => pending?.({ data }));
  const failure = (stage: 'loading_model' | 'transcribing') => createLocalSubtitleError(
    stage === 'loading_model' ? 'media_runtime_launch_failed' : 'transcription_failed',
    'The ASMR timing worker could not complete its operation.', { stage });

  async function exchange(stage: 'loading_model' | 'transcribing', send?: () => void): Promise<unknown> {
    signal.throwIfAborted();
    if (exited || closeOperation || pending) throw failure(stage);
    const received = new Promise<{ data: unknown } | null>(resolve => { pending = resolve; });
    const watchdog = setTimeout(kill, 120_000);
    try {
      send?.();
      const result = await received;
      signal.throwIfAborted();
      if (!result || exited) throw failure(stage);
      return result.data;
    } finally { clearTimeout(watchdog); pending = undefined; }
  }

  function close() {
    return closeOperation ??= (async () => {
      if (!pending && !signal.aborted && !exited) {
        try { child.postMessage('close'); } catch { kill(); }
      } else kill();
      const watchdog = setTimeout(kill, 5_000);
      try { await exit; } finally {
        clearTimeout(watchdog);
        signal.removeEventListener('abort', kill);
      }
    })();
  }

  try {
    if (await exchange('loading_model') !== 'ready') throw failure('loading_model');
  } catch (error) { await close(); throw error; }
  return {
    async run(samples: Float32Array) {
      const result = await exchange('transcribing', () => child.postMessage(samples));
      if (!(result instanceof Float32Array) || result.length !== Math.ceil(samples.length / 320)
        || result.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw failure('transcribing');
      return result;
    }, close,
  };
}

export async function smokeJapaneseAsmrVad(modelPath: string, signal: AbortSignal) {
  const host = await openJapaneseAsmrHost(modelPath, signal);
  try { await host.run(new Float32Array(320)); }
  finally { await host.close(); }
}
