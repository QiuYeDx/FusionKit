export type SubtitleRecoveryIntent =
  | "subtitle_recovery"
  | "not_recovery";

const RECOVERY_RE =
  /(恢复|续跑|继续上次|继续失败|中断的?翻译|resume|recovery|checkpoint|fusionkit\.resume\.json|resume\.json)/i;

const AMBIGUOUS_RE =
  /翻译.*resume\.json|resume\.json.*翻译/i;

export function classifySubtitleRecoveryIntent(
  text: string,
): SubtitleRecoveryIntent {
  const normalized = text.trim();
  if (!normalized) return "not_recovery";

  if (AMBIGUOUS_RE.test(normalized) && !RECOVERY_RE.test(normalized)) {
    return "not_recovery";
  }

  if (RECOVERY_RE.test(normalized)) return "subtitle_recovery";
  return "not_recovery";
}
