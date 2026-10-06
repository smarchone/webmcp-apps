#!/usr/bin/env node
// WebMCP bridge: a stdio MCP server that lets any Claude Code session use the
// WebMCP tools (document.modelContext) of any web page.
//
// It drives a dedicated Chrome instance over the DevTools protocol, injects
// interceptor.js into every page before page scripts run, and exposes:
//   browser_open_page, browser_list_tabs, page_list_tools, page_call_tool
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const INTERCEPTOR = await readFile(new URL('./interceptor.js', import.meta.url), 'utf8');
const PROFILE_DIR = process.env.WEBMCP_PROFILE_DIR || path.join(os.homedir(), '.webmcp-bridge', 'chrome-profile');
const CHROME_PATH = process.env.CHROME_PATH || findChrome();

const log = (...args) => process.stderr.write(`[webmcp-bridge] ${args.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }[process.platform] || [];
  return candidates.find((p) => existsSync(p));
}

// ---------- Chrome DevTools Protocol ----------

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Browser connection closed'));
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) {
    this.listeners.add(fn);
  }
}

let cdp = null;
let connecting = null;
const sessions = new Map(); // targetId -> sessionId
const injected = new Set(); // targetIds whose interceptor is installed

async function readDevToolsUrl() {
  try {
    const [port, wsPath] = (await readFile(path.join(PROFILE_DIR, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch {
    return null;
  }
}

async function launchChrome() {
  if (!CHROME_PATH) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium executable.');
  await mkdir(PROFILE_DIR, { recursive: true });
  await rm(path.join(PROFILE_DIR, 'DevToolsActivePort'), { force: true });
  log('launching', CHROME_PATH);
  const child = spawn(
    CHROME_PATH,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Keep background tabs responsive while an agent is talking to them
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref(); // the browser outlives this bridge; the next session reuses it
  for (let i = 0; i < 100; i++) {
    const url = await readDevToolsUrl();
    if (url) return url;
    await sleep(150);
  }
  throw new Error('Chrome did not expose a DevTools endpoint in time.');
}

async function ensureBrowser() {
  if (cdp && !cdp.closed) return cdp;
  connecting ??= (async () => {
    let url = await readDevToolsUrl();
    let conn = url && (await CDP.connect(url).catch(() => null));
    if (!conn) conn = await CDP.connect(await launchChrome());
    sessions.clear();
    injected.clear();
    conn.on(onBrowserEvent);
    cdp = conn;
    await conn.send('Target.setDiscoverTargets', { discover: true });
    await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = await conn.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page' && !t.attached && !sessions.has(t.targetId)) {
        await conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
      }
    }
    return conn;
  })().finally(() => (connecting = null));
  return connecting;
}

function onBrowserEvent(msg) {
  if (msg.method === 'Target.attachedToTarget') {
    onAttached(msg.params).catch((err) => log('attach failed:', err.message));
  } else if (msg.method === 'Target.detachedFromTarget') {
    for (const [targetId, sid] of sessions) {
      if (sid === msg.params.sessionId) {
        sessions.delete(targetId);
        injected.delete(targetId);
      }
    }
  } else if (msg.method === 'Target.targetDestroyed') {
    sessions.delete(msg.params.targetId);
    injected.delete(msg.params.targetId);
  }
}

async function onAttached({ sessionId, targetInfo, waitingForDebugger }) {
  const resume = () => waitingForDebugger && cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  if (targetInfo.type !== 'page' || sessions.has(targetInfo.targetId)) {
    await resume();
    if (targetInfo.type !== 'page') await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    return;
  }
  sessions.set(targetInfo.targetId, sessionId);
  // Before any page script, on this and every future navigation of the tab
  // (Page must be enabled or the script is silently not applied)
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INTERCEPTOR }, sessionId);
  // For a document that is already loaded (tools registered earlier can't be recovered)
  await cdp.send('Runtime.evaluate', { expression: INTERCEPTOR }, sessionId).catch(() => {});
  injected.add(targetInfo.targetId);
  await resume();
}

async function evaluate(targetId, expression) {
  const sessionId = sessions.get(targetId);
  if (!sessionId) throw new Error('Tab is not attached (it may have been closed).');
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function pageTabs() {
  await ensureBrowser();
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page' && sessions.has(t.targetId));
}

async function pageTools(targetId) {
  return (await evaluate(targetId, 'window.__webmcpBridge ? window.__webmcpBridge.list() : []').catch(() => [])) || [];
}

const shortId = (targetId) => targetId.slice(0, 8);

// Resolve a tab argument (id prefix, or omitted = the only tab exposing tools)
async function resolveTab(tab) {
  const tabs = await pageTabs();
  if (tab) {
    const match = tabs.filter((t) => t.targetId.toLowerCase().startsWith(String(tab).toLowerCase()));
    if (match.length === 1) return match[0];
    throw new Error(`No unique tab matches "${tab}". Use browser_list_tabs.`);
  }
  const withTools = [];
  for (const t of tabs) if ((await pageTools(t.targetId)).length) withTools.push(t);
  if (withTools.length === 1) return withTools[0];
  throw new Error(
    withTools.length
      ? `Several tabs expose WebMCP tools (${withTools.map((t) => shortId(t.targetId)).join(', ')}); pass "tab".`
      : 'No open tab exposes WebMCP tools. Use browser_open_page first.',
  );
}

// ---------- Bridge tools ----------

const TOOLS = [
  {
    name: 'browser_open_page',
    description:
      'Open a URL in the WebMCP browser (a Chrome window controlled by this bridge) and return the WebMCP tools the page registers via document.modelContext.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run({ url }) {
      await ensureBrowser();
      // Open blank, let onAttached inject the interceptor, then navigate
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      for (let i = 0; i < 50 && !injected.has(targetId); i++) await sleep(100);
      if (!injected.has(targetId)) throw new Error('Could not attach to the new tab.');
      await cdp.send('Page.navigate', { url }, sessions.get(targetId));
      // Wait for the page to load and register its tools
      let tools = [];
      for (let i = 0; i < 40; i++) {
        const ready = await evaluate(targetId, 'document.readyState').catch(() => null);
        tools = ready === 'complete' ? await pageTools(targetId) : [];
        if (tools.length) break;
        await sleep(150);
      }
      const title = await evaluate(targetId, 'document.title').catch(() => '');
      return {
        tab: shortId(targetId),
        url,
        title,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        hint: tools.length ? 'Call page_list_tools for input schemas, page_call_tool to run one.' : 'This page registered no WebMCP tools.',
      };
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List tabs in the WebMCP browser with their URL, title and the names of the WebMCP tools each page exposes.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const tabs = await pageTabs();
      return Promise.all(
        tabs.map(async (t) => ({ tab: shortId(t.targetId), url: t.url, title: t.title, tools: (await pageTools(t.targetId)).map((x) => x.name) })),
      );
    },
  },
  {
    name: 'page_list_tools',
    description: 'List the WebMCP tools a page exposes, with descriptions and JSON input schemas.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id from browser_list_tabs; optional if only one tab has tools' } },
    },
    async run({ tab }) {
      const t = await resolveTab(tab);
      return { tab: shortId(t.targetId), url: t.url, tools: await pageTools(t.targetId) };
    },
  },
  {
    name: 'page_call_tool',
    description: "Call one of a page's WebMCP tools and return its result.",
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name from page_list_tools' },
        arguments: { type: 'object', description: "Arguments matching the tool's input schema" },
        tab: { type: 'string', description: 'Tab id; optional if only one tab has tools' },
      },
      required: ['tool'],
    },
    async run({ tool, arguments: args = {}, tab }) {
      const t = await resolveTab(tab);
      const expr = `window.__webmcpBridge ? window.__webmcpBridge.call(${JSON.stringify(tool)}, ${JSON.stringify(args)}) : { content: [{ type: 'text', text: 'Page has no WebMCP tools.' }], isError: true }`;
      return { raw: await evaluate(t.targetId, expr) }; // already an MCP tool result
    },
  },
];

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.run(args || {});
    if (out?.raw) return out.raw;
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

// ---------- MCP over stdio ----------

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return; // notification
  const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'webmcp-bridge', version: '0.2.0' },
        instructions:
          'Use these tools to work with web pages that expose WebMCP tools (document.modelContext). Open a page with browser_open_page, inspect its tools with page_list_tools, and run them with page_call_tool.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      return reply(await callTool(msg.params?.name, msg.params?.arguments));
    default:
      return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg).catch((err) => write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } }));
});
process.stdin.on('end', () => process.exit(0));
log('ready');
