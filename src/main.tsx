import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import "./index.css";

import "./demos/ipc";
// If you want use Node.js, the`nodeIntegration` needs to be enabled in the Main process.
// import './demos/node'

import "@/i18n/i18n";
import { HashRouter } from "react-router-dom";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);

postMessage({ payload: "removeLoading" }, "*");
