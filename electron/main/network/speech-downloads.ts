import type { DownloadLocalSubtitleResourceOptions } from '../speech-resources/engine/resource-download';
import { SPEECH_CUDA_MANIFEST, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../speech-resources/catalog';
import type { ExpectedResourceFile, ResourceDownloader } from './download-transport';

/**
 * Size and SHA-256 of every downloadable speech resource, by its official address, with the code
 * its manager reports for a file that fails verification (models: model_corrupt, voice detection
 * and the CUDA pack: resource_signature_invalid).
 */
export function speechResourceExpectedFiles(): ReadonlyMap<string, ExpectedResourceFile> {
  const files = new Map<string, ExpectedResourceFile>();
  const add = (url: string, byteSize: number, sha256: string, verificationFailedCode: ExpectedResourceFile['verificationFailedCode']) => (
    files.set(new URL(url).href, Object.freeze({ byteSize, sha256, verificationFailedCode }))
  );
  for (const model of SPEECH_MODEL_MANIFEST.models) add(model.downloadUrl, model.byteSize, model.sha256, 'model_corrupt');
  add(SPEECH_VAD_MANIFEST.vad.downloadUrl, SPEECH_VAD_MANIFEST.vad.byteSize, SPEECH_VAD_MANIFEST.vad.sha256, 'resource_signature_invalid');
  const archive = SPEECH_CUDA_MANIFEST.sourceArchive;
  add(archive.downloadUrl, archive.byteSize, archive.sha256, 'resource_signature_invalid');
  return files;
}

/** The recommended model's official address; the network test checks its download source. */
export function recommendedSpeechModelUrl(): string {
  const models = SPEECH_MODEL_MANIFEST.models;
  return (models.find(model => model.defaultRecommended) ?? models[0]!).downloadUrl;
}

/**
 * Options for the shared speech resource service so that models, voice detection and the CUDA
 * pack all download through the network layer. The managers already accept a download function;
 * the frozen download engine itself is unchanged.
 */
export function speechResourceDownloadOptions(downloader: ResourceDownloader): {
  readonly downloadResource: (options: DownloadLocalSubtitleResourceOptions) => Promise<unknown>;
  readonly vadOptions: { readonly downloadResource: (options: DownloadLocalSubtitleResourceOptions) => Promise<unknown> };
  readonly acceleratorOptions: { readonly downloadResource: (options: DownloadLocalSubtitleResourceOptions) => Promise<unknown> };
} {
  return Object.freeze({
    downloadResource: downloader,
    vadOptions: Object.freeze({ downloadResource: downloader }),
    acceleratorOptions: Object.freeze({ downloadResource: downloader }),
  });
}
