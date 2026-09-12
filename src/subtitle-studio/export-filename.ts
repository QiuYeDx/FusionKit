import { StudioError } from './domain';
import { fileNameSuffixSchema, type ExportOptions } from './export-contract';

/** Naming is independent of completeness; partial output remains explicit plan metadata. */
export function subtitleExportFileName(doc: { origin: { displayName: string }; translationTracks: readonly { id: string; language: string }[] }, options: ExportOptions): string {
  const suffix = fileNameSuffixSchema.safeParse(options.fileNameSuffix ?? { mode: 'none' });
  if (!suffix.success) throw new StudioError('invalid_input');
  let base = doc.origin.displayName.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || 'subtitle';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  let value = '';
  if (suffix.data.mode === 'custom') value = suffix.data.value;
  else if (suffix.data.mode === 'preset') {
    value = suffix.data.preset === 'content-mode' ? options.mode
      : options.mode === 'source' ? '' : doc.translationTracks.find(track => track.id === options.trackId)?.language ?? '';
    value = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_').replace(/[. ]+$/, '').slice(0, 40);
  }
  return `${base}${value ? `.${value}` : ''}.${options.format}`;
}
