import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  EXTERNAL_MAX_BODY_BYTES,
  EXTERNAL_SESSION_IDLE_MS,
  MAX_EXTERNAL_SESSIONS,
  type ExternalAgentErrorCode,
  type ExternalClientInfo,
  type ExternalSessionSummary,
  type ExternalToolCall,
  type ExternalToolOutcome,
} from "../../../src/agent/external/contract";
import { describeExternalTools, describeIssues, EXTERNAL_TOOLS, isExternalToolName } from "../../../src/agent/external/catalog";
import { EXTERNAL_AGENT_INSTRUCTIONS } from "../../../src/agent/external/instructions";

export type GuardVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404 };

/**
 * Who may talk to the endpoint: only `/mcp`, never a browser page (any Origin), only
 * through the loopback host name the endpoint listens on, and only with the token.
 */
export function guardRequest(request: { url?: string; headers: IncomingMessage["headers"] }, expected: { port: number; token: string }): GuardVerdict {
  const pathname = (request.url ?? "").split("?")[0];
  if (pathname !== "/mcp") return { ok: false, status: 404 };
  if (request.headers.origin !== undefined) return { ok: false, status: 403 };
  const host = String(request.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${expected.port}` && host !== `localhost:${expected.port}`) return { ok: false, status: 403 };
  const header = String(request.headers.authorization ?? "");
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !expected.token) return { ok: false, status: 401 };
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(expected.token);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { ok: false, status: 401 };
  return { ok: true };
}

class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function plain(response: ServerResponse, status: number, headers: Record<string, string> = {}) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  response.end(status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 413 ? "Payload Too Large" : "Error");
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function toCallResult(outcome: ExternalToolOutcome): CallToolResult {
  if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.data ?? null) }] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: outcome.error, ...(outcome.detail ?? {}) }) }] };
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  client?: ExternalClientInfo;
  connectedAt: number;
  lastActiveAt: number;
}

export interface ExternalAgentHostOptions {
  version: string;
  /** Runs a validated tool call; the window does the work. */
  callTool: (call: Omit<ExternalToolCall, "callId">, signal: AbortSignal) => Promise<ExternalToolOutcome>;
  onSessionsChanged?: () => void;
  maxSessions?: number;
  sessionIdleMs?: number;
  maxBodyBytes?: number;
  now?: () => number;
}

/** The MCP Streamable HTTP endpoint on 127.0.0.1. One MCP server per client session. */
export class ExternalAgentHttpHost {
  private http: HttpServer | null = null;
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout | null = null;
  private expected = { port: 0, token: "" };

  constructor(private readonly options: ExternalAgentHostOptions) {}

  get listening(): boolean { return !!this.http?.listening; }
  get port(): number { return this.expected.port; }
  private now() { return this.options.now?.() ?? Date.now(); }

  sessionSummaries(): ExternalSessionSummary[] {
    return [...this.sessions.entries()].filter(([, session]) => session.client)
      .map(([id, session]) => ({ id, client: session.client!, connectedAt: session.connectedAt, lastActiveAt: session.lastActiveAt }));
  }

  /** Port 0 picks a free port (tests); the bound port is returned. */
  async start(port: number, token: string): Promise<{ ok: true; port: number } | { ok: false; error: ExternalAgentErrorCode }> {
    await this.stop();
    const http = createServer((request, response) => { void this.handle(request, response); });
    const result = await new Promise<{ ok: true; port: number } | { ok: false; error: ExternalAgentErrorCode }>(resolve => {
      http.once("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, error: error.code === "EADDRINUSE" ? "port_in_use" : "listen_failed" }));
      http.listen(port, "127.0.0.1", () => resolve({ ok: true, port: (http.address() as { port: number }).port }));
    });
    if (!result.ok) { http.close(); return result; }
    http.on("error", () => undefined);
    this.http = http;
    this.expected = { port: result.port, token };
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
    return result;
  }

  async stop(): Promise<void> {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    await this.closeAllSessions();
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections?.(); });
  }

  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
    this.options.onSessionsChanged?.();
    return true;
  }

  async closeAllSessions(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.closeSession(id);
  }

  /** Sessions idle for too long end; their clients start a new one on the next request. */
  sweep(): void {
    const limit = this.options.sessionIdleMs ?? EXTERNAL_SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) if (this.now() - session.lastActiveAt > limit) void this.closeSession(id);
  }

  private createServer(sessionRef: { id?: string }): Server {
    const server = new Server({ name: "fusionkit", title: "FusionKit", version: this.options.version },
      { capabilities: { tools: {} }, instructions: EXTERNAL_AGENT_INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: describeExternalTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      if (!isExternalToolName(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      const parsed = EXTERNAL_TOOLS[name].inputSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) return toCallResult({ ok: false, error: "invalid_arguments", detail: { issues: describeIssues(parsed.error) } });
      const session = sessionRef.id ? this.sessions.get(sessionRef.id) : undefined;
      if (!session || !sessionRef.id) return toCallResult({ ok: false, error: "session_closed" });
      const outcome = await this.options.callTool({
        sessionId: sessionRef.id, client: session.client ?? { name: "unknown", version: "" }, tool: name,
        arguments: parsed.data as Record<string, unknown>,
      }, extra.signal);
      return toCallResult(outcome);
    });
    server.oninitialized = () => {
      const session = sessionRef.id ? this.sessions.get(sessionRef.id) : undefined;
      if (!session) return;
      const client = server.getClientVersion();
      session.client = { name: String(client?.name ?? "unknown").slice(0, 100), version: String(client?.version ?? "").slice(0, 50) };
      this.options.onSessionsChanged?.();
    };
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const verdict = guardRequest(request, this.expected);
      if (!verdict.ok) {
        request.resume();
        plain(response, verdict.status, verdict.status === 401 ? { "WWW-Authenticate": 'Bearer realm="fusionkit"' } : {});
        return;
      }
      let body: unknown;
      if (request.method === "POST") {
        try { body = await readBody(request, this.options.maxBodyBytes ?? EXTERNAL_MAX_BODY_BYTES); }
        catch (error) {
          if (error instanceof BodyTooLarge) { plain(response, 413, { Connection: "close" }); request.destroy(); return; }
          jsonRpcError(response, 400, ErrorCode.ParseError, "Parse error"); return;
        }
      }
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) { jsonRpcError(response, 404, -32001, "Session not found"); return; }
        session.lastActiveAt = this.now();
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method !== "POST") { jsonRpcError(response, 400, ErrorCode.InvalidRequest, "Missing session"); return; }
      if (this.sessions.size >= (this.options.maxSessions ?? MAX_EXTERNAL_SESSIONS)) {
        jsonRpcError(response, 503, ErrorCode.InvalidRequest, "too_many_sessions"); return;
      }
      const ref: { id?: string } = {};
      const server = this.createServer(ref);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => {
          ref.id = id;
          this.sessions.set(id, { transport, server, connectedAt: this.now(), lastActiveAt: this.now() });
        },
        onsessionclosed: id => { void this.closeSession(id); },
      });
      transport.onclose = () => { if (ref.id && this.sessions.get(ref.id)?.transport === transport) void this.closeSession(ref.id); };
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
      // A request that did not initialize leaves nothing behind.
      if (!ref.id) { await transport.close().catch(() => undefined); await server.close().catch(() => undefined); }
    } catch {
      jsonRpcError(response, 500, ErrorCode.InternalError, "Internal error");
    }
  }
}
