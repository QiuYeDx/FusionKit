export { LOCAL_SUBTITLE_MODEL_MANIFEST as SPEECH_MODEL_MANIFEST } from './engine/model-manifest';
export { LOCAL_SUBTITLE_VAD_MANIFEST as SPEECH_VAD_MANIFEST } from './engine/vad-manifest';
export { LOCAL_SUBTITLE_WINDOWS_CUDA_MANIFEST as SPEECH_CUDA_MANIFEST } from './engine/accelerator-manifest';
export { LOCAL_SUBTITLE_WINDOWS_CUDA_PACK_DEFINITION as SPEECH_CUDA_PACK_DEFINITION } from './engine/accelerator-manager';
export const SPEECH_CUDA_RESOURCE_ID = 'speech-windows-x64-cuda-12.4-v1' as const;
export function canonicalResourceId(id: string): string {
  return id === 'local-subtitle-windows-x64-cuda-12.4-v1' || id === 'subtitle-studio-windows-x64-cuda-12.4-v1' ? SPEECH_CUDA_RESOURCE_ID : id;
}
