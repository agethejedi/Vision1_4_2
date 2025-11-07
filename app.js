// app.js — Vision 1_4_2d (Control Panel + toggles wired)
import './ui/ScoreMeter.js?v=2025-11-02';
import './graph.js?v=2025-11-05';

const SETTINGS = {
  narrative: true,
  labels: true,
  tooltips: true,
  heatmap: false,                 // requires graph.js support; we no-op if absent
  flagCustodian: true,
  flagCluster:   true,
  flagDormant:   true,
  flagMixer:     true,
  flagPlatform:  true,
  labelThreshold: 150,
  neighborCapDefault: 120,
  neighborMoreStep: 120,
  debounceMs: 180,
};

const worker = new Worker('./workers/visionRisk.worker.js', { type: 'module' });
const pending = new Map();
function post(type, payload){
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

/* ---------------- state & utils ---------------- */
function getNetwork(){ return document.getElementById('networkSelect')?.value || 'eth'; }
function norm(x){ return String(x||'').toLowerCase(); }
function clamp(x,a=0,b=1){ return Math.max(a, Math.min(b, x)); }
function fmtAgeDays(d){ if(!(d>0)) return '—'; const m=Math.round(d/30.44); const y=Math.floor(m/12); const mo=m%12; if(y>0&&mo>0) return `${y}y ${mo}m`; if(y>0) return `${y}y`; return `${mo}m`; }
function hasReason(res,kw){ const arr=res.reasons||res.risk_factors||[]; const txt=Array.isArray(arr)?JSON.stringify(arr).toLowerCase():String(arr).toLowerCase(); return txt.includes(kw); }
function coerceOfacFlag(explain,res){ const hit=!!(res.sanctionHits||res.sanctioned||res.ofac||hasReason(res,'ofac')||hasReason(res,'sanction')); explain.ofacHit=hit; return hit; }
function updateBatchStatus(t){ const el=document.getElementById('batchStatus'); if(el) el.textContent=t; }

const scoreCache = new Map();
const neighborStats = new Map();
const k = (a)=> `${getNetwork()}:${norm(a)}`;
const setScore = (r)=> scoreCache.set(k(r.id), r);
const getScore = (a)=> scoreCache.get(k(a));
const setNS = (id,s)=> neighborStats.set(k(id), s);
const getNS = (id)=> neighborStats.get(k(id));

let selectedNodeId = null;
function setSelected(id){ selectedNodeId = norm(id); }

/* ----------- history (Back/Forward) ----------- */
let navStack = []; let navIndex = -1;
function pushHistory(id){ if (navIndex < navStack.length-1) navStack = navStack.slice(0,navIndex+1); if (navStack.at(-1)!==id) navStack.push(id); navIndex = navStack.length-1; updateNavButtons(); }
const canBack = ()=> navIndex>0;
const canFwd  = ()=> navIndex>=0 && navIndex<navStack.length-1;
function navBack(){ if(!canBack()) return; const id=navStack[--navIndex]; focusAddress(id,{push:false}); updateNavButtons(); }
function navForward(){ if(!canFwd()) return; const id=navStack[++navIndex]; focusAddress(id,{push:false}); updateNavButtons(); }
function updateNavButtons(){ const b=document.getElementById('btnBack'); const f=document.getElementById('btnFwd'); if(b) b.disabled=!canBack(); if(f) f.disabled=!canFwd(); }

/* ----------- worker plumbing ----------- */
worker.onmessage = (e) => {
  const { id, type, data, error } = e.data || {};
  const req = pending.get(id);
  const looksGraph = data && typeof data === 'object' && Array.isArray(data.nodes) && Array.isArray(data.links);

  if (type === 'INIT_OK'){ if (req){ req.resolve(true); pending.delete(id);} return; }

  if (type === 'RESULT_STREAM'){ const r = normalizeResult(data); afterScore(r,{debounced:true}); return; }

  if (type === 'RESULT'){
    if (looksGraph){
      setGraphData(data); toggleLabelsByCount();
      if (req){ req.resolve(data); pending.delete(id); }
      return;
    }
    const r = normalizeResult(data||{});
    afterScore(r,{debounced:true});
    if (req){ req.resolve(r); pending.delete(id); }
    return;
  }

  if (type === 'NEIGHBOR_STATS'){
    if (data?.id){ setNS(data.id, data); if (selectedNodeId === data.id){ const cached=getScore(data.id); if (cached) afterScore(normalizeResult(cached), { force:true }); } }
    setGraphStatus(formatNSLine(data));
    return;
  }

  if (type === 'DONE'){ setGraphStatus('Neighbors scored.'); if (req){ req.resolve(true); pending.delete(id);} return; }

  if (type === 'ERROR'){ console.error('[app] worker ERROR', error); setGraphStatus(String(error||'Error')); if (req){ req.reject(new Error(error)); pending.delete(id);} return; }
};

/* ----------- normalize + render ----------- */
function normalizeResult(res={}){
  const id = norm(res.id || res.address);
  const serverScore = (typeof res.risk_score==='number') ? res.risk_score : null;
  const score = (serverScore!=null) ? serverScore : (typeof res.score==='number' ? res.score : 0);
  const blocked = !!(res.block || serverScore===100 || res.sanctionHits);
  const explain = res.explain && typeof res.explain==='object' ? { ...res.explain } : { reasons: res.reasons || res.risk_factors || [] };
  coerceOfacFlag(explain, res);
  if (typeof explain.walletAgeRisk!=='number'){ const d=Number(res.feats?.ageDays ?? NaN); if(!Number.isNaN(d)&&d>=0) explain.walletAgeRisk = clamp(1 - Math.min(1, d/(365*2))); }
  const ns = getNS(id);
  if (ns){
    explain.neighborsDormant   = { inactiveRatio: ns.inactiveRatio, n: ns.n, avgInactiveAge: ns.avgInactiveAge ?? null };
    if (ns.avgTx!=null)  explain.neighborsAvgTxCount = { avgTx: ns.avgTx, n: ns.n };
    if (ns.avgDays!=null) explain.neighborsAvgAge     = { avgDays: ns.avgDays, n: ns.n };
    explain.sparseNeighborhood = !!ns.sparseNeighborhood;
  }
  return { ...res, id, address:id, score, explain, block:blocked, blocked };
}

let renderTimer=null;
function afterScore(r,{debounced=false,force=false}={}){
  setScore(r);
  if (r.id !== selectedNodeId) return;
  const doRender=()=>{ updateScorePanel(r); applyVisualCohesion(r); renderNarrative(r); };
  if (force) return doRender();
  if (debounced){ clearTimeout(renderTimer); renderTimer=setTimeout(doRender, SETTINGS.debounceMs); return; }
  doRender();
}

/* ----------- init / UI ----------- */
async function init(){
  await post('INIT',{ apiBase:(window.VisionConfig&&window.VisionConfig.API_BASE)||"", network:getNetwork(), concurrency:8, flags:{ graphSignals:true, streamBatch:true, neighborStats:true } });
  bindUI(); buildGraphControls(); bindControlPanel(); seedDemo();
}
init();

function bindUI(){
  document.getElementById('refreshBtn')?.addEventListener('click', scoreVisible);
  document.getElementById('clearBtn')?.addEventListener('click', ()=>{ window.graph?.setData({nodes:[],links:[]}); setSelected(null); hideNarrative(); updateBatchStatus('Idle'); setGraphStatus('Idle'); navStack=[]; navIndex=-1; updateNavButtons(); });
  document.getElementById('networkSelect')?.addEventListener('change', async ()=>{ await post('INIT',{ network:getNetwork() }); scoreCache.clear(); neighborStats.clear(); scoreVisible(); });
  document.getElementById('loadSeedBtn')?.addEventListener('click', ()=>{ const seed=norm(document.getElementById('seedInput').value.trim()); if(seed) focusAddress(seed); });

  const g=window.graph;
  if (g?.on){
    g.on('selectNode',(n)=>{ if(!n) return; focusAddress(norm(n.id)); });
    g.on('hoverNode',(n)=>{ if(!SETTINGS.tooltips){ hideTooltip(); return; } if(!n){ hideTooltip(); return; } showTooltip(n); });
    g.on('dataChanged', toggleLabelsByCount);
  }

  const modeSel = document.getElementById('rxlMode');
  if (modeSel) modeSel.addEventListener('change', ()=>{ const s=getScore(selectedNodeId); if (s) renderNarrative(normalizeResult(s)); });
  document.getElementById('rxlCopy')?.addEventListener('click', async ()=>{
    const txt = document.getElementById('rxlNarrativeText')?.textContent || '';
    try { await navigator.clipboard.writeText(txt); } catch {}
  });
}

/* ----------- Control Panel bindings ----------- */
function bindControlPanel(){
  // checkboxes
  const c = (id)=> document.getElementById(id);

  const apply = ()=>{
    SETTINGS.narrative  = !!c('ctlNarrative')?.checked;
    SETTINGS.labels     = !!c('ctlLabels')?.checked;
    SETTINGS.tooltips   = !!c('ctlTooltips')?.checked;
    SETTINGS.heatmap    = !!c('ctlHeatmap')?.checked;

    SETTINGS.flagCustodian = !!c('ctlFlagCustodian')?.checked;
    SETTINGS.flagCluster   = !!c('ctlFlagCluster')?.checked;
    SETTINGS.flagDormant   = !!c('ctlFlagDormant')?.checked;
    SETTINGS.flagMixer     = !!c('ctlFlagMixer')?.checked;
    SETTINGS.flagPlatform  = !!c('ctlFlagPlatform')?.checked;

    const lt = Number(c('ctlLabelThresh')?.value || SETTINGS.labelThreshold);
    const cap= Number(c('ctlNeighborCap')?.value || SETTINGS.neighborCapDefault);
    SETTINGS.labelThreshold = Math.max(20, Math.min(1000, lt));
    SETTINGS.neighborCapDefault = Math.max(40, Math.min(1000, cap));

    // apply visuals
    window.graph?.setLabelVisibility(SETTINGS.labels && currentNodeCount() <= SETTINGS.labelThreshold);
    if (typeof window.graph?.setHeatmapMode === 'function') {
      window.graph.setHeatmapMode(SETTINGS.heatmap);
    }

    // narrative panel show/hide
    const panel=document.getElementById('narrativePanel');
    if (panel) panel.style.display = SETTINGS.narrative ? '' : 'none';

    // refresh current selection UI
    const r = getScore(selectedNodeId);
    if (r) afterScore(normalizeResult(r), { force:true });

    // optionally re-fetch neighbors with new cap
    if (selectedNodeId) refreshGraphFromLive(selectedNodeId, { cap: SETTINGS.neighborCapDefault });
  };

  c('ctlApply')?.addEventListener('click', apply);

  // seed with default values
  if (c('ctlNarrative'))   c('ctlNarrative').checked   = SETTINGS.narrative;
  if (c('ctlLabels'))      c('ctlLabels').checked      = SETTINGS.labels;
  if (c('ctlTooltips'))    c('ctlTooltips').checked    = SETTINGS.tooltips;
  if (c('ctlHeatmap'))     c('ctlHeatmap').checked     = SETTINGS.heatmap;

  if (c('ctlFlagCustodian')) c('ctlFlagCustodian').checked = SETTINGS.flagCustodian;
  if (c('ctlFlagCluster'))   c('ctlFlagCluster').checked   = SETTINGS.flagCluster;
  if (c('ctlFlagDormant'))   c('ctlFlagDormant').checked   = SETTINGS.flagDormant;
  if (c('ctlFlagMixer'))     c('ctlFlagMixer').checked     = SETTINGS.flagMixer;
  if (c('ctlFlagPlatform'))  c('ctlFlagPlatform').checked  = SETTINGS.flagPlatform;

  if (c('ctlLabelThresh')) c('ctlLabelThresh').value = String(SETTINGS.labelThreshold);
  if (c('ctlNeighborCap')) c('ctlNeighborCap').value = String(SETTINGS.neighborCapDefault);
}

/* ----------- toolbar + status ----------- */
let neighborCap=SETTINGS.neighborCapDefault; let neighborOverflow=0;
function buildGraphControls(){
  const host=document.getElementById('graph'); if(!host) return;
  const box=document.createElement('div');
  box.className='graph-controls';
  box.innerHTML=`
    <div style="display:flex;gap:6px">
      <button id="btnBack" class="btn btn-ghost" title="Back">⟵</button>
      <button id="btnFwd"  class="btn btn-ghost" title="Forward">⟶</button>
    </div>
    <span style="flex:1"></span>
    <button id="btnReset" class="btn btn-ghost">Reset</button>
    <button id="btnFit" class="btn">Zoom Fit</button>`;
  host.appendChild(box);

  box.querySelector('#btnReset').addEventListener('click', ()=>window.graph?.resetView());
  box.querySelector('#btnFit').addEventListener('click', ()=>window.graph?.zoomFit());
  box.querySelector('#btnBack').addEventListener('click', navBack);
  box.querySelector('#btnFwd').addEventListener('click', navForward);
  updateNavButtons();

  const status=document.createElement('div');
  status.id='graphStatus';
  status.style.cssText='position:absolute;left:12px;bottom:10px;right:12px;font-size:12px;color:#8aa3a0;display:flex;gap:8px;align-items:center;pointer-events:none;';
  status.innerHTML=`<span id="graphSpin" style="display:none">⏳</span><span id="graphStatusText">Idle</span><span style="flex:1"></span><button id="btnMore" class="btn btn-ghost" style="pointer-events:auto;display:none">Load more</button>`;
  host.appendChild(status);
  document.getElementById('btnMore')?.addEventListener('click', ()=>{ neighborCap += SETTINGS.neighborMoreStep; if (selectedNodeId) refreshGraphFromLive(selectedNodeId, { cap: neighborCap }); });

  const st=document.createElement('style');
  st.textContent=`#graph{position:relative}.graph-controls{position:absolute;top:8px;right:8px;left:8px;display:flex;gap:6px;align-items:center;z-index:3}`;
  document.head.appendChild(st);
}
function setGraphStatus(txt,{loading=false,overflow=0}={}){
  const spin=document.getElementById('graphSpin'); const t=document.getElementById('graphStatusText'); const more=document.getElementById('btnMore');
  if (spin) spin.style.display = loading ? 'inline' : 'none';
  if (t) t.textContent = txt || '';
  if (more) more.style.display = overflow>0 ? 'inline-block' : 'none';
}
function formatNSLine(s){
  if (!s) return 'Neighbors: (waiting on stats…)';
  const pct = typeof s.inactiveRatio==='number' ? `, inactive ${(s.inactiveRatio*100).toFixed(1)}%` : '';
  const extra = s.overflow>0 ? ` (+${s.overflow} more)` : '';
  neighborOverflow = s.overflow||0;
  return `Neighbors: ${s.n ?? 0}${extra}${pct}${s.sparseNeighborhood?' — Limited neighbor data—metrics may be conservative.':''}`;
}

/* ----------- navigation focus ----------- */
async function focusAddress(addr,{push=true}={}){
  const id=norm(addr); setSelected(id);
  if (push) pushHistory(id);

  window.graph?.flashHalo(id);
  const cached=getScore(id);
  if (cached) afterScore(normalizeResult(cached));
  else post('SCORE_ONE',{ item:{ type:'address', id, network:getNetwork() } })
        .then(r=>afterScore(normalizeResult(r),{debounced:true})).catch(()=>{});

  setGraphStatus('Loading neighbors…', { loading:true, overflow:0 });
  neighborCap = SETTINGS.neighborCapDefault;
  await refreshGraphFromLive(id, { cap: neighborCap });
  window.graph?.centerOn(id, { animate:true }); window.graph?.zoomFit();
}

/* ----------- tooltip ----------- */
function showTooltip(n){
  const addr=norm(n.id), cached=getScore(addr), ns=getNS(addr);
  const ofac=!!cached?.explain?.ofacHit; const ageDays=cached?.feats?.ageDays ?? null; const niceAge=ageDays?fmtAgeDays(ageDays):'—';
  const neighCount = ns?.n ?? ((window.graph?.getData()?.nodes?.length||1)-1);
  const tip=document.getElementById('rxlTooltip'); if(!tip) return;
  tip.innerHTML = `<div style="opacity:.8;">${addr.slice(0,10)}…${addr.slice(-6)}</div><div>Age: <b>${niceAge}</b></div><div>Neighbors: <b>${neighCount}</b></div><div>Badges: ${ofac?'<span class="badge badge-risk">OFAC</span>':'<span class="badge badge-safe">No OFAC</span>'}</div>`;
  tip.style.display='block'; tip.style.left=(n.__px+12)+'px'; tip.style.top=(n.__py+12)+'px';
}
function hideTooltip(){ const tip=document.getElementById('rxlTooltip'); if (tip) tip.style.display='none'; }

/* ----------- neighbors ----------- */
async function getNeighborsLive(centerId,{cap}){
  try {
    const res = await post('NEIGHBORS', { id:centerId, network:getNetwork(), hop:1, limit:cap, cap });
    if (res && Array.isArray(res.nodes) && Array.isArray(res.links)) return res;
  } catch {}
  return { nodes:[], links:[] };
}
async function refreshGraphFromLive(centerId,{cap}){
  const { nodes, links } = await getNeighborsLive(centerId,{cap});
  if (!nodes.length && !links.length) { setGraphStatus('No neighbors found.'); return; }
  setGraphData({ nodes, links });
  toggleLabelsByCount();
  setGraphStatus(`Neighbors loaded: ${(nodes.length||0)-1}${neighborOverflow>0?` (+${neighborOverflow} more)`:''}`);
}

/* ----------- scoring visible ----------- */
function scoreVisible(){
  const data = window.graph?.getData ? window.graph.getData() : { nodes:[], links:[] };
  const vs = (data.nodes||[]).map(n=>({ type:'address', id:norm(n.id), network:getNetwork() }));
  if (!vs.length) return updateBatchStatus('No nodes in view');
  updateBatchStatus(`Batch: ${vs.length} nodes`);
  const items = vs.filter(v => !getScore(v.id));
  if (items.length) post('SCORE_BATCH',{ items }).catch(()=>{});
}

/* ----------- graph helpers ----------- */
function currentNodeCount(){ return (window.graph?.getData()?.nodes || []).length; }
function setGraphData({nodes,links}){
  window.__VISION_NODES__=nodes||[]; window.__VISION_LINKS__=links||[];
  window.__SHOW_LABELS_BELOW__=SETTINGS.labelThreshold;
  window.graph?.setData({ nodes:window.__VISION_NODES__, links:window.__VISION_LINKS__ });
  window.graph?.setLabelVisibility(SETTINGS.labels && currentNodeCount() <= SETTINGS.labelThreshold);
  if (typeof window.graph?.setHeatmapMode === 'function') window.graph.setHeatmapMode(SETTINGS.heatmap);
}
function toggleLabelsByCount(){
  const show = SETTINGS.labels && currentNodeCount() <= SETTINGS.labelThreshold;
  window.graph?.setLabelVisibility(show);
}

/* ----------- seed ----------- */
function seedDemo(){ const seed='0xdemoseed00000000000000000000000000000001'; setGraphData({ nodes:[{ id:seed, address:seed, network:getNetwork() }], links:[] }); setSelected(seed); }

/* ----------- meter / visuals / narrative ----------- */
const FACTOR_WEIGHTS = { 'OFAC':40,'OFAC/sanctions list match':40,'sanctioned Counterparty':40,'fan In High':9,'shortest Path To Sanctioned':6,'burst Anomaly':0,'known Mixer Proximity':0 };
const scorePanel = (window.ScoreMeter && window.ScoreMeter('#scorePanel')) || { setSummary(){}, setScore(){}, setBlocked(){}, setReasons(){}, getScore(){ return 0; } };

function computeBreakdownFrom(res){
  if(Array.isArray(res.breakdown)&&res.breakdown.length) return res.breakdown;
  const src=res.reasons||res.risk_factors||[]; if(!Array.isArray(src)||!src.length) return [];
  const list=src.map(l=>({label:String(l),delta:FACTOR_WEIGHTS[l]??0}));
  const has=list.some(x=>/sanction|ofac/i.test(x.label));
  if((res.block||res.blocked||res.risk_score===100)&&!has) list.unshift({label:'sanctioned Counterparty',delta:40});
  return list.sort((a,b)=>(b.delta||0)-(a.delta||0));
}

function isBlockedVisual(res){ return !!(res.block||res.blocked||res.risk_score===100||res.sanctionHits||res.explain?.ofacHit||res.ofac===true); }
function colorForScore(s,b){ if(b) return '#ef4444'; if(s>=80) return '#ff3b3b'; if(s>=60) return '#ffb020'; if(s>=40) return '#ffc857'; if(s>=20) return '#22d37b'; return '#00eec3'; }

function updateScorePanel(res){
  res.parity = (typeof res.parity==='string' || res.parity===true) ? res.parity : 'SafeSend parity';
  const ageDays = Number(res.feats?.ageDays ?? 0);
  const ageDisplay = (ageDays>0) ? fmtAgeDays(ageDays) : '—';
  res.breakdown = computeBreakdownFrom(res);
  res.blocked = isBlockedVisual(res);

  const ns = getNS(res.id) || {};
  const nStr = ns.n != null ? `${ns.n}` : '—';
  const avgAge = ns.avgDays != null ? fmtAgeDays(ns.avgDays) : '—';
  const inact = ns.inactiveRatio != null ? `${Math.round(ns.inactiveRatio*100)}%` : '—';
  const sparse = ns.sparseNeighborhood ? ' (limited data)' : '';

  scorePanel.setSummary(res);

  const mixerPct = Math.round((res.feats?.mixerTaint ?? 0)*100) + '%';
  const neighPct = Math.round(((res.explain?.neighborsDormant?.inactiveRatio ?? res.feats?.local?.riskyNeighborRatio) || 0)*100) + '%';

  const meta=document.getElementById('entityMeta');
  if (meta) meta.innerHTML = `
    <div>Address: <b>${res.id}</b></div>
    <div>Network: <b>${res.network}</b></div>
    <div>Age: <b>${ageDisplay}</b></div>
    <div>Mixer taint: <b>${mixerPct}</b></div>
    <div>Neighbors flagged: <b>${neighPct}</b></div>
    <div class="muted">Neighbors: <b>${nStr}</b> • Avg age <b>${avgAge}</b> • Inactive <b>${inact}</b>${sparse}</div>
  `;
}

function applyVisualCohesion(res){
  // Respect flag toggles (visual emphasis only; scoring unchanged)
  const blocked=isBlockedVisual(res);
  const color=colorForScore(res.score||0, blocked);
  window.graph?.setHalo({ id:res.id, blocked, color, pulse: blocked?'red':'auto', intensity: Math.max(0.25,(res.score||0)/100), tooltip: res.label });

  // Optional: if your graph supports category styling, pass flags + toggles
  if (typeof window.graph?.setNodeFlags === 'function'){
    const flags = (res.flags || {});
    window.graph.setNodeFlags(res.id, {
      custodian: SETTINGS.flagCustodian && !!flags.custodian,
      cluster:   SETTINGS.flagCluster   && !!flags.clusterRisk,
      dormant:   SETTINGS.flagDormant   && !!flags.dormant,
      mixer:     SETTINGS.flagMixer     && !!flags.mixerLink,
      platform:  SETTINGS.flagPlatform  && !!flags.platformEntity,
    });
  }

  const panel=document.getElementById('scorePanel'); if (panel) panel.style.setProperty('--ring-color', color);
}

/* ---------- Narrative (respects toggles) ---------- */
function renderNarrative(res){
  const panel=document.getElementById('narrativePanel'); if(!panel) return;
  panel.style.display = SETTINGS.narrative ? '' : 'none';
  if (!SETTINGS.narrative) return;

  const ns=getNS(res.id)||{};
  const ofac=!!res.explain?.ofacHit;

  const parts=[];
  if (typeof res.feats?.ageDays==='number'){
    const k=res.explain?.walletAgeRisk ?? 0;
    parts.push(k>=0.6?`newly created (${fmtAgeDays(res.feats.ageDays)})`:`long-standing (${fmtAgeDays(res.feats.ageDays)})`);
  }
  if (typeof ns.inactiveRatio==='number' && ns.inactiveRatio>=0.6 && SETTINGS.flagDormant) parts.push('connected to a dormant cluster');
  if (typeof ns.avgTx==='number' && ns.avgTx>=200 && SETTINGS.flagCluster) parts.push('high-volume counterparty cluster');
  if (ns.sparseNeighborhood) parts.push('limited neighbor data—metrics may be conservative');

  const mode = document.getElementById('rxlMode')?.value || 'analyst';
  let text = parts.length ? `This wallet is ${parts.join(', ')}${ofac ? '.' : '. No direct OFAC link was found.'}` : (ofac ? 'OFAC match detected.' : 'No direct OFAC link was found.');
  if (mode==='consumer') text = text.replace('This wallet is','Unusual pattern: this wallet').replace(' No direct OFAC link was found.','');

  const textEl=document.getElementById('rxlNarrativeText'); if(textEl) textEl.textContent = text;

  // badges
  const badgesEl=document.getElementById('rxlBadges');
  if (badgesEl){
    badgesEl.innerHTML='';
    const mk=(l,c='')=>{ const s=document.createElement('span'); s.className=`badge ${c}`; s.textContent=l; return s; };
    badgesEl.appendChild(mk(ofac?'OFAC':'No OFAC', ofac?'badge-risk':'badge-safe'));
    if (SETTINGS.flagDormant && typeof ns.inactiveRatio==='number' && ns.inactiveRatio>=0.6) badgesEl.appendChild(mk('Dormant Cluster','badge-warn'));
    if (SETTINGS.flagCluster && typeof ns.avgTx==='number' && ns.avgTx>=200) badgesEl.appendChild(mk('High Counterparty Volume','badge-warn'));

    // platform/custodian/mixer badges if present and enabled
    const flags = (getScore(res.id)?.flags) || {};
    if (SETTINGS.flagPlatform && flags.platformEntity) badgesEl.appendChild(mk(flags.platformName || 'Platform Entity','badge-warn'));
    if (SETTINGS.flagCustodian && flags.custodian) badgesEl.appendChild(mk(flags.custodianName || 'Custodian',''));
    if (SETTINGS.flagMixer && flags.mixerLink) badgesEl.appendChild(mk('Mixer Proximity','badge-warn'));
  }

  // factors table
  const tbody=document.querySelector('#rxlFactors tbody');
  if (tbody){
    tbody.innerHTML='';

    const nStr = ns.n != null ? `${ns.n}` : '—';
    const avgAge = ns.avgDays != null ? fmtAgeDays(ns.avgDays) : '—';
    const inact = ns.inactiveRatio != null ? `${Math.round(ns.inactiveRatio*100)}%` : '—';
    const tr0=document.createElement('tr');
    tr0.innerHTML = `<td>Neighbors</td><td>N ${nStr} • Avg age ${avgAge} • Inactive ${inact}</td><td style="text-align:right;">—</td><td><code>neighborStats</code></td>`;
    tbody.appendChild(tr0);

    if (typeof ns.avgTx==='number'){
      const tr1=document.createElement('tr');
      tr1.innerHTML = `<td>Neighbors avg tx</td><td>avgTx ${Math.round(ns.avgTx)}</td><td style="text-align:right;">—</td><td><code>neighborStats</code></td>`;
      tbody.appendChild(tr1);
    }

    const breakdown = computeBreakdownFrom(res);
    (breakdown||[]).forEach(row=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${row.label}</td><td>—</td><td style="text-align:right;">${row.delta!=null?('+'+row.delta):'—'}</td><td><code>breakdown</code></td>`;
      tbody.appendChild(tr);
    });
  }
}

function hideNarrative(){ const p=document.getElementById('narrativePanel'); if (p) p.style.display='none'; }

/* ------------------- end ------------------- */
