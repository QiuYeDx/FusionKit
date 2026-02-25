import { ipcMain } from "electron";
import type { AxiosRequestConfig } from "axios";

export interface ProxyConfig {
  mode: "none" | "system" | "custom";
  host: string;
  port: string;
}

let currentProxyConfig: ProxyConfig = {
  mode: "none",
  host: "",
  port: "",
};

export function getProxyConfig(): ProxyConfig {
  return currentProxyConfig;
}

export function getAxiosProxyConfig(): Pick<AxiosRequestConfig, "proxy"> {
  const config = currentProxyConfig;

  if (config.mode === "none") {
    return { proxy: false };
  }

  if (config.mode === "custom" && config.host && config.port) {
    return {
      proxy: {
        host: config.host,
        port: parseInt(config.port, 10),
        protocol: "http",
      },
    };
  }

  // "system" mode: let axios use environment variables (HTTP_PROXY / HTTPS_PROXY)
  return {};
}

export function setupProxyIPC() {
  ipcMain.on("set-proxy-config", (_event, config: ProxyConfig) => {
    currentProxyConfig = config;
    console.log("[proxy] config updated:", config);
  });
}
