import { useLocation } from "react-router-dom";
import { useAgentPageContext } from "@/agent/page-context";
import { classicPageContext } from "@/agent/classic-page-contexts";

/**
 * Registers the agent page context of the classic tool on screen. Their state
 * lives in global stores, so the pages themselves stay unchanged.
 */
export default function ClassicPageContexts() {
  const { pathname } = useLocation();
  useAgentPageContext(() => classicPageContext(pathname));
  return null;
}
