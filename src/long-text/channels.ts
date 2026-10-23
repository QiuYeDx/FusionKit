import { z } from 'zod';

/**
 * IPC channel names and the change event of the long text translator. The preload bundle imports
 * this file at runtime, so it depends on zod only.
 */
export const LONG_TEXT_CHANNEL_PREFIX = 'long-text:';
export const LONG_TEXT_CHANNELS = {
  list: 'long-text:list', pickFiles: 'long-text:pick-files', importFiles: 'long-text:import-files', importText: 'long-text:import-text',
  read: 'long-text:read', readPage: 'long-text:read-page', query: 'long-text:query', locate: 'long-text:locate', estimate: 'long-text:estimate',
  updateSettings: 'long-text:update-settings', confirmEncoding: 'long-text:confirm-encoding', previewEncoding: 'long-text:preview-encoding', resegment: 'long-text:resegment',
  start: 'long-text:start', retranslate: 'long-text:retranslate', pause: 'long-text:pause',
  edit: 'long-text:edit', setLocked: 'long-text:set-locked', undo: 'long-text:undo', dismissFlag: 'long-text:dismiss-flag', clear: 'long-text:clear',
  readLedger: 'long-text:read-ledger', updateLedger: 'long-text:update-ledger',
  chooseExportFolder: 'long-text:choose-export-folder', export: 'long-text:export', copy: 'long-text:copy', reveal: 'long-text:reveal',
  rename: 'long-text:rename', remove: 'long-text:remove',
  /** Main process → renderer. */
  changed: 'long-text:changed',
} as const;

export const changeEventSchema = z.strictObject({
  /** Global and strictly increasing; the renderer drops anything not newer than what it handled. */
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['list', 'document', 'segments', 'deleted']),
  documentId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative().optional(),
  /** Inclusive range of segment indices. */
  range: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
  pages: z.array(z.number().int().min(0)).max(64).optional(),
  /** The latest `DocumentSummary`, produced by the main process. */
  summary: z.unknown().optional(),
});
export type LongTextChangeEvent = z.infer<typeof changeEventSchema>;
