import { describe, expect, it } from 'vitest';
import { localSubtitleFileIdentityFromBigIntStats, sameLocalSubtitleFileIdentity,
  sameLocalSubtitleInputFileIdentity } from '../../../electron/main/subtitle-studio/transcription/native/filesystem-object-identity';

describe('Studio user source identity versus private file integrity', () => {
  it.each(['win32', 'darwin', 'linux'])('accepts only metadata drift for %s input objects', platform => {
    const original = localSubtitleFileIdentityFromBigIntStats({ dev: 1n, ino: 2n, size: 44n,
      birthtimeNs: 3_000_000n, mtimeNs: 4_000_000n, ctimeNs: 5_000_000n }, platform);
    const changed = { ...original, ctimeMs: 6 };
    expect(sameLocalSubtitleInputFileIdentity(original, changed)).toBe(true);
    expect(sameLocalSubtitleFileIdentity(original, changed)).toBe(false);
    for (const mutation of [{ size: 45 }, { mtimeMs: 7 }, {
      objectIdentity: localSubtitleFileIdentityFromBigIntStats({ dev: 1n, ino: 9n, size: 44n,
        birthtimeNs: 3_000_000n, mtimeNs: 4_000_000n, ctimeNs: 5_000_000n }, platform).objectIdentity,
    }]) expect(sameLocalSubtitleInputFileIdentity(original, { ...changed, ...mutation })).toBe(false);
  });
});
