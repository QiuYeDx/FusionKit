/** Compare complete local-window experiments; agreement never proves word presence. */
export function comparisonText(text) {
  if (typeof text !== 'string' || text.length > 4000) throw new Error('Invalid text');
  return text.normalize('NFKC').replace(/[\p{P}\s]/gu, '');
}

export function summarizeWindowStability({ windows, variants, results }) {
  if (!Array.isArray(windows) || !windows.length || windows.length > 16 ||
      !Array.isArray(variants) || !variants.length || variants.length > 4 ||
      !Array.isArray(results) || results.length > 32) throw new Error('Invalid experiment budget');
  const byWindow = new Map(), variantIds = new Set();
  for (const window of windows) {
    if (typeof window.id !== 'string' || !window.id || byWindow.has(window.id) ||
        typeof window.group !== 'string' || !window.group || typeof window.clipId !== 'string' || !window.clipId ||
        !Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs) ||
        window.startMs < 0 || window.endMs <= window.startMs || window.endMs - window.startMs > 30000) {
      throw new Error('Invalid window identity or bounds');
    }
    byWindow.set(window.id, window);
  }
  for (const variant of variants) {
    if (typeof variant.id !== 'string' || !variant.id || variantIds.has(variant.id)) throw new Error('Invalid variant');
    variantIds.add(variant.id);
  }
  const groups = [];
  for (const group of new Set(windows.map(window => window.group))) {
    const members = windows.filter(window => window.group === group);
    if (new Set(members.map(window => window.clipId)).size !== 1 ||
        Math.max(...members.map(window => window.startMs)) >= Math.min(...members.map(window => window.endMs))) {
      throw new Error('Comparison windows must share a clip and overlap');
    }
    groups.push({ group, members });
  }
  const mapped = new Map();
  for (const result of results) {
    const window = byWindow.get(result.window);
    const key = JSON.stringify([result.window, result.variant]);
    if (!window || !variantIds.has(result.variant) || mapped.has(key) ||
        !Array.isArray(result.segments) || result.segments.length > 128) throw new Error('Invalid or duplicate result');
    const segments = result.segments.map(segment => {
      const normalizedText = comparisonText(segment.text);
      const { localStartMs, localEndMs } = segment;
      if (!Number.isSafeInteger(localStartMs) || !Number.isSafeInteger(localEndMs)) throw new Error('Non-finite segment bounds');
      // Recompute the mapping from the window; never trust a caller's mapped timestamps.
      return { text: segment.text, normalizedText,
        clipStartMs: window.startMs + localStartMs, clipEndMs: window.startMs + localEndMs,
        invalidBounds: localStartMs < 0 || localEndMs <= localStartMs || localEndMs > window.endMs - window.startMs };
    });
    mapped.set(key, { window: window.id, segments, normalizedText: segments.map(segment => segment.normalizedText).join('') });
  }
  if (mapped.size !== windows.length * variants.length) throw new Error('Incomplete experiment');
  return groups.flatMap(({ group, members }) => variants.map(variant => {
    const rows = members.map(window => mapped.get(JSON.stringify([window.id, variant.id])));
    const forms = new Set(rows.map(row => row.normalizedText));
    const occurrences = new Map();
    for (const row of rows) for (const segment of row.segments) {
      if (!segment.normalizedText) continue;
      const list = occurrences.get(segment.normalizedText) ?? [];
      list.push({ window: row.window, ...segment });
      occurrences.set(segment.normalizedText, list);
    }
    const matchingCues = [...occurrences].map(([normalizedText, entries]) => ({
      normalizedText, distinctWindows: new Set(entries.map(entry => entry.window)).size,
      repeatedWithinWindow: entries.length > new Set(entries.map(entry => entry.window)).size,
      // These are whole-cue envelopes, not word alignment or acoustic boundaries.
      startSpreadMs: Math.max(...entries.map(entry => entry.clipStartMs)) - Math.min(...entries.map(entry => entry.clipStartMs)),
      endSpreadMs: Math.max(...entries.map(entry => entry.clipEndMs)) - Math.min(...entries.map(entry => entry.clipEndMs)),
      entries,
    }));
    const emptyWindows = rows.filter(row => !row.normalizedText).map(row => row.window);
    return { group, variant: variant.id, windows: rows.length,
      textStatus: rows.length < 2 ? 'insufficient_windows' : emptyWindows.length === rows.length ? 'all_empty_unverified' :
        forms.size === 1 ? 'agrees_unverified' : 'differs',
      distinctWholeTexts: forms.size, emptyWindows,
      invalidBoundsCount: rows.flatMap(row => row.segments).filter(segment => segment.invalidBounds).length,
      matchingCues, rows, acousticTruth: 'unverified', automaticReplacementAllowed: false };
  }));
}
