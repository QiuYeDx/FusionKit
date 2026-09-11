import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { encodingSchema, type Encoding } from '../../../subtitle-studio/domain';

export const useStudioPreferences = create<{ encoding: Encoding; dismissedRecoveryKey: string; setEncoding: (value: Encoding) => void; dismissRecovery: (key: string) => void }>()(persist(
  set => ({ encoding: 'utf-8', dismissedRecoveryKey: '', setEncoding: encoding => set({ encoding: encodingSchema.parse(encoding) }), dismissRecovery: dismissedRecoveryKey => set({ dismissedRecoveryKey }) }),
  {
    name: 'fusionkit.subtitle-studio.preferences.v1',
    partialize: state => ({ encoding: state.encoding, dismissedRecoveryKey: state.dismissedRecoveryKey }),
    merge: (persisted, current) => {
      const value = persisted as { encoding?: unknown; dismissedRecoveryKey?: unknown } | undefined;
      return { ...current, encoding: encodingSchema.catch('utf-8').parse(value?.encoding), dismissedRecoveryKey: typeof value?.dismissedRecoveryKey === 'string' && value.dismissedRecoveryKey.length <= 200000 ? value.dismissedRecoveryKey : '' };
    },
  },
));
