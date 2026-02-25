import { ipcMain } from "electron";
import type { AxiosRequestConfig } from "axios";
import axios from "axios";

export interface ProxyConfig {
  mode: "none" | "system" | "custom";
  host: string;
  port: string;
}

export interface ProxyTestResult {
  success: boolean;
  latencyMs: number;
  ip?: string;
  proxyMode: string;
  proxyAddress?: string;
  httpStatus?: number;
  error?: string;
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

async function testProxyConnection(): Promise<ProxyTestResult> {
  const config = currentProxyConfig;
  const proxyAddress =
    config.mode === "custom" && config.host && config.port
      ? `${config.host}:${config.port}`
      : config.mode === "system"
        ? process.env.HTTP_PROXY || process.env.HTTPS_PROXY || undefined
        : undefined;

  const start = Date.now();
  try {
    const response = await axios.get("https://httpbin.org/ip", {
      ...getAxiosProxyConfig(),
      timeout: 10000,
    });
    const latencyMs = Date.now() - start;

    return {
      success: true,
      latencyMs,
      ip: response.data?.origin,
      proxyMode: config.mode,
      proxyAddress,
      httpStatus: response.status,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      success: false,
      latencyMs,
      proxyMode: config.mode,
      proxyAddress,
      httpStatus: err?.response?.status,
      error: err?.message || String(err),
    };
  }
}

export function setupProxyIPC() {
  ipcMain.on("set-proxy-config", (_event, config: ProxyConfig) => {
    currentProxyConfig = config;
    console.log("[proxy] config updated:", config);
  });

  ipcMain.handle("test-proxy-connection", async () => {
    return await testProxyConnection();
  });
}
