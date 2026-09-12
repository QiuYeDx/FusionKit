import { writeFile } from 'node:fs/promises';
import { SpeechResourceService as ProductionService } from '../../../electron/main/speech-resources/service';
import type { SpeechResourceServiceOptions, SpeechResourceUseLease } from '../../../electron/main/speech-resources/service';
import { UI_MODELS, UI_MIGRATION } from './shared-ui-data';

/** Exactly one substitution. Real migration, engine, locking, validation and IPC execute. */
export class SpeechResourceService extends ProductionService {
  constructor(options: SpeechResourceServiceOptions) {
    const gates = new Map<string, () => void>();
    const traces: unknown[] = [];
    super({ ...options, modelCatalog: UI_MODELS.map(entry => entry.model), migrationResources: UI_MIGRATION,
      vadManager: false, acceleratorManager: false,
      smokeModel: async input => { traces.push({ operation: 'synthetic-native-model-smoke', modelId: input.model.id }); },
      smokeVad: async () => { throw new Error('VAD is excluded from the synthetic UI fixture.'); },
      downloadResource: async input => {
        const entry = UI_MODELS.find(value => value.model.downloadUrl === input.sourceUrl);
        if (!entry) throw new Error('Unexpected fixture download URL.');
        traces.push({ operation: 'download-start', resourceId: entry.model.id });
        input.onProgress?.(Math.floor(entry.bytes.length / 3), entry.bytes.length);
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { gates.delete(entry.model.id); traces.push({ operation: 'download-cancel', resourceId: entry.model.id }); reject(input.signal.reason); };
          if (input.signal.aborted) { aborted(); return; }
          input.signal.addEventListener('abort', aborted, { once: true });
          gates.set(entry.model.id, () => { gates.delete(entry.model.id); input.signal.removeEventListener('abort', aborted); resolve(); });
        });
        await writeFile(input.destinationPath, entry.bytes);
        input.onProgress?.(entry.bytes.length, entry.bytes.length);
        return {};
      },
    });
    let lease: SpeechResourceUseLease | undefined;
    (globalThis as any).__speechT09Control = async (command: { operation: string; resourceId?: string }) => {
      if (command.operation === 'complete') gates.get(command.resourceId!)?.();
      if (command.operation === 'busy') { if (lease) throw new Error('A fixture lease is already held.'); lease = this.reserveUse([command.resourceId!]); }
      if (command.operation === 'release') { lease?.release(); lease = undefined; }
      return { status: this.status(), traces, gates: [...gates.keys()], managedResourceRoot: this.managedResourceRoot };
    };
  }
}
