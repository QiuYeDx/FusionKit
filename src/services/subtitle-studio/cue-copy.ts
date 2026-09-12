export type CueCopyMode = 'source' | 'target' | 'bilingual';
export type CueCopyContent = {
  source: string;
  target?: string;
  startMs: number;
  endMs: number | null;
};

function timestamp(ms: number): string {
  const value = Math.abs(ms);
  return `${ms < 0 ? '-' : ''}${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
}

/** Clipboard text, not a subtitle export: unknown end times remain unknown. */
export function buildCueCopyText(content: CueCopyContent, mode: CueCopyMode, includeTiming = false): string | null {
  if (mode !== 'source' && !content.target?.trim()) return null;
  const text = mode === 'source' ? content.source
    : mode === 'target' ? content.target!
      : content.source + '\n' + content.target!;
  if (!includeTiming) return text;
  const timing = timestamp(content.startMs) + (content.endMs === null ? '' : ' → ' + timestamp(content.endMs));
  return '[' + timing + ']\n' + text;
}
