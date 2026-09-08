import { STUDIO_CHANNELS } from '../../src/subtitle-studio/ipc-contract';

export function isPublicStudioChannel(channel: string) {
  return [STUDIO_CHANNELS.importSubtitle, STUDIO_CHANNELS.listDocuments, STUDIO_CHANNELS.readDocumentPage, STUDIO_CHANNELS.exportSource, STUDIO_CHANNELS.deleteDocument, STUDIO_CHANNELS.removeTask].some(value => value === channel);
}

export function assertLegacyStudioChannelAllowed(channel: string) {
  if (channel.startsWith('subtitle-studio:')) throw new Error('Use subtitleStudio methods.');
}
