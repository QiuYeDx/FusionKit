import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { encodingSchema, type Encoding } from '../../../subtitle-studio/domain';

export const useStudioPreferences = create<{ encoding: Encoding; setEncoding: (value: Encoding) => void }>()(persist(
  set => ({ encoding: 'utf-8', setEncoding: encoding => set({ encoding: encodingSchema.parse(encoding) }) }),
  {
    name: 'fusionkit.subtitle-studio.preferences.v1',
    partialize: state => ({ encoding: state.encoding }),
    merge: (persisted, current) => ({ ...current, encoding: encodingSchema.catch('utf-8').parse((persisted as { encoding?: unknown } | undefined)?.encoding) }),
  },
));
