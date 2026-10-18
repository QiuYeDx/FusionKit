import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeDetail, testModelConnection, CONNECTION_TEST_OUTPUT_TOKENS } from "../../electron/main/model-setup/connection-test";
import { configureNetworkRuntime } from "../../electron/main/network/runtime";
import { DEFAULT_NETWORK_SETTINGS } from "../../src/network/contract";
import { closeAllServers, closedPort, startHttpServer } from "../network/local-servers";

const KEY = "sk-connection-test-secret-123456";

/** A model API stand-in that records each request and answers with `reply`. */
async function startModelServer(reply: (request: http.IncomingMessage, body: Record<string, unknown>, response: http.ServerResponse) => void) {
  const requests: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = await startHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      requests.push({ url: request.url ?? "", headers: request.headers, body });
      reply(request, body, response);
    });
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, server };
}

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
const completion = { id: "c1", object: "chat.completion", model: "deepseek-v4-flash", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }] };
const request = (baseUrl: string, overrides: Record<string, unknown> = {}) => ({
  baseUrl, apiFormat: "chat_completions", modelKey: "deepseek-v4-flash", apiKey: KEY, outputTokenParameter: "max_tokens", ...overrides,
});

afterEach(async () => {
  await closeAllServers();
  configureNetworkRuntime({ getSettings: () => ({ ...DEFAULT_NETWORK_SETTINGS, proxy: { mode: "none", host: "", port: "" } }) });
});

describe("model connection test", () => {
  it("sends one tiny Chat Completions request with the profile and reports the time it took", async () => {
    const api = await startModelServer((_request, _body, response) => json(response, 200, completion));
    const result = await testModelConnection(request(api.baseUrl));
    expect(result).toMatchObject({ ok: true, category: "ok" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ url: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}` } });
    expect(api.requests[0].body).toMatchObject({ model: "deepseek-v4-flash", max_tokens: CONNECTION_TEST_OUTPUT_TOKENS });
    expect(api.requests[0].body).not.toHaveProperty("temperature");
  });

  it("follows the API format and output token parameter of the profile", async () => {
    const api = await startModelServer((request, _body, response) => request.url === "/v1/responses"
      ? json(response, 200, { id: "r1", object: "response", status: "completed", output_text: "Hi", output: [] })
      : json(response, 200, completion));
    expect(await testModelConnection(request(api.baseUrl, { apiFormat: "responses", modelKey: "gpt-5.5", outputTokenParameter: undefined }))).toMatchObject({ ok: true });
    expect(await testModelConnection(request(api.baseUrl, { modelKey: "gpt-5", outputTokenParameter: "max_completion_tokens" }))).toMatchObject({ ok: true });
    expect(api.requests[0]).toMatchObject({ url: "/v1/responses", body: { model: "gpt-5.5", max_output_tokens: CONNECTION_TEST_OUTPUT_TOKENS } });
    expect(api.requests[1].body).toMatchObject({ max_completion_tokens: CONNECTION_TEST_OUTPUT_TOKENS });
    expect(api.requests[1].body).not.toHaveProperty("max_tokens");
  });

  it("counts a reply cut short by the tiny output limit as working", async () => {
    const api = await startModelServer((_request, _body, response) => json(response, 200, {
      ...completion, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }],
    }));
    expect(await testModelConnection(request(api.baseUrl))).toMatchObject({ ok: true, category: "ok" });
  });

  it.each([
    [401, { error: { message: `Authentication Fails, Your api key: ${KEY} is invalid`, type: "authentication_error" } }, "auth"],
    [402, { error: { message: "Insufficient Balance", type: "unknown_error" } }, "balance"],
    [400, { error: { message: "Model Not Exist", type: "invalid_request_error" } }, "model_not_found"],
    [429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }, "rate_limited"],
    [500, { error: { message: "internal", type: "server_error" } }, "server"],
    [405, { error: { message: "Method Not Allowed" } }, "bad_url"],
  ] as const)("classifies HTTP %i answers", async (status, body, category) => {
    const api = await startModelServer((_request, _body, response) => json(response, status, body));
    const result = await testModelConnection(request(api.baseUrl));
    expect(result).toMatchObject({ ok: false, category, httpStatus: status, detailSource: "service" });
    // One attempt only, and the key never comes back to the window.
    expect(api.requests).toHaveLength(1);
    // The service's own words, without our English wrapper around them.
    expect(result.detail).toBeTruthy();
    expect(result.detail).not.toContain("Model request failed");
    expect(result.detail).not.toContain(KEY);
  });

  it("does not take an error a gateway answers with HTTP 200, or a stray JSON object, for a working connection", async () => {
    const quota = await startModelServer((_request, _body, response) => json(response, 200, { error: { message: "You exceeded your current quota", code: "insufficient_quota" } }));
    expect(await testModelConnection(request(quota.baseUrl))).toEqual({ ok: false, latencyMs: expect.any(Number), category: "balance", detail: "You exceeded your current quota", detailSource: "service" });
    expect(await testModelConnection(request(quota.baseUrl, { apiFormat: "responses", outputTokenParameter: undefined }))).toMatchObject({ ok: false, category: "balance" });
    // Not a Responses API at all: an empty object or a status page.
    for (const body of [{}, { status: "ok" }]) {
      const other = await startModelServer((_request, _body, response) => json(response, 200, body));
      const result = await testModelConnection(request(other.baseUrl, { apiFormat: "responses", outputTokenParameter: undefined }));
      expect(result).toMatchObject({ ok: false, category: "bad_url" });
      expect(result).not.toHaveProperty("detail");
    }
    // A real Responses object that said nothing still counts.
    const quiet = await startModelServer((_request, _body, response) => json(response, 200, { id: "r1", object: "response", status: "completed", output: [] }));
    expect(await testModelConnection(request(quiet.baseUrl, { apiFormat: "responses", outputTokenParameter: undefined }))).toMatchObject({ ok: true });
  });

  it("tells a key refused without a body from an address that is not an API", async () => {
    const refused = await startModelServer((_request, _body, response) => { response.writeHead(401); response.end(); });
    expect(await testModelConnection(request(refused.baseUrl))).toMatchObject({ ok: false, category: "auth", httpStatus: 401 });
    const route = await startModelServer((_request, _body, response) => json(response, 404, { detail: "Not Found" }));
    expect(await testModelConnection(request(route.baseUrl))).toMatchObject({ ok: false, category: "bad_url", httpStatus: 404, detail: "Not Found" });
  });

  it("recognises an address that is a web page rather than a model API", async () => {
    const api = await startModelServer((_request, _body, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Welcome</title>");
    });
    expect(await testModelConnection(request(api.baseUrl))).toMatchObject({ ok: false, category: "bad_url" });
    const missing = await startModelServer((_request, _body, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<html>Not Found</html>");
    });
    expect(await testModelConnection(request(missing.baseUrl))).toMatchObject({ ok: false, category: "bad_url", httpStatus: 404 });
  });

  it("reports a server that does not listen or does not answer as a network problem", async () => {
    const port = await closedPort();
    // What the connection reported is labelled as such, not as the service's answer.
    expect(await testModelConnection(request(`http://127.0.0.1:${port}/v1`))).toMatchObject({ ok: false, category: "network", detailSource: "connection", detail: expect.stringContaining("ECONNREFUSED") });
    const silent = await startModelServer(() => undefined);
    const started = Date.now();
    const result = await testModelConnection(request(silent.baseUrl), { timeoutMs: 300 });
    expect(result).toEqual({ ok: false, latencyMs: expect.any(Number), category: "network", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("goes through the proxy of the network settings and reports a proxy that is down", async () => {
    const port = await closedPort();
    configureNetworkRuntime({ getSettings: () => ({ ...DEFAULT_NETWORK_SETTINGS, proxy: { mode: "custom", host: "127.0.0.1", port: String(port) } }) });
    const result = await testModelConnection(request("https://api.deepseek.example.test/v1"));
    expect(result).toMatchObject({ ok: false, category: "proxy" });
  });

  it("checks the profile before sending anything, and says exactly what is missing", async () => {
    const send = vi.fn();
    const notSent = (category: string, reason: string) => ({ ok: false, latencyMs: 0, category, reason });
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { apiKey: "  " }), { send })).toEqual(notSent("auth", "missing_key"));
    // A key pasted with more than the key: Chinese or full-width text, a space inside.
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { apiKey: "Key：sk-abc" }), { send })).toEqual(notSent("auth", "key_characters"));
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { apiKey: "sk-abc def" }), { send })).toEqual(notSent("auth", "key_characters"));
    expect(await testModelConnection(request("ftp://example.com/v1"), { send })).toEqual(notSent("bad_url", "invalid_url"));
    expect(await testModelConnection(request(""), { send })).toEqual(notSent("bad_url", "missing_url"));
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { modelKey: "" }), { send })).toEqual(notSent("model_not_found", "missing_model"));
    expect(await testModelConnection({ baseUrl: "https://api.deepseek.com/v1" }, { send })).toEqual({ ok: false, latencyMs: 0, category: "unknown" });
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { extra: true }), { send })).toEqual({ ok: false, latencyMs: 0, category: "unknown" });
    expect(send).not.toHaveBeenCalled();
    // Surrounding spaces from a copy are fine.
    expect(await testModelConnection(request("https://api.deepseek.com/v1", { apiKey: ` ${KEY}\n` }), { send: async () => ({ content: "Hi" }) as never })).toMatchObject({ ok: true });
  });

  it("removes keys from details and keeps them short", () => {
    expect(sanitizeDetail(`bad key ${KEY} and Bearer abc.def`, KEY)).toBe("bad key [redacted] and Bearer [redacted]");
    expect(sanitizeDetail("leaked sk-abcdefghijklmnop", "other")).toBe("leaked [redacted]");
    expect(sanitizeDetail("x".repeat(500), KEY)).toHaveLength(300);
  });
});
