// vision/graph.js
// Graph API with SVG rendering + legacy methods + halo helpers.

///////////////////////
// Internal state
///////////////////////
const state = {
  container: null,
  svg: null,
  gLinks: null,
  gNodes: null,
  data: { nodes: [], links: [] },
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
  if (set) for (const fn of set) { try { fn(payload); } catch {} }
}

///////////////////////
// Utilities
///////////////////////
function ensureContainer(el) {
  if (el) state.container = el;
  if (!state.container && typeof document !== 'undefined') {
    state.container =
      document.getElementById('graph') ||
      document.querySelector('[data-role="graph"]') ||
      document.querySelector('.graph');
  }
  return state.container;
}

function ensureSvg() {
  const c = ensureContainer(state.container);
  if (!c) return null;
  if (!state.svg) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'vision-graph');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const gLinks = document.createElementNS(svg.namespaceURI, 'g');
    gLinks.setAttribute('class', 'links');
    const gNodes = document.createElementNS(svg.namespaceURI, 'g');
    gNodes.setAttribute('class', 'nodes');
    svg.appendChild(gLinks);
    svg.appendChild(gNodes);
    c.innerHTML = '';
    c.appendChild(svg);
    state.svg = svg;
    state.gLinks = gLinks;
    state.gNodes = gNodes;
  }
  return state.svg;
}

function circleLayout(nodes) {
  const rect = state.container.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const r = Math.max(60, Math.min(cx, cy) - 40);
  const n = Math.max(1, nodes.length);
  const centerIdx = 0; // treat first as seed
  const positions = new Map();
  // center
  positions.set(nodes[centerIdx].id, { x: cx, y: cy });
  // ring
  const ring = nodes.slice(1);
  ring.forEach((node, i) => {
    const a = (2 * Math.PI * i) / ring.length;
    positions.set(node.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  return positions;
}

function nodeKey(id) { return String(id).toLowerCase(); }

function findNodeEl(address) {
  if (!address || !state.gNodes) return null;
  const key = nodeKey(address);
  return state.gNodes.querySelector(`g[data-address-i="${key}"]`);
}

///////////////////////
// Public helpers (bands/halo decision)
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
// Rendering
///////////////////////
function render(container, data, opts = {}) {
  ensureContainer(container);
  if (!ensureSvg()) return;

  const { nodes = [], links = [] } = data || {};
  const pos = circleLayout(nodes);

  // Links
  state.gLinks.innerHTML = '';
  for (const l of links) {
    const a = pos.get(l.a), b = pos.get(l.b);
    if (!a || !b) continue;
    const line = document.createElementNS(state.svg.namespaceURI, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', 'edge');
    state.gLinks.appendChild(line);
  }

  // Nodes
  state.gNodes.innerHTML = '';
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const g = document.createElementNS(state.svg.namespaceURI, 'g');
    g.setAttribute('class', 'node');
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    g.setAttribute('data-address', n.address || n.id);
    g.setAttribute('data-address-i', nodeKey(n.address || n.id));
    g.setAttribute('data-id', nodeKey(n.id));

    const outer = document.createElementNS(state.svg.namespaceURI, 'circle');
    outer.setAttribute('r', '14'); outer.setAttribute('class', 'node-outer');
    const inner = document.createElementNS(state.svg.namespaceURI, 'circle');
    inner.setAttribute('r', '4'); inner.setAttribute('class', 'node-inner');

    g.appendChild(outer); g.appendChild(inner);
    g.addEventListener('click', () => emit('selectNode', { id: n.id, address: n.address || n.id }));
    state.gNodes.appendChild(g);
  }

  emit('render', { container: state.container, data, opts });
}

function updateStyles(container, result) {
  // When a result streams in, add halo to the focus node
  if (!result?.id) return;
  setHalo(result);
  emit('restyle', { container: state.container, result });
}

///////////////////////
// Legacy / imperative API expected by app.js
///////////////////////
function setContainer(el) {
  ensureContainer(el);
  ensureSvg();
  return state.container;
}
function setData(data) {
  state.data = data || state.data;
  render(state.container, state.data);
  emit('data', state.data);
}
function getData() { return state.data; }

/**
 * setHalo(target, opts?)
 * - target: result with {id/address, block, risk_score} OR a string address
 * - opts:   { blocked?: boolean }
 */
function setHalo(target, opts = {}) {
  const isObj = target && typeof target === 'object';
  const idOrAddr = isObj ? (target.address || target.id) : target;
  const blocked = isObj
    ? (!!target.block || target.risk_score === 100 || target.sanctionHits)
    : !!opts.blocked;

  const el = findNodeEl(idOrAddr);
  if (!el) return false;
  el.classList.add('halo');
  if (blocked) el.classList.add('halo-red'); else el.classList.remove('halo-red');
  return true;
}
function clearHalos() {
  if (!state.gNodes) return;
  state.gNodes.querySelectorAll('.halo,.halo-red').forEach(n => n.classList.remove('halo','halo-red'));
}

///////////////////////
// Export API
///////////////////////
const api = {
  on, off, setData, getData, setContainer,
  setHalo, clearHalos,
  render, updateStyles,
  nodeClassesFor, bandClass,
};

export default api;
try { if (typeof window !== 'undefined') window.graph = api; } catch {}
