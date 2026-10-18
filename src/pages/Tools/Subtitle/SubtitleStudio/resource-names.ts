import type { LocalSubtitleManagedResourceSummary } from '@/subtitle-studio/transcription/ipc-contract';

/**
 * Plain names for local transcription resources. The catalog's names ("large-v3-q5_0",
 * "Silero VAD v6.2.0", "CUDA 12.4 accelerator") stay as they are and are shown as a detail line;
 * this mapping lives in the interface only.
 */
type Resource = Pick<LocalSubtitleManagedResourceSummary, 'resourceId' | 'resourceType' | 'displayName' | 'compatibleBackends'>;

export type ResourceNameKey = 'studio:transcription.resource_name_standard' | 'studio:transcription.resource_name_standard_short'
  | 'studio:transcription.resource_name_best' | 'studio:transcription.resource_name_best_short'
  | 'studio:transcription.resource_name_vad' | 'studio:transcription.resource_name_vad_short' | 'studio:transcription.resource_name_cuda';

const MODEL_NAMES: Readonly<Record<string, { full: ResourceNameKey; short: ResourceNameKey }>> = {
  'large-v3-q5_0': { full: 'studio:transcription.resource_name_standard', short: 'studio:transcription.resource_name_standard_short' },
  'large-v3': { full: 'studio:transcription.resource_name_best', short: 'studio:transcription.resource_name_best_short' },
};

/** The NVIDIA acceleration pack (the only accelerator: Windows CUDA). */
export function isCudaAccelerator(resource: Pick<Resource, 'resourceType' | 'compatibleBackends'>): boolean {
  return resource.resourceType === 'accelerator' && resource.compatibleBackends.includes('cuda');
}

/** The i18n key of a resource's plain name, or undefined for one this version does not know. */
export function resourceNameKey(resource: Resource, variant: 'full' | 'short' = 'full'): ResourceNameKey | undefined {
  if (resource.resourceType === 'model') return MODEL_NAMES[resource.resourceId]?.[variant];
  if (resource.resourceType === 'vad') return variant === 'short' ? 'studio:transcription.resource_name_vad_short' : 'studio:transcription.resource_name_vad';
  if (isCudaAccelerator(resource)) return 'studio:transcription.resource_name_cuda';
  return undefined;
}

/** The plain name, falling back to the catalog's own. */
export function resourceDisplayName(translate: (key: ResourceNameKey) => string, resource: Resource, variant: 'full' | 'short' = 'full'): string {
  const key = resourceNameKey(resource, variant);
  return key ? translate(key) : resource.displayName;
}

/** The catalog's own name (or the id), shown next to the plain one; undefined when it would only repeat it. */
export function resourceDetailName(resource: Resource): string | undefined {
  return resourceNameKey(resource) ? resource.displayName : undefined;
}
