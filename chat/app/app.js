// WebMCP Chat: a plain web page that exposes its chat and workspace as WebMCP tools.
// It has no backend and no knowledge of Claude Code; any agent connected to the
// browser through document.modelContext can read messages, reply, and act on the page.

const $ = (id) => document.getElementById(id);
const els = {
  messages: $('messages'),
  empty: $('empty'),
  composer: $('composer'),
  input: $('input'),
  dot: $('status-dot'),
  status: $('status-text'),
  agentStatus: $('agent-status'),
  toolCount: $('tool-count'),
  todos: $('todos'),
  todoForm: $('todo-form'),
  todoInput: $('todo-input'),
  notes: $('notes'),
  panel: $('panel'),
  activity: $('activity'),
  noWebmcp: $('no-webmcp'),
};

// ---------- State ----------

const STORE_KEY = 'webmcp-chat';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) return saved;
  } catch {}
  return { messages: [], todos: [], notes: '', theme: 'auto', accent: '' };
}

const state = load();
const agent = { listening: 0, lastSeen: 0, status: '' };
let lastUserActivity = Date.now(); // page load or last user message
let waiters = [];

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
}

const newId = () => Date.now() + Math.floor(Math.random() * 1000);

// ---------- WebMCP tools ----------

const QUIET_TOOLS = new Set(['chat_wait_for_messages']);

function defineTool(tool) {
  return {
    ...tool,
    async execute(args) {
      agent.lastSeen = Date.now();
      if (!QUIET_TOOLS.has(tool.name)) logActivity(tool.name, args);
      try {
        return await tool.execute(args || {});
      } finally {
        agent.lastSeen = Date.now();
        renderPresence();
      }
    },
  };
}

function findTodo(id) {
  const todo = state.todos.find((t) => t.id === Number(id));
  if (!todo) throw new Error(`No todo with id ${id}`);
  return todo;
}

const tools = [
  {
    name: 'chat_wait_for_messages',
    description:
      'Wait for new messages from the user in the chat. Returns unread messages right away if there are any, otherwise waits up to timeout_seconds. On timeout returns an empty list plus idle_seconds (time since the user last sent a message).',
    inputSchema: {
      type: 'object',
      properties: { timeout_seconds: { type: 'number', default: 300, minimum: 0, maximum: 300 } },
    },
    async execute({ timeout_seconds = 300 }) {
      const take = () => {
        const unread = state.messages.filter((m) => m.role === 'user' && !m.read);
        unread.forEach((m) => (m.read = true));
        if (unread.length) {
          save();
          renderMessages();
        }
        return unread.map(({ id, text, at }) => ({ id, text, sent_at: new Date(at).toISOString() }));
      };
      let messages = take();
      if (!messages.length && timeout_seconds > 0) {
        agent.listening++;
        renderPresence();
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.min(timeout_seconds, 300) * 1000);
          function done() {
            clearTimeout(timer);
            waiters = waiters.filter((w) => w !== done);
            resolve();
          }
          waiters.push(done);
        });
        agent.listening--;
        messages = take();
      }
      return messages.length
        ? { messages, reply_with: 'chat_send_message' }
        : { messages: [], idle_seconds: Math.round((Date.now() - lastUserActivity) / 1000) };
    },
  },
  {
    name: 'chat_send_message',
    description: 'Send a reply to the user in the chat. Supports Markdown.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute({ text }) {
      if (!text?.trim()) throw new Error('text is required');
      state.messages.push({ id: newId(), role: 'assistant', text, at: Date.now() });
      agent.status = '';
      save();
      renderMessages();
      return { delivered: true };
    },
  },
  {
    name: 'chat_set_status',
    description: "Show a short status under the chat while you work, e.g. 'Thinking…' or 'Reading files…'. Pass an empty string to clear it.",
    inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    async execute({ status }) {
      agent.status = String(status || '').slice(0, 120);
      return { ok: true };
    },
  },
  {
    name: 'chat_get_history',
    description: 'Get the most recent chat messages (user and assistant).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 20 } } },
    async execute({ limit = 20 }) {
      return state.messages.slice(-limit).map(({ role, text, at }) => ({ role, text, sent_at: new Date(at).toISOString() }));
    },
  },
  {
    name: 'get_workspace',
    description: "Read the user's workspace: todo list (with ids and done state), notes pad, and current theme.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async execute() {
      return { todos: state.todos, notes: state.notes, theme: state.theme, accent: state.accent || null };
    },
  },
  {
    name: 'add_todos',
    description: "Add one or more items to the user's todo list.",
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } } },
      required: ['items'],
    },
    async execute({ items }) {
      const added = (items || []).filter(Boolean).map((text) => ({ id: newId(), text: String(text), done: false }));
      state.todos.push(...added);
      saveWorkspace();
      return { added };
    },
  },
  {
    name: 'update_todo',
    description: 'Mark a todo done/undone or change its text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, done: { type: 'boolean' }, text: { type: 'string' } },
      required: ['id'],
    },
    async execute({ id, done, text }) {
      const todo = findTodo(id);
      if (typeof done === 'boolean') todo.done = done;
      if (typeof text === 'string' && text.trim()) todo.text = text.trim();
      saveWorkspace();
      return { updated: todo };
    },
  },
  {
    name: 'remove_todos',
    description: 'Remove todos by id. Pass completed_only=true (and no ids) to clear all finished todos.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'number' } }, completed_only: { type: 'boolean' } },
    },
    async execute({ ids = [], completed_only = false }) {
      const before = state.todos.length;
      const idSet = new Set(ids.map(Number));
      state.todos = state.todos.filter((t) => !(idSet.has(t.id) || (completed_only && t.done)));
      saveWorkspace();
      return { removed: before - state.todos.length };
    },
  },
  {
    name: 'write_notes',
    description: "Write to the user's notes pad. mode 'replace' overwrites, 'append' adds to the end.",
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'], default: 'append' } },
      required: ['content'],
    },
    async execute({ content, mode = 'append' }) {
      state.notes = mode === 'replace' || !state.notes ? content : `${state.notes.replace(/\s+$/, '')}\n${content}`;
      saveWorkspace();
      return { notes_length: state.notes.length };
    },
  },
  {
    name: 'set_theme',
    description: "Change the page's look: theme (light/dark/auto) and/or accent color (any CSS color; empty string resets).",
    inputSchema: {
      type: 'object',
      properties: { theme: { type: 'string', enum: ['light', 'dark', 'auto'] }, accent: { type: 'string' } },
    },
    async execute({ theme, accent }) {
      if (theme) state.theme = theme;
      if (typeof accent === 'string') {
        if (accent && !CSS.supports('color', accent)) throw new Error(`Not a valid CSS color: ${accent}`);
        state.accent = accent;
      }
      saveWorkspace();
      return { theme: state.theme, accent: state.accent || null };
    },
  },
].map(defineTool);

const modelContext = document.modelContext;
if (modelContext) {
  Promise.all(tools.map((t) => modelContext.registerTool(t)))
    .then(() => (els.toolCount.textContent = `${tools.length} WebMCP tools`))
    .catch((err) => (els.toolCount.textContent = `WebMCP error: ${err.message}`));
} else {
  els.noWebmcp.hidden = false;
  els.toolCount.textContent = 'WebMCP unavailable';
}

// ---------- Chat UI ----------

function renderMarkdown(el, text) {
  if (window.marked && window.DOMPurify) el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  else el.textContent = text;
}

function renderMessages() {
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 160;
  els.messages.querySelectorAll('.msg').forEach((m) => m.remove());
  els.empty.hidden = state.messages.length > 0;
  for (const m of state.messages) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role}`;
    const bubble = document.createElement('div');
    bubble.className = m.role === 'user' ? 'bubble' : 'text';
    if (m.role === 'user') bubble.textContent = m.text;
    else renderMarkdown(bubble, m.text);
    wrap.append(bubble);
    if (m.role === 'user') {
      const tag = document.createElement('div');
      tag.className = 'meta';
      tag.textContent = m.read ? 'seen by agent' : 'waiting for agent';
      wrap.append(tag);
    }
    els.messages.append(wrap);
  }
  if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

function sendUserMessage(text) {
  lastUserActivity = Date.now();
  state.messages.push({ id: newId(), role: 'user', text, at: Date.now(), read: false });
  save();
  renderMessages();
  els.messages.scrollTop = els.messages.scrollHeight;
  waiters.slice().forEach((wake) => wake());
}

function renderPresence() {
  const recentlySeen = Date.now() - agent.lastSeen < 90_000;
  let text;
  let level;
  if (!modelContext) {
    text = 'no WebMCP host';
    level = 'off';
  } else if (agent.listening > 0) {
    text = 'agent connected · listening';
    level = 'on';
  } else if (recentlySeen) {
    text = 'agent connected';
    level = 'on';
  } else {
    text = 'no agent connected yet';
    level = 'idle';
  }
  els.status.textContent = text;
  els.dot.className = `dot ${level}`;

  const working = agent.status || (recentlySeen && agent.listening === 0 && hasUnansweredMessage() ? 'Working…' : '');
  els.agentStatus.hidden = !working;
  els.agentStatus.textContent = working;
}

function hasUnansweredMessage() {
  const last = state.messages[state.messages.length - 1];
  return last?.role === 'user' && last.read;
}

function logActivity(name, args) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const summary = args && Object.keys(args).length ? JSON.stringify(args) : '';
  li.innerHTML = '<span class="time"></span> <code></code> <span class="args"></span>';
  li.querySelector('.time').textContent = time;
  li.querySelector('code').textContent = name;
  li.querySelector('.args').textContent = summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
  els.activity.prepend(li);
  while (els.activity.children.length > 30) els.activity.lastChild.remove();
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  autoGrow();
  sendUserMessage(text);
});
document.querySelectorAll('.suggestions button').forEach((b) => b.addEventListener('click', () => sendUserMessage(b.dataset.prompt)));
$('clear-chat').addEventListener('click', () => {
  state.messages = [];
  save();
  renderMessages();
});
$('toggle-panel').addEventListener('click', () => els.panel.classList.toggle('open'));

// ---------- Workspace UI ----------

function saveWorkspace(fromAgent = true) {
  save();
  renderWorkspace();
  if (fromAgent) {
    els.panel.classList.remove('flash');
    void els.panel.offsetWidth;
    els.panel.classList.add('flash');
  }
}

function renderWorkspace() {
  els.todos.replaceChildren();
  if (!state.todos.length) {
    const li = document.createElement('li');
    li.className = 'empty-todo';
    li.textContent = 'No todos yet.';
    els.todos.append(li);
  }
  for (const todo of state.todos) {
    const li = document.createElement('li');
    li.className = todo.done ? 'done' : '';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = todo.done;
    box.addEventListener('change', () => {
      todo.done = box.checked;
      saveWorkspace(false);
    });
    const span = document.createElement('span');
    span.textContent = todo.text;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', () => {
      state.todos = state.todos.filter((t) => t !== todo);
      saveWorkspace(false);
    });
    li.append(box, span, del);
    els.todos.append(li);
  }

  if (document.activeElement !== els.notes) els.notes.value = state.notes;

  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = state.theme;
  if (state.accent) root.style.setProperty('--accent', state.accent);
  else root.style.removeProperty('--accent');
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === state.theme));
}

els.todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.todoInput.value.trim();
  if (!text) return;
  state.todos.push({ id: newId(), text, done: false });
  els.todoInput.value = '';
  saveWorkspace(false);
});
els.notes.addEventListener('input', () => {
  state.notes = els.notes.value;
  save();
});
document.querySelectorAll('[data-theme-choice]').forEach((b) =>
  b.addEventListener('click', () => {
    state.theme = b.dataset.themeChoice;
    saveWorkspace(false);
  }),
);

// Re-render Markdown once the CDN scripts finish loading
window.addEventListener('load', renderMessages);

renderWorkspace();
renderMessages();
renderPresence();
setInterval(renderPresence, 2000);
els.input.focus();
