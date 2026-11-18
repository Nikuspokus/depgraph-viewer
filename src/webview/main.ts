// Code exécuté dans le webview (navigateur), pas dans Node.
import ForceGraph from 'force-graph';
import ForceGraph3D from '3d-force-graph';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

interface GNode { id: string; label: string; dir: string; kind: string; [k: string]: any }
interface GLink { source: string; target: string }
interface Incident { file: string; title: string; severity?: string }
interface GraphData {
  nodes: GNode[]; links: GLink[]; cycles: string[][]; incidents: Incident[];
  stats: { files: number; links: number; unresolved: number };
}
type Mode = 'tree' | '2d' | '3d';

const KIND_COLOR: Record<string, string> = {
  module: '#4fc1ff', controller: '#c586c0', service: '#4ec9b0',
  vue: '#42b883', svelte: '#ff6a3d', other: '#9aa0a6',
};
const COL_SELECTED = '#ffffff';
const COL_IMPACT = '#ffa733';
const COL_INCIDENT = '#f14c4c';
const COL_CYCLE = '#ff4fd8';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// La librairie vide son conteneur à l'initialisation : il ne doit contenir que le graphe
const container = $('canvas');
const side = $('side');

let data: GraphData | null = null;
let mode: Mode = 'tree';
let graph: any = null;
let selected: string | null = null;

// Index calculés à chaque nouveau graphe
let dependents = new Map<string, string[]>(); // qui m'importe (ce qui casse si je tombe)
let dependencies = new Map<string, string[]>(); // ce que j'importe
let inDegree = new Map<string, number>();
let cyclic = new Set<string>();
let incidentByFile = new Map<string, Incident[]>();
let impacted = new Set<string>(); // fichiers impactés par le nœud "focus" (survolé ou sélectionné)
let matches = new Set<string>();
let hovered: string | null = null; // nœud sous la souris (aperçu temporaire)
let focus: string | null = null; // sélection si elle existe, sinon nœud survolé

interface Filters { kinds: Set<string>; path: string; maxShared: number; hideIsolated: boolean }
const ALL_KINDS = ['module', 'controller', 'service', 'vue', 'svelte', 'other'];
const filters: Filters = { kinds: new Set(ALL_KINDS), path: '', maxShared: 0, hideIsolated: false };

function buildIndexes(g: GraphData): void {
  dependents = new Map(); dependencies = new Map(); inDegree = new Map();
  for (const n of g.nodes) { dependents.set(n.id, []); dependencies.set(n.id, []); inDegree.set(n.id, 0); }
  for (const l of g.links) {
    dependents.get(l.target)?.push(l.source);
    dependencies.get(l.source)?.push(l.target);
    inDegree.set(l.target, (inDegree.get(l.target) ?? 0) + 1);
  }
  cyclic = new Set(g.cycles.flat());
  incidentByFile = new Map();
  for (const i of g.incidents) {
    const arr = incidentByFile.get(i.file) ?? [];
    arr.push(i);
    incidentByFile.set(i.file, arr);
  }
}

/** Parcours en largeur sur les "dépendants" : tout ce qui importe (même indirectement) le fichier. */
function computeImpact(id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of dependents.get(cur) ?? []) {
      if (!seen.has(d) && d !== id) { seen.add(d); queue.push(d); }
    }
  }
  return seen;
}

const idOf = (end: any): string => (typeof end === 'object' ? end.id : end);
const isDim = (id: string): boolean => !!focus && id !== focus && !impacted.has(id);

function nodeColor(n: GNode): string {
  if (n.id === focus) return COL_SELECTED;
  if (focus && impacted.has(n.id)) return COL_IMPACT;
  if (incidentByFile.has(n.id)) return COL_INCIDENT;
  if (cyclic.has(n.id)) return COL_CYCLE;
  const base = KIND_COLOR[n.kind] ?? KIND_COLOR.other;
  return focus ? base + '55' : base; // on estompe le reste pendant une simulation
}

function linkColor(l: any): string {
  const s = idOf(l.source), t = idOf(l.target);
  if (focus && (s === focus || t === focus || (impacted.has(s) && (impacted.has(t) || t === focus)))) {
    return COL_IMPACT;
  }
  if (cyclic.has(s) && cyclic.has(t) && data?.cycles.some((c) => c.includes(s) && c.includes(t))) return COL_CYCLE;
  return focus ? 'rgba(150,150,150,0.12)' : 'rgba(150,150,150,0.45)';
}

const particles = (l: any): number => (focus && linkColor(l) === COL_IMPACT ? 2 : 0);

function refreshStyles(): void {
  // Réassigner de NOUVELLES fonctions d'accès force le moteur à recalculer les styles
  // (une même référence de fonction n'est pas vue comme un changement).
  if (!graph) return;
  if (mode === '3d') graph.nodeColor((n: GNode) => nodeColor(n));
  else graph.nodeCanvasObject((n: any, c: CanvasRenderingContext2D, s: number) => drawNode(n, c, s));
  graph.linkColor((l: any) => linkColor(l));
  graph.linkDirectionalParticles((l: any) => particles(l));
}

// ---------- dessin 2D / organigramme ----------
const BOX_H = 18;
const BOX_FONT = 11;
const MAX_LABEL_W = 170;

const radius2D = (n: GNode): number => 2.5 + Math.sqrt(1 + Math.min(14, inDegree.get(n.id) ?? 0)) * 1.6;
const nodeSize3D = (n: GNode): number => 1 + Math.min(14, inDegree.get(n.id) ?? 0);

/** Texte (tronqué si besoin) et largeur de la boîte d'un nœud en mode organigramme. */
function boxLabel(ctx: CanvasRenderingContext2D, label: string): { text: string; w: number } {
  ctx.font = `${BOX_FONT}px sans-serif`;
  let text = label;
  let w = ctx.measureText(text).width;
  if (w > MAX_LABEL_W) {
    text = label.slice(0, Math.max(3, Math.floor((label.length * MAX_LABEL_W) / w) - 1)) + '…';
    w = ctx.measureText(text).width;
  }
  return { text, w: w + 14 };
}

function pathRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, w, h, 4);
  else ctx.rect(x, y, w, h);
}

function drawBox(node: any, ctx: CanvasRenderingContext2D): void {
  const { text, w } = boxLabel(ctx, node.label);
  const x = node.x - w / 2, y = node.y - BOX_H / 2;
  pathRect(ctx, x, y, w, BOX_H);
  ctx.fillStyle = nodeColor(node);
  ctx.fill();
  if (incidentByFile.has(node.id) || matches.has(node.id)) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = incidentByFile.has(node.id) ? COL_INCIDENT : '#ffe066';
    pathRect(ctx, x - 1.5, y - 1.5, w + 3, BOX_H + 3);
    ctx.stroke();
  }
  ctx.font = `${BOX_FONT}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isDim(node.id) ? (getComputedStyle(document.body).color || '#ddd') : '#101010';
  ctx.fillText(text, node.x, node.y + 0.5);
}

function drawNode(node: any, ctx: CanvasRenderingContext2D, scale: number): void {
  if (mode === 'tree') { drawBox(node, ctx); return; }
  const r = radius2D(node);
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = nodeColor(node);
  ctx.fill();
  if (incidentByFile.has(node.id)) {
    ctx.lineWidth = 1.4; ctx.strokeStyle = COL_INCIDENT;
    ctx.beginPath(); ctx.arc(node.x, node.y, r + 2.5, 0, 2 * Math.PI); ctx.stroke();
  }
  const showLabel = scale > 2.2 || node.id === focus || (focus && impacted.has(node.id)) || matches.has(node.id);
  if (showLabel) {
    const fs = Math.max(3, 11 / scale);
    ctx.font = `${fs}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = getComputedStyle(document.body).color || '#ddd';
    ctx.fillText(node.label, node.x, node.y + r + 1.5);
  }
}

function pointerArea(node: any, color: string, ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = color;
  if (mode === 'tree') {
    const { w } = boxLabel(ctx, node.label);
    ctx.fillRect(node.x - w / 2, node.y - BOX_H / 2, w, BOX_H);
  } else {
    ctx.beginPath(); ctx.arc(node.x, node.y, radius2D(node) + 2, 0, 2 * Math.PI); ctx.fill();
  }
}

// ---------- disposition en organigramme (couches) ----------
function computeLayout(g: GraphData): Map<string, { x: number; y: number }> {
  const ids = g.nodes.map((n) => n.id);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of ids) { out.set(id, []); incoming.set(id, 0); }
  for (const l of g.links) { out.get(l.source)!.push(l.target); incoming.set(l.target, (incoming.get(l.target) ?? 0) + 1); }

  // 1) On retire les arêtes "de retour" (cycles) pour obtenir un graphe sans cycle (DFS itératif).
  const state = new Map<string, number>(); // 1 = en cours, 2 = terminé
  const kept = new Map<string, string[]>();
  for (const id of ids) kept.set(id, []);
  const starts = [...ids].sort((a, b) => incoming.get(a)! - incoming.get(b)!); // les racines d'abord
  for (const s of starts) {
    if (state.has(s)) continue;
    const stack: { v: string; i: number }[] = [{ v: s, i: 0 }];
    state.set(s, 1);
    while (stack.length) {
      const f = stack[stack.length - 1];
      const nb = out.get(f.v)!;
      if (f.i < nb.length) {
        const w = nb[f.i++];
        const st = state.get(w);
        if (st === 1) continue; // arête de retour : ignorée pour la hiérarchie
        kept.get(f.v)!.push(w);
        if (st === undefined) { state.set(w, 1); stack.push({ v: w, i: 0 }); }
      } else { state.set(f.v, 2); stack.pop(); }
    }
  }
  const parents = new Map<string, string[]>();
  for (const id of ids) parents.set(id, []);
  kept.forEach((ts, s) => ts.forEach((t) => parents.get(t)!.push(s)));

  // 2) Couches par plus long chemin : en haut les points d'entrée, en bas les fondations partagées.
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, parents.get(id)!.length);
  const layer = new Map<string, number>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  queue.forEach((id) => layer.set(id, 0));
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    for (const w of kept.get(v)!) {
      layer.set(w, Math.max(layer.get(w) ?? 0, layer.get(v)! + 1));
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  const layers: string[][] = [];
  for (const id of ids) (layers[layer.get(id) ?? 0] ??= []).push(id);

  // 3) Ordre dans chaque couche : dossier puis nom, affiné par la moyenne des voisins (barycentre).
  for (const l of layers) {
    l.sort((a, b) => {
      const na = byId.get(a)!, nb = byId.get(b)!;
      return na.dir.localeCompare(nb.dir) || na.label.localeCompare(nb.label);
    });
  }
  const norm = new Map<string, number>();
  const setNorm = (l: string[]) => l.forEach((id, i) => norm.set(id, (i + 0.5) / l.length));
  layers.forEach(setNorm);
  const reorder = (l: string[], nbrs: Map<string, string[]>) => {
    const bary = new Map<string, number>();
    for (const id of l) {
      const ns = nbrs.get(id)!;
      bary.set(id, ns.length ? ns.reduce((s, n) => s + norm.get(n)!, 0) / ns.length : norm.get(id)!);
    }
    l.sort((a, b) => bary.get(a)! - bary.get(b)!);
    setNorm(l);
  };
  for (let it = 0; it < 4; it++) {
    for (let i = 1; i < layers.length; i++) reorder(layers[i], parents);
    for (let i = layers.length - 2; i >= 0; i--) reorder(layers[i], kept);
  }

  // 4) Coordonnées. Les couches trop larges sont coupées en plusieurs rangées.
  const mctx = document.createElement('canvas').getContext('2d')!;
  let maxW = 0;
  for (const n of g.nodes) maxW = Math.max(maxW, boxLabel(mctx, n.label).w);
  const colW = maxW + 18;
  const rowH = BOX_H + 16;
  const gap = 56;
  const perRow = Math.max(8, Math.min(18, Math.ceil(Math.sqrt(ids.length) * 1.6)));
  const pos = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const l of layers) {
    const rows = Math.ceil(l.length / perRow);
    for (let r = 0; r < rows; r++) {
      const chunk = l.slice(r * perRow, (r + 1) * perRow);
      chunk.forEach((id, i) => pos.set(id, { x: (i - (chunk.length - 1) / 2) * colW, y: y + r * rowH }));
    }
    y += rows * rowH + gap;
  }
  return pos;
}

/** Force personnalisée : rapproche chaque fichier du centre de son dossier. */
function clusterForce(strength: number): any {
  let nodes: any[] = [];
  const f: any = (alpha: number) => {
    const c = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (const n of nodes) {
      const e = c.get(n.dir) ?? { x: 0, y: 0, z: 0, n: 0 };
      e.x += n.x || 0; e.y += n.y || 0; e.z += n.z || 0; e.n++;
      c.set(n.dir, e);
    }
    const k = alpha * strength;
    for (const n of nodes) {
      const e = c.get(n.dir)!;
      n.vx += (e.x / e.n - (n.x || 0)) * k;
      n.vy += (e.y / e.n - (n.y || 0)) * k;
      if (mode === '3d') n.vz += (e.z / e.n - (n.z || 0)) * k;
    }
  };
  f.initialize = (ns: any[]) => { nodes = ns; };
  return f;
}

// ---------- filtres ----------
/** Applique les filtres. L'impact reste calculé sur le graphe complet : on ne masque que l'affichage. */
function applyFilters(g: GraphData): GraphData {
  const terms = filters.path.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const inc = terms.filter((t) => !t.startsWith('!'));
  const exc = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1)).filter(Boolean);
  let nodes = g.nodes.filter((n) => {
    if (!filters.kinds.has(n.kind)) return false;
    const id = n.id.toLowerCase();
    if (inc.length && !inc.some((t) => id.includes(t))) return false;
    if (exc.some((t) => id.includes(t))) return false;
    if (filters.maxShared > 0 && (inDegree.get(n.id) ?? 0) >= filters.maxShared) return false;
    return true;
  });
  let ids = new Set(nodes.map((n) => n.id));
  const links = g.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  if (filters.hideIsolated) {
    const used = new Set<string>();
    for (const l of links) { used.add(l.source); used.add(l.target); }
    nodes = nodes.filter((n) => used.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
  }
  return { ...g, nodes, links };
}

let renderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

/** Met à jour le nœud "focus" (sélection prioritaire, sinon survol) et les fichiers impactés. */
function updateFocus(): void {
  const f = selected ?? hovered;
  if (f !== focus) {
    focus = f;
    impacted = f ? computeImpact(f) : new Set();
    refreshStyles();
  }
  $('hoverinfo').textContent =
    !selected && hovered ? `${hovered} : ${impacted.size} fichier(s) impacté(s) — clic pour figer` : '';
}

// ---------- rendu ----------
function tooltip(n: GNode): string {
  const inc = incidentByFile.get(n.id)?.map((i) => `⚠ ${i.title}`).join('\n') ?? '';
  return `${n.id}\n${inDegree.get(n.id) ?? 0} fichier(s) l'importent${inc ? '\n' + inc : ''}`;
}

function destroyGraph(): void {
  try { graph?._destructor?.(); } catch { /* ignore */ }
  graph = null;
  container.replaceChildren();
}

function render(): void {
  if (!data) return;
  destroyGraph();
  buildIndexes(data);
  const view = applyFilters(data);
  const visible = new Set(view.nodes.map((n) => n.id));
  if (selected && !visible.has(selected)) selected = null;
  hovered = null;
  focus = selected;
  impacted = selected ? computeImpact(selected) : new Set();
  $('hoverinfo').textContent = '';

  const empty = $('empty');
  empty.textContent = data.nodes.length ? 'Aucun fichier ne correspond aux filtres.' : 'Aucun fichier source trouvé dans ce dossier.';
  empty.style.display = view.nodes.length ? 'none' : 'flex';
  if (!view.nodes.length) {
    $('stats').textContent = `0 / ${data.stats.files} fichiers affichés`;
    renderSide();
    return;
  }

  const w = container.clientWidth, h = container.clientHeight;
  const tree = mode === 'tree';
  const layout = tree ? computeLayout(view) : null;

  // force-graph mute les objets : on lui donne une copie
  const gd = {
    nodes: view.nodes.map((n) => {
      const p = layout?.get(n.id);
      return p ? { ...n, x: p.x, y: p.y, fx: p.x, fy: p.y } : { ...n };
    }),
    links: view.links.map((l) => ({ source: l.source, target: l.target })),
  };

  if (mode === '3d') {
    graph = (ForceGraph3D as any)()(container)
      .graphData(gd).width(w).height(h)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id').nodeLabel(tooltip)
      .nodeVal(nodeSize3D).nodeColor(nodeColor).nodeOpacity(0.95)
      .linkColor(linkColor).linkOpacity(0.6)
      .linkDirectionalArrowLength(3.5).linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles(particles);
  } else {
    const g = (ForceGraph as any)()(container)
      .graphData(gd).width(w).height(h)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id').nodeLabel(tooltip)
      .nodeRelSize(4)
      // le "rayon" vu par la librairie sert à placer les flèches au bord du nœud
      .nodeVal((n: GNode) => (tree ? (BOX_H / 2 / 4) ** 2 : (radius2D(n) / 4) ** 2))
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint(pointerArea)
      .linkColor(linkColor)
      .linkDirectionalArrowLength(tree ? 5 : 3.5).linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles(particles)
      .enableNodeDrag(!tree)
      .autoPauseRedraw(false); // sinon le canvas ne se redessine pas après un changement de sélection
    graph = g;
    if (tree) {
      g.cooldownTicks(0);
      setTimeout(() => { if (graph === g) g.zoomToFit(0, 40); }, 60);
    } else {
      g.cooldownTicks(200);
      let fitted = false;
      g.onEngineStop(() => { if (graph === g && !fitted) { fitted = true; g.zoomToFit(400, 40); } });
    }
  }

  graph.onNodeClick((n: GNode) => select(n.id));
  graph.onNodeRightClick?.((n: GNode) => vscode.postMessage({ type: 'open', file: n.id }));
  graph.onBackgroundClick(() => select(null));
  graph.onNodeHover((n: GNode | null) => { hovered = n ? n.id : null; updateFocus(); });

  $('stats').textContent =
    `${view.nodes.length}/${data.stats.files} fichiers · ${view.links.length} liens · ${data.cycles.length} cycle(s)` +
    (data.stats.unresolved ? ` · ${data.stats.unresolved} import(s) non résolu(s)` : '');
  renderSide();
}

/** Bouton « Organiser » : remet tout au propre selon la vue courante. */
function arrange(): void {
  if (!graph || !data) return;
  if (mode === 'tree') { render(); return; } // recalcule la hiérarchie et recadre
  for (const n of graph.graphData().nodes) { n.fx = undefined; n.fy = undefined; n.fz = undefined; }
  graph.d3Force('charge')?.strength(-110); // écarte les nœuds
  graph.d3Force('link')?.distance(45);
  graph.d3Force('cluster', clusterForce(0.5)); // regroupe par dossier
  graph.d3AlphaDecay?.(0.02); // refroidit lentement pour bien se stabiliser
  graph.d3ReheatSimulation();
  const g = graph;
  setTimeout(() => { if (graph === g) g.zoomToFit?.(600, 40); }, 2500);
}

function select(id: string | null): void {
  selected = id;
  updateFocus();
  renderSide();
}

function search(q: string): void {
  matches = new Set();
  const s = q.trim().toLowerCase();
  if (s && data) for (const n of data.nodes) if (n.id.toLowerCase().includes(s)) matches.add(n.id);
  refreshStyles();
}

function focusNode(id: string): void {
  const n = graph?.graphData().nodes.find((x: any) => x.id === id);
  if (!n) return;
  if (mode !== '3d') { graph.centerAt(n.x, n.y, 600); graph.zoom(mode === 'tree' ? 2.5 : 4, 600); }
  else {
    const d = 120, r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
    graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 800);
  }
}

// ---------- panneau latéral (textContent partout : pas d'injection HTML) ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function fileLink(file: string): HTMLElement {
  const a = el('span', file, 'link');
  a.title = 'Clic : ouvrir le fichier';
  a.addEventListener('click', () => vscode.postMessage({ type: 'open', file }));
  return a;
}
function section(title: string, files: string[], limit = 30): void {
  side.append(el('h3', `${title} (${files.length})`));
  const ul = el('ul');
  for (const f of files.slice(0, limit)) { const li = el('li'); li.append(fileLink(f)); ul.append(li); }
  if (files.length > limit) ul.append(el('li', `… et ${files.length - limit} autres`));
  side.append(ul);
}

function renderSide(): void {
  side.replaceChildren();
  if (!data) return;

  if (selected) {
    side.append(el('h3', 'Simulation de panne'));
    const p = el('div', undefined, 'path'); p.append(fileLink(selected)); side.append(p);
    side.append(el('div', `Si ce fichier casse, ${impacted.size} fichier(s) sont impactés (directement ou non).`));
    const inc = incidentByFile.get(selected);
    if (inc) { side.append(el('h3', 'Incidents connus')); const ul = el('ul'); inc.forEach((i) => ul.append(el('li', `[${i.severity}] ${i.title}`))); side.append(ul); }
    section('Impactés', [...impacted].sort());
    section('Dépend de', dependencies.get(selected) ?? []);
    return;
  }

  const lg = el('div', undefined, 'legend');
  lg.id = 'legend';
  const legend: [string, string][] = [
    ['Module Nest', KIND_COLOR.module], ['Controller', KIND_COLOR.controller], ['Service', KIND_COLOR.service],
    ['Vue', KIND_COLOR.vue], ['Svelte', KIND_COLOR.svelte], ['Autre', KIND_COLOR.other],
    ['Cycle', COL_CYCLE], ['Incident', COL_INCIDENT],
  ];
  for (const [name, color] of legend) {
    const s = el('span'); const d = el('span', undefined, 'dot'); d.style.background = color; s.append(d, name); lg.append(s);
  }
  side.append(el('h3', 'Légende'), lg);
  side.append(el('div',
    "Organigramme : les points d'entrée sont en haut, les fichiers très partagés en bas (une flèche va du fichier qui importe vers celui qui est importé). " +
    "Clic : simuler la panne d'un fichier. Clic droit : ouvrir. En 2D/3D, la taille d'un nœud = nombre de fichiers qui l'importent.",
    'path'));

  if (data.incidents.length) {
    side.append(el('h3', `Incidents (${data.incidents.length})`));
    const ul = el('ul');
    for (const i of data.incidents) {
      const li = el('li'); li.append(el('span', `[${i.severity}] ${i.title} — `)); const f = fileLink(i.file);
      f.addEventListener('click', () => select(i.file)); li.append(f); ul.append(li);
    }
    side.append(ul);
  }
  if (data.cycles.length) {
    side.append(el('h3', `Cycles (${data.cycles.length})`));
    data.cycles.slice(0, 15).forEach((c, k) => {
      side.append(el('div', `Cycle ${k + 1} (${c.length} fichiers)`, 'path'));
      const ul = el('ul'); c.forEach((f) => { const li = el('li'); li.append(fileLink(f)); ul.append(li); }); side.append(ul);
    });
  }
  const top = [...data.nodes].sort((a, b) => (inDegree.get(b.id) ?? 0) - (inDegree.get(a.id) ?? 0)).slice(0, 8)
    .filter((n) => (inDegree.get(n.id) ?? 0) > 0);
  if (top.length) {
    side.append(el('h3', 'Les plus importés'));
    const ul = el('ul');
    top.forEach((n) => { const li = el('li'); li.append(fileLink(n.id), el('span', ` (${inDegree.get(n.id)})`)); ul.append(li); });
    side.append(ul);
  }
}

// ---------- barre d'outils ----------
function setMode(m: Mode): void {
  mode = m;
  $('mtree').classList.toggle('on', m === 'tree');
  $('m2d').classList.toggle('on', m === '2d');
  $('m3d').classList.toggle('on', m === '3d');
  render();
}
$('mtree').addEventListener('click', () => setMode('tree'));
$('m2d').addEventListener('click', () => setMode('2d'));
$('m3d').addEventListener('click', () => setMode('3d'));
$('arrange').addEventListener('click', arrange);

// Filtres : types de fichiers (cases à cocher), chemin, fichiers très partagés, isolés
const KIND_LABEL: Record<string, string> = {
  module: 'Module', controller: 'Controller', service: 'Service', vue: 'Vue', svelte: 'Svelte', other: 'Autre',
};
const kindBoxes: HTMLInputElement[] = [];
for (const k of ALL_KINDS) {
  const lab = el('label', undefined, 'chk');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = true;
  cb.addEventListener('change', () => { if (cb.checked) filters.kinds.add(k); else filters.kinds.delete(k); scheduleRender(); });
  const dot = el('span', undefined, 'dot'); dot.style.background = KIND_COLOR[k];
  lab.append(cb, dot, KIND_LABEL[k]);
  $('kinds').append(lab);
  kindBoxes.push(cb);
}
const fpath = $<HTMLInputElement>('fpath');
const fshared = $<HTMLInputElement>('fshared');
const fiso = $<HTMLInputElement>('fiso');
fpath.addEventListener('input', () => { filters.path = fpath.value; scheduleRender(); });
fshared.addEventListener('input', () => { filters.maxShared = Math.max(0, parseInt(fshared.value, 10) || 0); scheduleRender(); });
fiso.addEventListener('change', () => { filters.hideIsolated = fiso.checked; scheduleRender(); });
$('freset').addEventListener('click', () => {
  filters.kinds = new Set(ALL_KINDS); filters.path = ''; filters.maxShared = 0; filters.hideIsolated = false;
  kindBoxes.forEach((c) => (c.checked = true));
  fpath.value = ''; fshared.value = '0'; fiso.checked = false;
  render();
});
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('reset').addEventListener('click', () => select(null));
const q = $<HTMLInputElement>('q');
q.addEventListener('input', () => search(q.value));
q.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = [...matches][0];
  if (first) { select(first); focusNode(first); }
});
window.addEventListener('resize', () => graph?.width(container.clientWidth).height(container.clientHeight));

window.addEventListener('message', (e) => {
  if (e.data?.type === 'graph') {
    data = e.data.graph as GraphData;
    selected = null; impacted = new Set(); matches = new Set();
    render();
  }
});
vscode.postMessage({ type: 'ready' });
