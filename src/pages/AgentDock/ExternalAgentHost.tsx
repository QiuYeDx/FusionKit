import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { installExternalAgentHost } from "@/agent/external/host";
import { installExternalActivity } from "@/agent/external/activity-store";
import { externalActivityPath } from "@/pages/ExternalAgentActivity/route";
import ExternalAgentConfirmDialog from "./ExternalAgentConfirmDialog";

/**
 * Runs external agents' tool calls (MCP) in this window while the app is open,
 * asks the user when one needs a yes, and follows the activity record.
 */
export default function ExternalAgentHost() {
  const navigate = useNavigate();
  useEffect(() => installExternalAgentHost(), []);
  useEffect(() => installExternalActivity(typeof window === "undefined" ? undefined : window.externalAgent,
    (sessionId) => navigate(externalActivityPath(sessionId))), [navigate]);
  return <ExternalAgentConfirmDialog />;
}
