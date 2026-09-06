import type {LocalSubtitleCueSummary, LocalSubtitleSegment} from "@/type/localSubtitle";
import type {LocalSubtitleCueTargets} from "./cue-boundary-planner";

/** Describe the final plan without editing it or inferring transcription accuracy. */
export function summarizeLocalSubtitleCues(
  cues: readonly LocalSubtitleSegment[], targets: LocalSubtitleCueTargets,
): LocalSubtitleCueSummary {
  return Object.freeze({
    cueCount: cues.length,
    exceedsTargetCount: cues.filter(cue =>
      cue.endMs - cue.startMs > targets.maxCueDurationMs ||
      cue.text.length > targets.maxCueChars ||
      cue.text.split("\n").some(line => line.length > targets.maxLineChars),
    ).length,
  });
}
