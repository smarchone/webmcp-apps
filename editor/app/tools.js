// WebMCP tools for the doc editor. An agent connected to this page (e.g. Claude Code
// through the WebMCP bridge) uses these to read docs, pick up comments, edit and reply.
// Every call goes through the server API, attributed to "claude".

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ ...body, author: 'claude' }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

function formatThread(t) {
  return {
    thread_id: t.id,
    path: t.path,
    highlighted_text: t.anchor?.quote ?? null,
    scope: t.anchor ? 'highlighted text' : 'whole document',
    status: t.status,
    conversation: t.messages.map((m) => ({ from: m.author === 'claude' ? 'claude' : 'user', text: m.text })),
  };
}

export const tools = [
  {
    name: 'list_documents',
    description: 'List the Markdown documents in the workspace, with counts of open comment threads and threads waiting for a reply.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => api('GET', '/api/docs'),
  },
  {
    name: 'read_document',
    description: "Read a document's Markdown source, its current version number, and its open comment threads. Read it before editing.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
    async execute({ path }) {
      const d = await api('GET', `/api/doc?${q({ path })}`);
      return {
        path: d.path,
        version: d.version,
        content: d.content,
        open_threads: d.threads.filter((t) => t.status === 'open').map((t) => formatThread({ ...t, path: d.path })),
      };
    },
  },
  {
    name: 'wait_for_comments',
    description:
      'Wait for comment threads that need a reply from you (new comments, or user replies). Returns them right away if any are waiting, otherwise waits up to timeout_seconds. On timeout returns an empty list plus idle_seconds (time since the user last commented).',
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', default: 300, minimum: 0, maximum: 300 } } },
    async execute({ timeout_seconds = 300 }) {
      const r = await api('GET', `/api/pending?${q({ timeout: timeout_seconds })}`);
      return r.threads.length
        ? {
            threads: r.threads.map(formatThread),
            next: 'For each thread: read_document, make the change with edit_document (pass thread_id), then reply_to_comment.',
          }
        : { threads: [], idle_seconds: r.idle_seconds };
    },
  },
  {
    name: 'list_comments',
    description: "List comment threads. status: 'needs_reply' (waiting for you), 'open', 'resolved', or 'all'. Optionally filter by path.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, status: { type: 'string', enum: ['needs_reply', 'open', 'resolved', 'all'], default: 'needs_reply' } },
    },
    annotations: { readOnlyHint: true },
    async execute({ path, status = 'needs_reply' }) {
      const r = await api('GET', `/api/threads?${q({ path, status: status === 'all' ? undefined : status })}`);
      return { threads: r.threads.map(formatThread) };
    },
  },
  {
    name: 'edit_document',
    description:
      'Edit a document by exact text replacement on its Markdown source. If the user is typing in that document, the edit waits until they pause (up to 30s). Each old_text must match exactly once (or set replace_all). Edits apply in order and create one new version that the user can undo. Pass thread_id when the edit addresses a comment. Re-read the document first: the user may have changed it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
            required: ['old_text', 'new_text'],
          },
        },
        message: { type: 'string', description: 'Short summary of the change, shown in version history' },
        thread_id: { type: 'string' },
      },
      required: ['path', 'edits', 'message'],
    },
    execute: async (args) => api('POST', '/api/edit', args),
  },
  {
    name: 'write_document',
    description: 'Create a new document, or replace the whole content of an existing one. Creates a revertible version.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path ending in .md' }, content: { type: 'string' }, message: { type: 'string' } },
      required: ['path', 'content', 'message'],
    },
    execute: async ({ path, content, message }) => api('PUT', '/api/doc', { path, content, message }),
  },
  {
    name: 'reply_to_comment',
    description:
      'Reply in a comment thread. Set resolve=true when you have fully addressed it (say what you changed). Leave it open when you are asking the user a question.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        thread_id: { type: 'string' },
        text: { type: 'string' },
        resolve: { type: 'boolean', default: false },
      },
      required: ['path', 'thread_id', 'text'],
    },
    async execute(args) {
      return formatThread(await api('POST', '/api/threads/reply', args));
    },
  },
  {
    name: 'add_comment',
    description:
      'Start a comment thread yourself, e.g. to ask the user a question about part of a doc. quote must be text exactly as it appears in the rendered document (no Markdown syntax); omit it for a comment on the whole document.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, quote: { type: 'string' }, text: { type: 'string' } },
      required: ['path', 'text'],
    },
    async execute({ path, quote, text }) {
      return formatThread(await api('POST', '/api/threads', { path, text, anchor: quote ? { quote } : null }));
    },
  },
  {
    name: 'list_versions',
    description: "List a document's version history (who changed it, when, and why).",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true },
    async execute({ path }) {
      const d = await api('GET', `/api/doc?${q({ path })}`);
      return { path: d.path, current_version: d.version, versions: d.versions };
    },
  },
  {
    name: 'revert_document',
    description: 'Restore a document to an earlier version. This adds a new version, so it can be undone too.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, version_id: { type: 'number' } }, required: ['path', 'version_id'] },
    execute: async (args) => api('POST', '/api/revert', args),
  },
];

export async function registerTools() {
  if (!('modelContext' in document)) return { ok: false, count: 0 };
  await Promise.all(tools.map((t) => document.modelContext.registerTool(t)));
  return { ok: true, count: tools.length };
}
