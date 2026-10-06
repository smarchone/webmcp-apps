// Injected into every page (main world, before page scripts) by the bridge.
// Records tools registered through document.modelContext so an external agent can
// list and call them. If the browser has native WebMCP, registrations pass through
// to it; otherwise this provides a minimal ModelContext.
// Spec: https://webmachinelearning.github.io/webmcp/
(() => {
  if (window.__webmcpBridge) return;

  const tools = new Map(); // name -> ModelContextTool
  const native = document.modelContext;
  const nativeRegister = native?.registerTool;

  function forget(name, tool) {
    if (tools.get(name) === tool) tools.delete(name);
  }

  async function registerTool(tool, options = {}) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
      throw new TypeError('registerTool expects { name, description, inputSchema, execute }');
    }
    if (tools.has(tool.name)) throw new DOMException(`Tool "${tool.name}" is already registered`, 'InvalidStateError');
    if (options.signal?.aborted) return;
    tools.set(tool.name, tool);
    // Unregistering = aborting the signal passed at registration
    options.signal?.addEventListener('abort', () => forget(tool.name, tool), { once: true });
    if (nativeRegister) {
      try {
        await nativeRegister.call(native, tool, options);
      } catch (err) {
        console.debug('[webmcp-bridge] native registerTool failed', err);
      }
    }
  }

  const describe = (t) => ({
    name: t.name,
    title: t.title,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    annotations: t.annotations,
  });

  if (native) {
    try {
      Object.defineProperty(native, 'registerTool', { value: registerTool, configurable: true, writable: true });
    } catch {}
  } else {
    const shim = new EventTarget();
    shim.registerTool = registerTool;
    shim.getTools = async () => [...tools.values()].map((t) => ({ ...describe(t), window, origin: location.origin }));
    shim.executeTool = async (registered, input = {}, { signal } = {}) =>
      JSON.stringify(await tools.get(registered?.name ?? registered).execute(input, { signal }));
    Object.defineProperty(document, 'modelContext', { value: shim, configurable: true });
  }
  // Older pages use the deprecated navigator.modelContext spelling
  if (!('modelContext' in navigator)) {
    Object.defineProperty(navigator, 'modelContext', { value: document.modelContext, configurable: true });
  }

  const toResult = (out) => {
    if (out && Array.isArray(out.content)) return { content: out.content, isError: Boolean(out.isError) };
    const text = typeof out === 'string' ? out : JSON.stringify(out ?? null, null, 2);
    return { content: [{ type: 'text', text }], isError: false };
  };

  Object.defineProperty(window, '__webmcpBridge', {
    enumerable: false,
    value: {
      native: Boolean(native),
      list: () => [...tools.values()].map(describe),
      async call(name, args) {
        const tool = tools.get(name);
        if (!tool) {
          return { content: [{ type: 'text', text: `Unknown tool "${name}" on this page.` }], isError: true };
        }
        try {
          return toResult(await tool.execute(args || {}, { signal: new AbortController().signal }));
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true };
        }
      },
    },
  });
})();
