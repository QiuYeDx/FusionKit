/** Experimental acoustic candidates, NOT a speech/silence classifier or production policy. */
export const PAUSE_PLAN_POLICY = Object.freeze({ sampleRate: 16000, frameMs: 10, minQuietMs: 600,
  guardMs: 300, rmsDb: -55, peakDb: -45, targetMs: 25000, minMs: 18000, searchEndMs: 29000,
  maxMs: 30000, fallbackOverlapMs: 5000 });

export function findAcousticQuietCandidates(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new TypeError('Expected nonempty PCM16LE');
  const p = PAUSE_PLAN_POLICY, frame = p.sampleRate * p.frameMs / 1000;
  const total = pcm.length / 2, rmsLimit = 32768 ** 2 * 10 ** (p.rmsDb / 10), peakLimit = 32768 * 10 ** (p.peakDb / 20);
  const candidates = []; let start;
  const finish = end => { if (start !== undefined && end - start >= p.minQuietMs * 16) candidates.push({ startFrame: start, endFrame: end }); start = undefined; };
  for (let at = 0; at < total; at += frame) {
    const end = Math.min(total, at + frame); let energy = 0, peak = 0;
    for (let i = at; i < end; i++) { const value = pcm.readInt16LE(i * 2); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
    if (energy / (end - at) <= rmsLimit && peak <= peakLimit) { start ??= at; } else finish(at);
  }
  finish(total); return candidates;
}

export function planPauseAwareWindows(totalFrames, candidates) {
  if (!Number.isSafeInteger(totalFrames) || totalFrames <= 0 || totalFrames > 16000 * 60 * 60 * 24 || !Array.isArray(candidates)) throw new TypeError('Invalid input');
  let previousEnd = 0;
  for (const c of candidates) {
    if (!c || !Number.isSafeInteger(c.startFrame) || !Number.isSafeInteger(c.endFrame) || c.startFrame < previousEnd ||
      c.endFrame > totalFrames || c.endFrame - c.startFrame < PAUSE_PLAN_POLICY.minQuietMs * 16) throw new TypeError('Invalid quiet candidate');
    previousEnd = c.endFrame;
  }
  const p = PAUSE_PLAN_POLICY, windows = []; let inputStart = 0, coreStart = 0;
  while (inputStart < totalFrames) {
    const maxEnd = Math.min(totalFrames, inputStart + p.maxMs * 16);
    let end = maxEnd, coreEnd = maxEnd, nextStart = maxEnd, reason = 'end', quiet;
    if (maxEnd < totalFrames) {
      const low = inputStart + p.minMs * 16, high = inputStart + p.searchEndMs * 16, target = inputStart + p.targetMs * 16;
      const choices = candidates.flatMap(c => {
        const from = Math.max(low, c.startFrame + p.guardMs * 16), to = Math.min(high, c.endFrame - p.guardMs * 16);
        return from <= to ? [{ cut: Math.max(from, Math.min(to, target)), candidate: c }] : [];
      }).sort((a, b) => Math.abs(a.cut - target) - Math.abs(b.cut - target) || a.cut - b.cut);
      if (choices.length) {
        end = coreEnd = nextStart = choices[0].cut; quiet = choices[0].candidate; reason = 'acoustic_quiet_candidate';
      } else {
        coreEnd = end - p.fallbackOverlapMs * 16 / 2; nextStart = end - p.fallbackOverlapMs * 16; reason = 'overlap_fallback';
      }
    }
    windows.push({ startFrame: inputStart, endFrame: end, coreStartFrame: coreStart, coreEndFrame: coreEnd, reason, ...(quiet ? { quiet } : {}) });
    inputStart = nextStart; coreStart = coreEnd;
  }
  return { policy: p, totalFrames, windows };
}
