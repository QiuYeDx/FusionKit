'use strict';
// FusionKit MCP stdio bridge.
//
// MCP clients that start a command (stdio) run this script with FusionKit's own
// executable and ELECTRON_RUN_AS_NODE=1, so no separate Node.js is needed. It reads
// JSON-RPC messages line by line from stdin, forwards them to the endpoint FusionKit
// publishes in endpoint.json, and writes the answers to stdout. With --launch it
// starts FusionKit first when FusionKit is not running.
//
//   <FusionKit executable> fusionkit-mcp-stdio.cjs --endpoint <endpoint.json>
//     [--launch <FusionKit executable>] [--app <app folder, development only>]

const fs = require('node:fs');
const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

function parseArgs(argv) {
  const options = { launchArgs: [] };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--endpoint') { options.endpoint = value; index++; }
    else if (key === '--launch') { options.launch = value; index++; }
    else if (key === '--app') { options.app = value; index++; }
    else if (key === '--launch-arg') { options.launchArgs.push(value); index++; }
    else if (key === '--wait-ms') { options.waitMs = Number(value); index++; }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const WAIT_MS = Number.isFinite(options.waitMs) && options.waitMs > 0 ? options.waitMs : 60000;
const UNREACHABLE = 'FusionKit is not reachable: open FusionKit and turn on Settings → External Agent.';

let session = null;
let protocolVersion = null;
let initializeMessage = null;
let initializedNotice = null;
let launched = false;
let renewing = null;

const log = (...parts) => process.stderr.write(`[fusionkit-mcp] ${parts.join(' ')}\n`);
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Unreachable extends Error {}

function readEndpoint() {
  if (!options.endpoint) return null;
  try {
    const endpoint = JSON.parse(fs.readFileSync(options.endpoint, 'utf8'));
    if (endpoint && typeof endpoint.url === 'string' && typeof endpoint.token === 'string') return endpoint;
  } catch { /* not there yet */ }
  return null;
}

function post(endpoint, message, withSession) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.url);
    const body = Buffer.from(JSON.stringify(message));
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Length': body.length,
    };
    if (withSession && session) headers['mcp-session-id'] = session;
    if (withSession && protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', error => reject(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(error.code) ? new Unreachable(error.code) : error));
    request.end(body);
  });
}

/** The JSON-RPC messages of a response, whether JSON or an event stream. */
function messagesOf(response) {
  if (!response.body.trim()) return [];
  const type = String(response.headers['content-type'] || '');
  if (type.includes('text/event-stream')) {
    return response.body.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } }).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(response.body);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function remember(message, response) {
  if (message.method !== 'initialize' || response.status !== 200) return;
  const header = response.headers['mcp-session-id'];
  session = Array.isArray(header) ? header[0] : header || null;
  const result = messagesOf(response).find(item => item && item.id === message.id);
  protocolVersion = result && result.result && result.result.protocolVersion || protocolVersion;
}

/** FusionKit restarted or the session ended: start a new one the way the client did. */
async function reinitialize(endpoint) {
  session = null;
  if (!initializeMessage) return;
  const response = await post(endpoint, initializeMessage, false);
  remember(initializeMessage, response);
  if (initializedNotice) await post(endpoint, initializedNotice, true);
}

async function deliver(message) {
  const endpoint = readEndpoint();
  if (!endpoint) throw new Unreachable('no endpoint');
  const used = session;
  let response = await post(endpoint, message, message.method !== 'initialize');
  if (response.status === 404 && message.method !== 'initialize' && initializeMessage) {
    // Requests that hit the ended session together share one new session.
    if (!renewing && session === used) {
      log('session ended; starting a new one');
      renewing = reinitialize(endpoint).finally(() => { renewing = null; });
    }
    await renewing;
    response = await post(endpoint, message, true);
  }
  if (message.method === 'initialize') { session = null; remember(message, response); }
  if (response.status === 401) throw Object.assign(new Error('FusionKit rejected the token. Reopen FusionKit or copy its configuration again.'), { code: -32001 });
  if (response.status >= 400 && !messagesOf(response).length) throw Object.assign(new Error(`FusionKit answered HTTP ${response.status}.`), { code: -32000 });
  return messagesOf(response);
}

function launch() {
  if (launched || !options.launch) return;
  launched = true;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(options.app ? [options.app] : []), ...options.launchArgs];
  log('starting FusionKit');
  try {
    const child = spawn(options.launch, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
    child.on('error', error => log('could not start FusionKit:', error.message));
    child.unref();
  } catch (error) { log('could not start FusionKit:', error.message); }
}

async function deliverStartingFusionKit(message) {
  try { return await deliver(message); }
  catch (error) {
    if (!(error instanceof Unreachable) || !options.launch) throw error;
  }
  launch();
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    try { return await deliver(message); }
    catch (error) { if (!(error instanceof Unreachable)) throw error; }
  }
  throw new Unreachable('timed out');
}

async function handle(message) {
  if (message && message.method === 'initialize') initializeMessage = message;
  if (message && message.method === 'notifications/initialized') initializedNotice = message;
  try {
    for (const answer of await deliverStartingFusionKit(message)) write(answer);
  } catch (error) {
    const unreachable = error instanceof Unreachable;
    if (!unreachable) log(error.message);
    if (message && message.id !== undefined && message.id !== null) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: unreachable ? -32000 : error.code || -32603, message: unreachable ? UNREACHABLE : error.message } });
    }
  }
}

// initialize runs first; everything after it runs side by side, so a call waiting
// for the user's confirmation in FusionKit never holds up pings or cancellations.
let ready = Promise.resolve();
const pending = new Set();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const work = message && message.method === 'initialize' ? (ready = ready.then(() => handle(message))) : ready.then(() => handle(message));
  pending.add(work);
  work.finally(() => pending.delete(work));
});
input.on('close', () => { Promise.allSettled([...pending]).then(() => process.exit(0)); });
