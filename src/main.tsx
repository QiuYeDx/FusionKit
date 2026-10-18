import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import "./index.css";
// Applies the clickable-element cursor setting (html[data-cursor]) before the first render.
import "@/store/useCursorStore";

import "@/i18n";
import { HashRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

// 在渲染进程中接收进度更新并调用 store 的 updateProgress 方法
import "@/renderer/subtitle";
import { getLocalSubtitleEnvironmentService } from "@/services/local-subtitle/localSubtitleEnvironmentService";
import { getLocalSubtitleRuntimeService } from "@/services/local-subtitle/localSubtitleRuntimeService";
import { initAgentSessions } from "@/agent/session-persistence";
import { removeRemovedToolSettings } from "@/lib/legacy-storage-cleanup";
import useNetworkStore from "@/store/useNetworkStore";

// Settings left behind by removed tools (they could hold an API key).
removeRemovedToolSettings();
// Local subtitle execution and its initial environment snapshot belong to the
// renderer session, not to a route component. Both services are idempotent.
void getLocalSubtitleRuntimeService().start();
void getLocalSubtitleEnvironmentService().ensureInitialized();
// Saved Agent conversations: the list is read once, changes are saved as they happen.
void initAgentSessions();
// Network settings live in the main process; this also moves a proxy saved by older versions there.
void useNetworkStore.getState().init();

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

root.render(
  <React.StrictMode>
    <HashRouter>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </HashRouter>
  </React.StrictMode>
);

postMessage({ payload: "removeLoading" }, "*");
