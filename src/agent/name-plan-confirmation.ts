const NEGATIVE_OR_CONDITIONAL_RE = /不|没|未|别|取消|暂缓|勿|如果|假如|等到|除非|\b(?:no|not|never|dont|cannot|cancel|stop|wait|if|unless|whether|can|could|should|would|\w+n['’]t)\b/i;
const CHINESE_TARGET_RE = /^(?:(?:刚才|这个|这份|当前|该|上述|上面|刚生成|刚创建)的?)?(?:重命名(?:计划)?|改名(?:计划)?|名称翻译(?:计划)?|计划|plan)$/i;
const ENGLISH_TARGET_RE = /^(?:(?:the|this|current|last)\s+)?(?:rename\s+plan|renaming\s+plan|plan|rename)$/i;

/** Accept short affirmative commands, not narrative mentions, quotes or questions. */
export function isExplicitRenameConfirmation(text: string, planId?: string): boolean {
  const normalized = text.trim().replace(/[.!。！]+$/u, "").trim();
  if (!normalized || /[?？]/.test(normalized) || NEGATIVE_OR_CONDITIONAL_RE.test(normalized)) return false;

  const matchesPlanId = (target: string) => {
    const id = planId?.toLowerCase();
    return !!id && (target.toLowerCase() === id || (id.length >= 8 && target.toLowerCase() === id.slice(-8)));
  };
  const chinese = normalized.replace(/\s+/g, "").match(/^(?:请|现在请|现在|立即|我)?(确认(?:执行|应用|开始)?|执行|应用|开始)(.*)$/);
  if (chinese) {
    const [, action, target] = chinese;
    if (!target) return action.startsWith("确认") && action !== "确认";
    return matchesPlanId(target) || CHINESE_TARGET_RE.test(target);
  }

  const english = normalized.match(/^(?:please\s+)?(?:i\s+)?(confirm(?:\s+and\s+(?:apply|execute|run))?|apply|execute|run)\s+(.+)$/i);
  if (!english) return false;
  return matchesPlanId(english[2]) || ENGLISH_TARGET_RE.test(english[2]);
}
