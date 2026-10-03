import type { TFunction } from "i18next";

const errorKeys = {
  task_model_not_configured: "home:action_error_model",
  task_model_configuration_invalid: "home:action_error_model",
  prepared_action_expired: "home:action_error_expired",
  agent_session_changed: "home:action_error_expired",
  studio_transcription_draft_changed: "home:action_error_changed",
  studio_transcription_existing_drafts: "home:action_error_drafts",
  studio_translation_plan_has_no_ready_documents: "home:action_error_documents",
  studio_translation_not_admitted: "home:action_error_documents",
  agent_cancelled: "home:action_dismissed",
  prepared_action_failed: "home:action_error_failed",
  tool_request_failed: "home:action_error_failed",
  revision_conflict: "studio:errors.revision_conflict",
  document_unavailable: "studio:errors.document_unavailable",
  needs_configuration: "studio:errors.needs_configuration",
  translation_failed: "studio:errors.translation_failed",
  transcription_failed: "studio:errors.transcription_failed",
  prepared_action_limit: "home:action_error_limit",
  invalid_tool_arguments: "home:action_error_arguments",
  studio_transcription_not_admitted: "home:action_error_changed",
  studio_transcription_submission_unknown: "home:action_error_submission_unknown",
  studio_translation_submission_unknown: "home:action_error_submission_unknown",
  access_denied: "studio:errors.access_denied",
  studio_transcription_not_ready: "home:action_error_changed",
  unsupported_feature: "studio:errors.unsupported_feature",
  limit_exceeded: "studio:errors.limit_exceeded",
} as const;

export function actionErrorMessage(error: string, t: TFunction): string {
  return Object.prototype.hasOwnProperty.call(errorKeys, error)
    ? t(errorKeys[error as keyof typeof errorKeys]) : error;
}
