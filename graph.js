// graph.js — Vision graph renderer (safe syntax)
// Radial layout + zoom/pan + fit/reset + select/hover events + halos + label toggle.

(function () {
  const api = {};
  const listeners = {};
  function on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); return api; }
  function emit(evt, payload) { (listeners[evt] || []).forEach(fn => { try { fn(payload); } catch (e) {} }); }
  api.on = on;

  const host = document.getElementById('graph');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'vision-graph');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  host.appendChild(svg);

  const gRoot = document.createElementNS(svgNS, 'g'); svg.appendChild(gRoot);
  const gEdges = document.createElementNS(svgNS, 'g'); gRoot.appendChild(gEdges);
  const gNodes = document.createElementNS(svgNS, 'g'); gRoot.appendChild(gNodes);

  var data = { nodes: [], links: [] };
  var halos = new Map();
  var showLabels = true;

  /* ---------- Zoom / Pan ---------- */
  var scale = 1, tx = 0, ty = 0;
  var dragging = false, lastX = 0, lastY = 0;

  function applyTransform() {
    gRoot.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
  }

  host.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect();
    var cx = (e.clientX - rect.left - tx) / scale;
    var cy = (e.clientY - rect.top - ty) / scale;
    var k = (e.deltaY < 0 ? 1.1 : 0.9);
    scale *= k;
    tx = e.clientX - rect.left - cx * scale;
    ty = e.clientY - rect.top - cy * scale;
    applyTransform();
  }, { passive: false });

  host.addEventListener('mousedown', function (e) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mouseup', function () { dragging = false; });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    tx += (e.clientX - lastX);
    ty += (e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
    applyTransform();
  });

  api.zoomFit = function () {
    var rect = svg.getBoundingClientRect();
    var bbox = gRoot.getBBox ? gRoot.getBBox() : { x: 0, y: 0, width: 1, height: 1 };
    if (!bbox.width || !bbox.height) return;
    var pad = 40;
    var sx = (rect.width - pad) / bbox.width;
    var sy = (rect.height - pad) / bbox.height;
    scale = Math.max(0.1, Math.min(4, Math.min(sx, sy)));
    tx = (rect.width - bbox.width * scale) / 2 - bbox.x * scale;
    ty = (rect.height - bbox.height * scale) / 2 - bbox.y * scale;
    applyTransform();
  };
  api.resetView = function () { scale = 1; tx = 0; ty = 0; applyTransform(); };

  /* ---------- Data / Render ---------- */
  api.setData = function (newData) {
    var nodes = Array.isArray(newData && newData.nodes) ? newData.nodes : [];
    var links = Array.isArray(newData && newData.links) ? newData.links : [];
    data = { nodes: nodes, links: links };
    render();
    emit('dataChanged');
  };
  api.getData = function () { return data; };

  function shortId(id) {
    var s = String(id || '');
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  function render() {
    var rect = svg.getBoundingClientRect();
    var cx = rect.width / 2, cy = rect.height / 2;
    var center = data.nodes[0];
    var N = Math.max(0, data.nodes.length - 1);
    var R = Math.min(rect.width, rect.height) * 0.28;

    var pos = {};
    if (center) pos[center.id] = { x: cx, y: cy };
    for (var i = 1; i < data.nodes.length; i++) {
      var n = data.nodes[i];
      var theta = (i - 1) / Math.max(1, N) * Math.PI * 2;
      var x = cx + R * Math.cos(theta);
      var y = cy + R * Math.sin(theta);
      pos[n.id] = { x: x, y: y };
    }

    // edges
    gEdges.innerHTML = '';
    for (var j = 0; j < data.links.length; j++) {
      var L = data.links[j];
      var pa = pos[L.a], pb = pos[L.b];
      if (!pa || !pb) continue;
      var line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', pa.x); line.setAttribute('y1', pa.y);
      line.setAttribute('x2', pb.x); line.setAttribute('y2', pb.y);
      line.setAttribute('class', 'edge');
      var w = Number(L.weight || 1);
      var sw = Math.max(1, Math.log(w + 1) + 0.5);
      line.setAttribute('stroke-width', String(sw));
      gEdges.appendChild(line);
    }

    // nodes
    gNodes.innerHTML = '';
    for (var k = 0; k < data.nodes.length; k++) {
      var nd = data.nodes[k];
      var p = pos[nd.id] || { x: cx, y: cy };
      var gg = document.createElementNS(svgNS, 'g');
      gg.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
      gg.setAttribute('data-id', String(nd.id));

      var outer = document.createElementNS(svgNS, 'circle');
      outer.setAttribute('r', 11);
      outer.setAttribute('class', 'node-outer');
      gg.appendChild(outer);

      var inner = document.createElementNS(svgNS, 'circle');
      inner.setAttribute('r', 5.5);
      inner.setAttribute('class', 'node-inner');
      gg.appendChild(inner);

      // label (respect global threshold)
      var threshold = window.__SHOW_LABELS_BELOW__ || 150;
      if (showLabels && data.nodes.length <= threshold) {
        var text = document.createElementNS(svgNS, 'text');
        text.setAttribute('y', -16);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('style', 'fill:#8aa3a0; font-size:10px;');
        text.textContent = shortId(nd.id);
        gg.appendChild(text);
      }

      // events
      (function bindEvents(nodeId, px, py) {
        gg.addEventListener('click', function () { emit('selectNode', { id: nodeId }); });
        gg.addEventListener('mouseenter', function () {
          emit('hoverNode', { id: nodeId, __px: px * scale + tx, __py: py * scale + ty });
        });
        gg.addEventListener('mouseleave', function () { emit('hoverNode', null); });
      })(String(nd.id), p.x, p.y);

      gNodes.appendChild(gg);
    }

    // reapply halos
    halos.forEach(function (opts, id) { applyHaloVisual(id, opts); });
  }

  /* ---------- Halos ---------- */
  function findNodeGroup(id) {
    // Avoid CSS.escape; simple scan
    var list = gNodes.querySelectorAll('g[data-id]');
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].getAttribute('data-id')).toLowerCase() === String(id).toLowerCase()) {
        return list[i];
      }
    }
    return null;
  }

  function applyHaloVisual(id, opts) {
    var g = findNodeGroup(id);
    if (!g) return;
    g.classList.add('halo');
    if (opts && opts.blocked) g.classList.add('halo-red'); else g.classList.remove('halo-red');
    var outer = g.querySelector('.node-outer');
    if (outer && opts && opts.color) outer.style.stroke = opts.color;
  }

  api.setHalo = function (info) {
    if (!info || !info.id) return;
    halos.set(info.id, info);
    applyHaloVisual(info.id, info);
  };

  api.flashHalo = function (id) {
    var g = findNodeGroup(id);
    if (!g) return;
    g.classList.add('halo');
    g.classList.add('halo-flash');
    setTimeout(function () { g.classList.remove('halo-flash'); }, 450);
  };

  /* ---------- Center / Fit / Labels ---------- */
  api.centerOn = function (id, opts) {
    opts = opts || {};
    if (!data.nodes.length) return;
    var idx = -1;
    for (var i = 0; i < data.nodes.length; i++) {
      if (String(data.nodes[i].id).toLowerCase() === String(id).toLowerCase()) { idx = i; break; }
    }
    if (idx <= 0) return; // already center or not found
    var node = data.nodes.splice(idx, 1)[0];
    data.nodes.unshift(node);
    if (opts.animate) {
      svg.style.transition = 'opacity .18s ease';
      svg.style.opacity = '0.4';
      requestAnimationFrame(function () {
        render(); api.zoomFit(); svg.style.opacity = '1'; setTimeout(function () { svg.style.transition = ''; }, 200);
      });
    } else { render(); }
    emit('dataChanged');
  };

  api.setLabelVisibility = function (visible) {
    showLabels = !!visible;
    render();
  };

  /* ---------- Export API ---------- */
  window.graph = api;

})();
