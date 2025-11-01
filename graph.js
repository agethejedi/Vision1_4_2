// vision/graph.js
// Unified Graph API: modern helpers + legacy methods (on/off/setData)
// Also exposes window.graph for existing code in app.js.

///////////////////////
// Internal state
///////////////////////
const state = {
  container: null,
  data: { nodes: [], edges: [] },
  listeners: new Map(), // event -> Set<fn>
};

///////////////////////
// Event bus
///////////////////////
function on(evt, fn) {
  if (!state.listeners.has(evt)) state.listeners.set(evt, new Set());
  state.listeners.get(evt).add(fn);
}
function off(evt, fn) {
  const set = state.listeners.get(evt);
  if (set) set.delete(fn);
}
function emit(evt, payload) {
  const set = state.listeners.get(evt);
  if (set) for (const fn of set) try { fn(payload); } catch {}
}

///////////////////////
// Public helpers you already use
///////////////////////
export function nodeClassesFor(result, nodeAddress) {
  const addr  = String(nodeAddress || '').toLowerCase();
  const focus = String(result?.address || '').toLowerCase();
  const base  = ['node'];

  const blocked = !!(result?.block || result?.risk_score === 100 || result?.sanctionHits);

  if (addr && focus && addr === focus) {
    base.push('halo');
    if (blocked) base.push('halo-red');
  }

  const score = typeof result?.risk_score === 'number'
    ? result.risk_score
    : (typeof result?.score === 'number' ? result.score : 0);

  base.push(bandClass(score, blocked));
  return base.join(' ');
}

export function bandClass(score, blocked) {
  if (blocked || score >= 80) return 'band-high';
  if (score >= 60) return 'band-elevated';
  return 'band-moderate';
}

///////////////////////
// Rendering stubs (safe no-ops you can flesh out later)
///////////////////////
function render(container, data, opts = {}) {
  // If you already draw elsewhere, keep this as a no-op
  // Hook point: emit('render', { container, data, opts });
  emit('render', { container, data, opts });
}

function updateStyles(container, result) {
  // Hook point to restyle halos/bands when results update
  emit('restyle', { container, result });
}

///////////////////////
// Legacy API expected by app.js
///////////////////////
function setContainer(el) {
  state.container = el || state.container || (typeof document !== 'undefined' ? document.getElementById('graph') : null);
  return state.container;
}

function setData(data) {
  // Accept {nodes, edges} or any shape your caller passes; store and render
  state.data = data || state.data;
  const el = setContainer(state.container);
  render(el, state.data);
  emit('data', state.data);
}

function getData() { return state.data; }

///////////////////////
// Export API
///////////////////////
const api = {
  // legacy
  on, off, setData, getData, setContainer,
  // rendering hooks
  render, updateStyles,
  // helpers
  nodeClassesFor, bandClass,
};

export default api;

// Legacy global so existing code `graph.on(...)` / `graph.setData(...)` works
try { if (typeof window !== 'undefined') window.graph = api; } catch {}
