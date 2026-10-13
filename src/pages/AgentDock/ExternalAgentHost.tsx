import { useEffect } from "react";
import { installExternalAgentHost } from "@/agent/external/host";
import ExternalAgentConfirmDialog from "./ExternalAgentConfirmDialog";

/** Runs external agents' tool calls (MCP) in this window while the app is open, and asks the user when one needs a yes. */
export default function ExternalAgentHost() {
  useEffect(() => installExternalAgentHost(), []);
  return <ExternalAgentConfirmDialog />;
}
