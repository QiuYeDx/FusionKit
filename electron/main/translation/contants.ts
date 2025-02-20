import { SubtitleSliceType } from "./typing";

export const DEFAULT_SLICE_LENGTH_MAP = {
  [SubtitleSliceType.NORMAL]: 3000,
  [SubtitleSliceType.SENSITIVE]: 100,
  [SubtitleSliceType.CUSTOM]: 1000,
};
