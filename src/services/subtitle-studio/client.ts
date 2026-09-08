import { StudioError } from '../../subtitle-studio/domain';
import type { StudioResult } from '../../subtitle-studio/ipc-contract';

export async function unwrapStudio<T>(result: Promise<StudioResult<T>>): Promise<T> {
  const response = await result;
  if (!response.ok) throw new StudioError(response.error);
  return response.value;
}
