import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NVIDIA_DRIVER_URL, nvidiaDriverUrl, type GpuInfo } from '@/system-setup/contract';
import { isCudaAccelerator, resourceDetailName, resourceDisplayName, resourceNameKey } from './resource-names';
import { cpuFallbackReason, cudaSuitability, deviceHint, vcRuntimeMayExplain } from './transcription-hints';

const locale = (language: string) => JSON.parse(readFileSync(path.resolve('src/locales', language, 'studio.json'), 'utf8'));
const zh = locale('zh');
const translate = (key: string) => key.replace('studio:', '').split('.').reduce((value: any, part) => value?.[part], zh) as string;
const resource = (resourceId: string, resourceType: 'model' | 'vad' | 'accelerator', displayName: string, compatibleBackends: ('cpu' | 'cuda' | 'metal')[] = ['cpu']) =>
  ({ resourceId, resourceType, displayName, compatibleBackends });

describe('plain resource names', () => {
  it('maps the catalog resources to plain names and keeps the catalog name as a detail', () => {
    const standard = resource('large-v3-q5_0', 'model', 'large-v3-q5_0');
    expect(resourceDisplayName(translate, standard)).toBe('标准（推荐，约 1.0 GB）');
    expect(resourceDisplayName(translate, standard, 'short')).toBe('标准');
    expect(resourceDetailName(standard)).toBe('large-v3-q5_0');
    expect(resourceDisplayName(translate, resource('large-v3', 'model', 'large-v3'))).toBe('最高精度（约 2.9 GB，较慢）');
    expect(resourceDisplayName(translate, resource('silero-vad-v6.2.0-ggml', 'vad', 'Silero VAD v6.2.0'))).toBe('语音检测（自动跳过静音）');
    const cuda = resource('speech-windows-x64-cuda-12.4-v1', 'accelerator', 'CUDA 12.4 accelerator', ['cuda']);
    expect(isCudaAccelerator(cuda)).toBe(true);
    expect(resourceDisplayName(translate, cuda)).toBe('NVIDIA 显卡加速');
    expect(resourceDetailName(cuda)).toBe('CUDA 12.4 accelerator');
  });

  it('falls back to the catalog name for resources this version does not know', () => {
    const unknown = resource('medium', 'model', 'Medium');
    expect(resourceNameKey(unknown)).toBeUndefined();
    expect(resourceDisplayName(translate, unknown)).toBe('Medium');
    expect(resourceDetailName(unknown)).toBeUndefined();
    expect(resourceDisplayName(translate, resource('metal-pack', 'accelerator', 'Metal', ['metal']))).toBe('Metal');
  });

  it('has every plain name in all four languages', () => {
    const keys = ['resource_name_standard', 'resource_name_standard_short', 'resource_name_best', 'resource_name_best_short',
      'resource_name_vad', 'resource_name_vad_short', 'resource_name_cuda'];
    for (const language of ['zh', 'zh-Hant', 'en', 'ja']) {
      const transcription = locale(language).transcription;
      for (const key of keys) expect(transcription[key], `${language} ${key}`).toMatch(/\S/);
    }
  });
});

const gpu = (value: Partial<GpuInfo>): GpuInfo => ({ status: 'detected', hasNvidia: true, driverOk: true, ...value });

describe('transcription hints', () => {
  it('lets the VC++ runtime explain only the transcription program crashing or not answering as it loads', () => {
    for (const code of ['runtime_crashed', 'runtime_unresponsive', 'model_incompatible']) expect(vcRuntimeMayExplain(code)).toBe(true);
    // The bundled program's files, a download, the media (FFmpeg needs no runtime), the graphics pack, a generic failure.
    for (const code of ['runtime_missing', 'runtime_protocol_mismatch', 'backend_unverified', 'backend_mismatch', 'accelerator_unavailable', 'model_corrupt',
      'resource_signature_invalid', 'resource_busy', 'media_runtime_launch_failed', 'transcription_failed', 'start_rejected', 'unsupported_media',
      'no_audio_stream', 'output_write_failed', 'model_download_failed', 'insufficient_disk', undefined]) expect(vcRuntimeMayExplain(code)).toBe(false);
  });

  it('says why an automatic task ran on the CPU', () => {
    expect(cpuFallbackReason({ platform: 'win32', gpu: gpu({ hasNvidia: false }), cudaReady: false })).toBe('studio:transcription.cpu_reason_no_nvidia');
    expect(cpuFallbackReason({ platform: 'win32', gpu: gpu({}), cudaReady: false })).toBe('studio:transcription.cpu_reason_not_installed');
    expect(cpuFallbackReason({ platform: 'win32', gpu: null, cudaReady: false })).toBe('studio:transcription.cpu_reason_not_installed');
    expect(cpuFallbackReason({ platform: 'win32', gpu: gpu({}), cudaReady: true })).toBe('studio:transcription.cpu_reason_unavailable');
    expect(cpuFallbackReason({ platform: 'darwin', gpu: null, cudaReady: false })).toBe('studio:transcription.cpu_reason_unavailable');
    expect(cpuFallbackReason({ platform: undefined, gpu: null, cudaReady: false })).toBeUndefined();
  });

  it('explains the device choice on Windows', () => {
    expect(deviceHint({ platform: 'win32', gpu: gpu({ hasNvidia: false }), cudaReady: false })).toBe('studio:transcription.device_hint_no_nvidia');
    expect(deviceHint({ platform: 'win32', gpu: gpu({ hasNvidia: false }), cudaReady: false, device: 'auto' })).toBe('studio:transcription.device_hint_no_nvidia');
    // "NVIDIA GPU" chosen without a card does not fall back to the CPU: it asks for another choice.
    expect(deviceHint({ platform: 'win32', gpu: gpu({ hasNvidia: false }), cudaReady: false, device: 'cuda' })).toBe('studio:transcription.device_hint_cuda_no_nvidia');
    expect(deviceHint({ platform: 'win32', gpu: gpu({ driverVersion: '531.79', driverOk: false }), cudaReady: true })).toBe('studio:transcription.device_hint_driver_old');
    expect(deviceHint({ platform: 'win32', gpu: gpu({ driverVersion: '560.94' }), cudaReady: false })).toBe('studio:transcription.device_hint_install_cuda');
    expect(deviceHint({ platform: 'win32', gpu: gpu({ driverVersion: '560.94' }), cudaReady: true })).toBeUndefined();
    expect(deviceHint({ platform: 'win32', gpu: { status: 'unknown', hasNvidia: false, driverOk: false }, cudaReady: false })).toBeUndefined();
    expect(deviceHint({ platform: 'darwin', gpu: { status: 'not_applicable', hasNvidia: false, driverOk: false }, cudaReady: false })).toBeUndefined();
  });

  it('recommends the NVIDIA pack only where a card was found', () => {
    expect(cudaSuitability(gpu({}))).toBe('recommended');
    expect(cudaSuitability(gpu({ hasNvidia: false }))).toBe('not_applicable');
    expect(cudaSuitability({ status: 'unknown', hasNvidia: false, driverOk: false })).toBe('unknown');
    expect(cudaSuitability(null)).toBe('unknown');
  });
});

describe('NVIDIA driver page', () => {
  it('opens the site of the interface language; Simplified Chinese and anything unknown keep the mainland China site', () => {
    for (const language of ['zh', undefined, 'fr']) expect(nvidiaDriverUrl(language)).toBe(NVIDIA_DRIVER_URL);
    expect(NVIDIA_DRIVER_URL).toBe('https://www.nvidia.cn/drivers/lookup/');
    expect(nvidiaDriverUrl('en')).toBe('https://www.nvidia.com/en-us/drivers/');
    expect(nvidiaDriverUrl('ja')).toBe('https://www.nvidia.com/ja-jp/drivers/');
    expect(nvidiaDriverUrl('zh-Hant')).toBe('https://www.nvidia.com/zh-tw/drivers/');
  });
});
