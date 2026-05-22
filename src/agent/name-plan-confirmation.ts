const EXPLICIT_CONTEXT_RE =
  /(刚才|这个|这份|当前|该|上述|上面|刚生成|刚创建|last|this|current|the)/i;
const ACTION_RE = /(确认|执行|应用|开始|apply|execute|run|confirm)/i;
const NON_CONFIRM_ACTION_RE = /(执行|应用|开始|apply|execute|run)/i;
const RENAME_OR_PLAN_RE = /(重命名|改名|名称翻译|rename|plan|计划)/i;
const QUESTION_RE = /[?？]|吗\b|能不能|是否|可不可以|可以.*吗/;

export function isExplicitRenameConfirmation(
  text: string,
  planId?: string
): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/g, "").toLowerCase();
  if (QUESTION_RE.test(compact)) return false;

  const lowerPlanId = planId?.toLowerCase();
  const shortPlanId = lowerPlanId?.slice(-8);
  const mentionsPlanId =
    !!lowerPlanId &&
    (compact.includes(lowerPlanId) ||
      (!!shortPlanId && compact.includes(shortPlanId)));

  if (mentionsPlanId && ACTION_RE.test(compact)) return true;

  const hasAction = ACTION_RE.test(compact);
  const hasNonConfirmAction = NON_CONFIRM_ACTION_RE.test(compact);
  const hasRenameOrPlan = RENAME_OR_PLAN_RE.test(compact);
  const hasContext = EXPLICIT_CONTEXT_RE.test(compact);
  const hasConfirm = /确认|confirm/i.test(compact);

  if (hasConfirm && (hasNonConfirmAction || hasRenameOrPlan)) return true;
  if (hasAction && hasRenameOrPlan && hasContext) return true;

  return false;
}
