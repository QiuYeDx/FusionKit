/** Application-wide invalidation only; resource reads and writes retain their tool IPC authorization. */
export const SPEECH_RESOURCES_CHANGED = 'speech-resources:changed' as const;
export const SPEECH_RESOURCES_STATUS = 'speech-resources:status' as const;
export interface SpeechResourcesChanged { readonly revision: number; }
export interface SpeechResourcesStatus {
  readonly shared: true;
  readonly revision: number;
  readonly busyResourceIds: readonly string[];
  readonly mutationResourceId?: string;
  readonly migrationIssues: readonly { readonly code: string; readonly resourceId?: string }[];
  readonly cleanupPending: boolean;
}
export interface SpeechResourcesNotifications {
  getStatus(): Promise<SpeechResourcesStatus>;
  onChanged(listener: (event: SpeechResourcesChanged) => void): () => void;
}

/** Renderer-only comparison; authority and accepted IDs remain in the main resource service. */
export function speechResourceIsBusy(status: SpeechResourcesStatus | undefined, resourceId: string): boolean {
  const canonical = (id: string) => ['local-subtitle-windows-x64-cuda-12.4-v1', 'subtitle-studio-windows-x64-cuda-12.4-v1'].includes(id)
    ? 'speech-windows-x64-cuda-12.4-v1' : id;
  return !!status && (status.cleanupPending || !!status.mutationResourceId || status.busyResourceIds.some(id => canonical(id) === canonical(resourceId)));
}
