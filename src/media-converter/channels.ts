import { queueEventSchema } from './contract';

/**
 * IPC channel names and the change event of the media converter (module-engine design §8). The
 * preload bundle imports this file at runtime, so it depends on zod only (through `contract.ts`,
 * which depends on zod only as well).
 */
export const MEDIA_CONVERTER_CHANNEL_PREFIX = 'media-converter:';
export const MEDIA_CONVERTER_CHANNELS = {
  getSnapshot: 'media-converter:get-snapshot',
  addDroppedFiles: 'media-converter:add-dropped-files',
  pickFiles: 'media-converter:pick-files',
  pickOutputDirectory: 'media-converter:pick-output-directory',
  previewPlan: 'media-converter:preview-plan',
  start: 'media-converter:start',
  cancel: 'media-converter:cancel',
  remove: 'media-converter:remove',
  retry: 'media-converter:retry',
  clear: 'media-converter:clear',
  revealOutput: 'media-converter:reveal-output',
  setOptions: 'media-converter:set-options',
  redetectCapabilities: 'media-converter:redetect-capabilities',
  /** Main process → renderer: `queueEventSchema`, with a global, strictly increasing sequence. */
  changed: 'media-converter:changed',
} as const;

/** What `media-converter:changed` carries; the preload drops every event that fails it. */
export const mediaConverterEventSchema = queueEventSchema;
