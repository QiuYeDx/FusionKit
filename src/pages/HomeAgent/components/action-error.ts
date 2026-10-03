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
} as const;

export function actionErrorMessage(error: string, t: TFunction): string {
  return Object.prototype.hasOwnProperty.call(errorKeys, error)
    ? t(errorKeys[error as keyof typeof errorKeys]) : error;
}
