import type { GpuInfo } from '@/system-setup/contract';

/**
 * Short explanations next to local transcription resources and tasks: when a missing VC++
 * runtime is the likely cause of a failure, why an "automatic" task ran on the CPU, and what the
 * device choice can use on this computer.
 */

/** Failures the VC++ runtime can explain (shared with one-click prepare). */
export { vcRuntimeMayExplain } from '@/services/system-setup/system-setup-store';

export type CpuFallbackReasonKey = 'studio:transcription.cpu_reason_no_nvidia' | 'studio:transcription.cpu_reason_not_installed' | 'studio:transcription.cpu_reason_unavailable';

/** Why a task that asked for the automatic device ran on the CPU; undefined where the CPU is the only choice. */
export function cpuFallbackReason(input: { platform?: string; gpu: GpuInfo | null; cudaReady: boolean }): CpuFallbackReasonKey | undefined {
  if (input.platform === 'darwin') return 'studio:transcription.cpu_reason_unavailable';
  if (input.platform !== 'win32') return undefined;
  if (input.gpu?.status === 'detected' && !input.gpu.hasNvidia) return 'studio:transcription.cpu_reason_no_nvidia';
  return input.cudaReady ? 'studio:transcription.cpu_reason_unavailable' : 'studio:transcription.cpu_reason_not_installed';
}

export type DeviceHintKey = 'studio:transcription.device_hint_no_nvidia' | 'studio:transcription.device_hint_cuda_no_nvidia'
  | 'studio:transcription.device_hint_driver_old' | 'studio:transcription.device_hint_install_cuda';

/**
 * What the device choice can use on this Windows computer, when the graphics card is the question.
 * Choosing "NVIDIA GPU" without a card does not fall back to the CPU, so that case asks for another choice.
 */
export function deviceHint(input: { platform?: string; gpu: GpuInfo | null; cudaReady: boolean; device?: string }): DeviceHintKey | undefined {
  if (input.platform !== 'win32' || input.gpu?.status !== 'detected') return undefined;
  if (!input.gpu.hasNvidia) return input.device === 'cuda' ? 'studio:transcription.device_hint_cuda_no_nvidia' : 'studio:transcription.device_hint_no_nvidia';
  if (input.gpu.driverVersion && !input.gpu.driverOk) return 'studio:transcription.device_hint_driver_old';
  return input.cudaReady ? undefined : 'studio:transcription.device_hint_install_cuda';
}

/** The CUDA pack row: recommended with an NVIDIA card, "not for this computer" without one. */
export function cudaSuitability(gpu: GpuInfo | null): 'recommended' | 'not_applicable' | 'unknown' {
  if (gpu?.status !== 'detected') return 'unknown';
  return gpu.hasNvidia ? 'recommended' : 'not_applicable';
}
