import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import "./index.css";

import "@/i18n";
import { HashRouter } from "react-router-dom";

// 在渲染进程中接收进度更新并调用 store 的 updateProgress 方法
import "@/renderer/subtitle";
import { getLocalSubtitleEnvironmentService } from "@/services/local-subtitle/localSubtitleEnvironmentService";
import { getLocalSubtitleRuntimeService } from "@/services/local-subtitle/localSubtitleRuntimeService";

// Local subtitle execution and its initial environment snapshot belong to the
// renderer session, not to a route component. Both services are idempotent.
void getLocalSubtitleRuntimeService().start();
void getLocalSubtitleEnvironmentService().ensureInitialized();

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

root.render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);

postMessage({ payload: "removeLoading" }, "*");
