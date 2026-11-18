// Code exécuté dans le webview (navigateur), pas dans Node.
import ForceGraph from 'force-graph';
import ForceGraph3D from '3d-force-graph';
import { Graph, GLink, GNode, Incident, Layer, LayerDiff, CompareResult, ChangeSet } from '../shared/types';
import { impactOf, reverseAdj } from '../shared/graph';
import { BOX_H, boxLabel, computeLayout } from './layout';
import { ExLink, ExNode, MLink, MNode, toMermaid, toSvg } from './exporters';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

type Mode = 'tree' | '2d' | '3d';
type Scope = 'files' | 'nest' | 'packages';
interface Suggestion { file: string; title: string; why: string; check: string }
interface AiBox { loading?: boolean; text?: string; error?: string; copied?: boolean; model?: string }

const KIND_COLOR: Record<string, string> = {
  module: '#4fc1ff', controller: '#c586c0', service: '#4ec9b0', vue: '#42b883', svelte: '#ff6a3d',
  package: '#b180d7', folder: '#d7ba7d', other: '#9aa0a6',
};
const COL_SELECTED = '#ffffff';
const COL_IMPACT = '#ffa733';
const COL_CHANGED = '#ffd43b';
const COL_INCIDENT = '#f14c4c';
const COL_CYCLE = '#ff4fd8';
const COL_ADDED = '#3fb950';
const COL_REMOVED = '#f85149';
const COL_VIOLATION = '#9b5de5';
const COL_ACTIVE = '#00e5ff';
const COL_MATCH = '#ffe066';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $('canvas'); // la librairie vide son conteneur : il ne doit contenir que le graphe
const side = $('side');

// ---------- état ----------
let data: Graph | null = null;
let project = '';
let mode: Mode = 'tree';
let scope: Scope = 'files';
let graph: any = null;
let selected: string | null = null;
let hovered: string | null = null;
let focus: string | null = null;
let activeFile: string | null = null;
let gitAvailable = false;
let changes: ChangeSet | null = null;
let compare: CompareResult | null = null;
let groupDepth = 0;
const expanded = new Set<string>(); // dossiers dépliés manuellement
let matches = new Set<string>();
const ai = { summaries: new Map<string, AiBox>(), suggest: null as null | (AiBox & { items?: Suggestion[] | null }), diff: null as null | AiBox };

const ALL_KINDS = ['module', 'controller', 'service', 'vue', 'svelte', 'other'];
const filters = { kinds: new Set(ALL_KINDS), path: '', maxShared: 0, hideIsolated: false, hideTests: true };

// Vue courante (recalculée à chaque rendu)
interface View {
  nodes: GNode[]; links: GLink[]; cycles: string[][];
  disp: (id: string) => string;
  members: Map<string, string[]>; // groupe -> fichiers membres
  rev: Map<string, string[]>; // dépendants, sur la couche complète
  inDegree: Map<string, number>;
  dependencies: Map<string, string[]>;
  cyclic: Set<string>;
  full: Layer;
}
let view: View | null = null;
// Surcouches converties en identifiants affichés
let fImpact = new Set<string>();
let changedD = new Set<string>(), cImpactD = new Set<string>();
let addedD = new Set<string>(), removedD = new Set<string>();
let addedLinks = new Set<string>(), removedLinks = new Set<string>();
let violNodes = new Set<string>(), violLinks = new Set<string>();
let incidentByNode = new Map<string, Incident[]>();
let testsToRerun: string[] = [];

const idOf = (end: any): string => (typeof end === 'object' ? end.id : end);
const lk = (s: string, t: string): string => s + '\u0000' + t;
const layerOf = (g: Graph, s: Scope): Layer => (s === 'nest' ? g.nest : s === 'packages' ? g.packages : g.files);
const diffOf = (c: CompareResult, s: Scope): LayerDiff => (s === 'nest' ? c.nest : s === 'packages' ? c.packages : c.files);
const fileOf = (n: GNode): string => n.file ?? n.id;

// ---------- calcul de la vue ----------
function groupKey(n: GNode): string | null {
  if (scope !== 'files' || groupDepth <= 0) return null;
  const segs = n.dir.split('/').filter((s) => s && s !== '.');
  if (!segs.length) return null;
  return segs.slice(0, groupDepth).join('/');
}

function computeView(): View | null {
  if (!data) return null;
  const full = layerOf(data, scope);
  const rev = reverseAdj(full.nodes.map((n) => n.id), full.links);
  const dif = compare ? diffOf(compare, scope) : null;

  let nodes: GNode[] = [...full.nodes];
  let links: GLink[] = [...full.links];
  if (dif) {
    const have = new Set(nodes.map((n) => n.id));
    for (const g of dif.removedNodes) if (!have.has(g.id)) nodes.push({ ...g, ghost: true });
    links = links.concat(dif.removedLinks.map((l) => ({ ...l, removed: true })));
  }
  if (scope === 'files' && filters.hideTests) {
    const hide = new Set(nodes.filter((n) => n.isTest).map((n) => n.id));
    nodes = nodes.filter((n) => !hide.has(n.id));
    links = links.filter((l) => !hide.has(l.source) && !hide.has(l.target));
  }

  // Regroupement par dossier
  const members = new Map<string, string[]>();
  const keyOf = new Map<string, string>();
  if (scope === 'files' && groupDepth > 0) {
    const counts = new Map<string, number>();
    for (const n of nodes) { const k = groupKey(n); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
    for (const n of nodes) {
      const k = groupKey(n);
      if (k && (counts.get(k) ?? 0) > 1 && !expanded.has(k)) {
        keyOf.set(n.id, 'dir:' + k);
        (members.get('dir:' + k) ?? members.set('dir:' + k, []).get('dir:' + k)!).push(n.id);
      }
    }
  }
  const disp = (id: string): string => keyOf.get(id) ?? id;
  if (members.size) {
    const out: GNode[] = nodes.filter((n) => !keyOf.has(n.id));
    for (const [gid, ids] of members) {
      const path = gid.slice(4);
      out.push({ id: gid, label: `${path.split('/').pop()}/ (${ids.length})`, dir: path.split('/').slice(0, -1).join('/'), kind: 'folder', count: ids.length });
    }
    const agg = new Map<string, GLink>();
    for (const l of links) {
      const s = disp(l.source), t = disp(l.target);
      if (s === t) continue;
      const k = lk(s, t), prev = agg.get(k);
      const rm = !!(l as any).removed;
      if (prev) { prev.w = (prev.w ?? 1) + (l.w ?? 1); if (!rm) delete (prev as any).removed; } else agg.set(k, { source: s, target: t, w: l.w ?? 1, ...(rm ? { removed: true } : {}) } as GLink);
    }
    nodes = out;
    links = [...agg.values()];
  }

  // Filtres d'affichage (l'impact reste calculé sur la couche complète)
  const inDeg0 = new Map<string, number>();
  for (const l of links) inDeg0.set(l.target, (inDeg0.get(l.target) ?? 0) + 1);
  const terms = filters.path.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
  const inc = terms.filter((t) => !t.startsWith('!'));
  const exc = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1)).filter(Boolean);
  nodes = nodes.filter((n) => {
    if (ALL_KINDS.includes(n.kind) && !filters.kinds.has(n.kind)) return false;
    const id = n.id.toLowerCase();
    if (inc.length && !inc.some((t) => id.includes(t))) return false;
    if (exc.some((t) => id.includes(t))) return false;
    if (filters.maxShared > 0 && (inDeg0.get(n.id) ?? 0) >= filters.maxShared) return false;
    return true;
  });
  let ids = new Set(nodes.map((n) => n.id));
  links = links.filter((l) => ids.has(l.source) && ids.has(l.target));
  if (filters.hideIsolated) {
    const used = new Set<string>();
    for (const l of links) { used.add(l.source); used.add(l.target); }
    nodes = nodes.filter((n) => used.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
  }

  const inDegree = new Map<string, number>();
  const dependencies = new Map<string, string[]>();
  for (const n of nodes) { inDegree.set(n.id, 0); dependencies.set(n.id, []); }
  for (const l of links) {
    if ((l as any).removed) continue;
    inDegree.set(l.target, (inDegree.get(l.target) ?? 0) + 1);
    dependencies.get(l.source)?.push(l.target);
  }
  const cycles = full.cycles.map((c) => [...new Set(c.map(disp))]);
  return { nodes, links, cycles, disp, members, rev, inDegree, dependencies, cyclic: new Set(cycles.flat()), full };
}

/** Convertit surcouches (diff Git, comparaison, violations, incidents) en identifiants affichés. */
function computeOverlays(v: View): void {
  const { disp, full } = v;
  const map = (ids: Iterable<string>): Set<string> => new Set([...ids].map(disp));
  changedD = new Set(); cImpactD = new Set(); testsToRerun = [];
  if (changes) {
    const files = new Set(changes.files);
    const isChanged = (n: GNode): boolean =>
      scope === 'packages' ? [...files].some((f) => n.id === '.' || f === n.id || f.startsWith(n.id + '/')) : files.has(fileOf(n));
    const roots = full.nodes.filter(isChanged).map((n) => n.id);
    changedD = map(roots);
    const imp = impactOf(v.rev, roots);
    cImpactD = map(imp);
    for (const id of changedD) cImpactD.delete(id);
    if (data) {
      const tests = new Set<string>();
      for (const n of data.files.nodes) if (n.isTest) tests.add(n.id);
      // les tests sont masqués de la vue mais restent à relancer : on les calcule toujours sur les fichiers
      const fRoots = data.files.nodes.filter((n) => files.has(n.id)).map((n) => n.id);
      const fImp = impactOf(reverseAdj(data.files.nodes.map((n) => n.id), data.files.links), fRoots);
      const all = new Set<string>([...fRoots, ...fImp]);
      testsToRerun = [...all].filter((id) => tests.has(id)).sort();
    }
  }
  addedD = new Set(); removedD = new Set(); addedLinks = new Set(); removedLinks = new Set();
  if (compare) {
    const dif = diffOf(compare, scope);
    addedD = map(dif.addedNodes);
    removedD = map(dif.removedNodes.map((n) => n.id));
    for (const l of dif.addedLinks) addedLinks.add(lk(disp(l.source), disp(l.target)));
    for (const l of dif.removedLinks) removedLinks.add(lk(disp(l.source), disp(l.target)));
  }
  violNodes = new Set(); violLinks = new Set();
  if (data && scope === 'files') {
    for (const x of data.violations) {
      violNodes.add(disp(x.source)); violNodes.add(disp(x.target));
      violLinks.add(lk(disp(x.source), disp(x.target)));
    }
  }
  incidentByNode = new Map();
  if (data && scope === 'files') {
    for (const i of data.incidents) { const k = disp(i.file); incidentByNode.set(k, [...(incidentByNode.get(k) ?? []), i]); }
  }
}

function computeFocusImpact(): void {
  fImpact = new Set();
  if (!focus || !view) return;
  const roots = view.members.get(focus) ?? [focus];
  for (const id of impactOf(view.rev, roots)) fImpact.add(view.disp(id));
  fImpact.delete(focus);
}

// ---------- styles ----------
const isDim = (id: string): boolean => !!focus && id !== focus && !fImpact.has(id);

function baseColor(n: GNode): string {
  if (focus) return (KIND_COLOR[n.kind] ?? KIND_COLOR.other);
  if (n.ghost || removedD.has(n.id)) return COL_REMOVED;
  if (addedD.has(n.id)) return COL_ADDED;
  if (changedD.has(n.id)) return COL_CHANGED;
  if (cImpactD.has(n.id)) return COL_IMPACT;
  if (violNodes.has(n.id)) return COL_VIOLATION;
  if (incidentByNode.has(n.id)) return COL_INCIDENT;
  if (view?.cyclic.has(n.id)) return COL_CYCLE;
  return KIND_COLOR[n.kind] ?? KIND_COLOR.other;
}

function nodeColor(n: GNode): string {
  if (n.id === focus) return COL_SELECTED;
  if (focus && fImpact.has(n.id)) return COL_IMPACT;
  const c = baseColor(n);
  return focus ? c + '55' : c; // on estompe le reste pendant une simulation
}

function rings(n: GNode): string[] {
  const r: string[] = [];
  if (n.id === activeFile) r.push(COL_ACTIVE);
  if (matches.has(n.id)) r.push(COL_MATCH);
  if (violNodes.has(n.id)) r.push(COL_VIOLATION);
  if (incidentByNode.has(n.id)) r.push(COL_INCIDENT);
  return r;
}

function linkColor(l: any): string {
  const s = idOf(l.source), t = idOf(l.target), k = lk(s, t);
  if (focus && (s === focus || t === focus || (fImpact.has(s) && (fImpact.has(t) || t === focus)))) return COL_IMPACT;
  if (focus) return 'rgba(150,150,150,0.12)';
  if (removedLinks.has(k) || l.removed) return COL_REMOVED;
  if (addedLinks.has(k)) return COL_ADDED;
  if (violLinks.has(k)) return COL_VIOLATION;
  if (view?.cycles.some((c) => c.length > 1 && c.includes(s) && c.includes(t))) return COL_CYCLE;
  return 'rgba(150,150,150,0.45)';
}
const linkWidth = (l: any): number => {
  const k = lk(idOf(l.source), idOf(l.target));
  return !focus && (addedLinks.has(k) || removedLinks.has(k) || violLinks.has(k)) ? 2.2 : 1;
};
const particles = (l: any): number => (focus && linkColor(l) === COL_IMPACT ? 2 : 0);

function applyStyles(): void {
  // Réassigner de NOUVELLES fonctions force le moteur à recalculer les styles
  if (!graph) return;
  if (mode === '3d') graph.nodeColor((n: GNode) => nodeColor(n));
  else {
    graph.nodeCanvasObject((n: any, c: CanvasRenderingContext2D, s: number) => drawNode(n, c, s));
    graph.linkLineDash?.((l: any) => (removedLinks.has(lk(idOf(l.source), idOf(l.target))) || l.removed ? [4, 3] : null));
  }
  graph.linkColor((l: any) => linkColor(l));
  graph.linkWidth?.((l: any) => linkWidth(l));
  graph.linkDirectionalParticles((l: any) => particles(l));
}

// ---------- dessin 2D / organigramme ----------
const radius2D = (n: GNode): number => 2.5 + Math.sqrt(1 + Math.min(14, view?.inDegree.get(n.id) ?? 0)) * 1.6;
const nodeSize3D = (n: GNode): number => 1 + Math.min(14, view?.inDegree.get(n.id) ?? 0);
const fgColor = (): string => getComputedStyle(document.body).color || '#ddd';

function pathRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
}

function drawNode(node: any, ctx: CanvasRenderingContext2D, scale: number): void {
  const rs = rings(node);
  if (mode === 'tree') {
    const { text, w } = boxLabel(ctx, node.label);
    const x = node.x - w / 2, y = node.y - BOX_H / 2;
    pathRect(ctx, x, y, w, BOX_H);
    ctx.fillStyle = nodeColor(node);
    ctx.fill();
    ctx.lineWidth = 2;
    rs.forEach((c, i) => { ctx.strokeStyle = c; const o = 1.5 + i * 2.5; pathRect(ctx, x - o, y - o, w + 2 * o, BOX_H + 2 * o); ctx.stroke(); });
    ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isDim(node.id) ? fgColor() : '#101010';
    ctx.fillText(text, node.x, node.y + 0.5);
    return;
  }
  const r = radius2D(node);
  ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = nodeColor(node); ctx.fill();
  ctx.lineWidth = 1.4;
  rs.forEach((c, i) => { ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(node.x, node.y, r + 2.5 + i * 2.5, 0, 2 * Math.PI); ctx.stroke(); });
  if (scale > 2.2 || node.id === focus || fImpact.has(node.id) || matches.has(node.id) || node.id === activeFile || node.kind === 'folder') {
    ctx.font = `${Math.max(3, 11 / scale)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = fgColor();
    ctx.fillText(node.label, node.x, node.y + r + 1.5);
  }
}

function pointerArea(node: any, color: string, ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = color;
  if (mode === 'tree') {
    const { w } = boxLabel(ctx, node.label);
    ctx.fillRect(node.x - w / 2, node.y - BOX_H / 2, w, BOX_H);
  } else { ctx.beginPath(); ctx.arc(node.x, node.y, radius2D(node) + 2, 0, 2 * Math.PI); ctx.fill(); }
}

/** Force personnalisée : rapproche chaque fichier du centre de son dossier. */
function clusterForce(strength: number): any {
  let nodes: any[] = [];
  const f: any = (alpha: number) => {
    const c = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (const n of nodes) {
      const e = c.get(n.dir) ?? { x: 0, y: 0, z: 0, n: 0 };
      e.x += n.x || 0; e.y += n.y || 0; e.z += n.z || 0; e.n++; c.set(n.dir, e);
    }
    const k = alpha * strength;
    for (const n of nodes) {
      const e = c.get(n.dir)!;
      n.vx += (e.x / e.n - (n.x || 0)) * k; n.vy += (e.y / e.n - (n.y || 0)) * k;
      if (mode === '3d') n.vz += (e.z / e.n - (n.z || 0)) * k;
    }
  };
  f.initialize = (ns: any[]) => { nodes = ns; };
  return f;
}

// ---------- rendu ----------
let renderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRender(): void { clearTimeout(renderTimer); renderTimer = setTimeout(() => render(), 150); }

function updateFocus(): void {
  const f = selected ?? hovered;
  if (f !== focus) { focus = f; computeFocusImpact(); applyStyles(); }
  $('hoverinfo').textContent = !selected && hovered ? `${hovered} : ${fImpact.size} impacté(s) — clic pour figer` : '';
}

function tooltip(n: GNode): string {
  const inc = incidentByNode.get(n.id)?.map((i) => `⚠ ${i.title}`).join('\n') ?? '';
  const extra = n.nest ? `\nproviders: ${n.nest.providers.length}, controllers: ${n.nest.controllers.length}` : '';
  return `${n.id}\n${view?.inDegree.get(n.id) ?? 0} dépendant(s)${extra}${inc ? '\n' + inc : ''}`;
}

function destroyGraph(): void {
  try { graph?._destructor?.(); } catch { /* ignore */ }
  graph = null;
  container.replaceChildren();
}

function saveCam(): any {
  try {
    if (!graph) return null;
    if (mode === '3d') return { p: graph.cameraPosition() };
    return { k: graph.zoom(), c: graph.centerAt() };
  } catch { return null; }
}
function restoreCam(cam: any): void {
  try {
    if (!cam || !graph) return;
    if (mode === '3d') graph.cameraPosition(cam.p);
    else { graph.zoom(cam.k, 0); graph.centerAt(cam.c.x, cam.c.y, 0); }
  } catch { /* ignore */ }
}

function render(keepCam = false): void {
  if (!data) return;
  const cam = keepCam ? saveCam() : null;
  destroyGraph();
  view = computeView();
  if (!view) return;
  computeOverlays(view);
  const ids = new Set(view.nodes.map((n) => n.id));
  if (selected && !ids.has(selected)) selected = null;
  hovered = null; focus = selected; computeFocusImpact();
  $('hoverinfo').textContent = '';
  $('fgroup').toggleAttribute('disabled', scope !== 'files');
  $('bclear').style.display = changes || compare ? '' : 'none';

  const total = layerOf(data, scope).nodes.length;
  const empty = $('empty');
  empty.textContent = scope === 'nest' && !total ? 'Aucun module NestJS (@Module) trouvé.'
    : scope === 'packages' && !total ? 'Pas de monorepo détecté (il faut au moins 2 package.json).'
    : total ? 'Aucun nœud ne correspond aux filtres.' : 'Aucun fichier source trouvé dans ce dossier.';
  empty.style.display = view.nodes.length ? 'none' : 'flex';
  $('stats').textContent = `${view.nodes.length}/${total} nœuds · ${view.links.length} liens · ${view.cycles.filter((c) => c.length > 1).length} cycle(s)` +
    (data.violations.length ? ` · ${data.violations.length} violation(s)` : '');
  if (!view.nodes.length) { renderSide(); return; }

  const w = container.clientWidth, h = container.clientHeight;
  const tree = mode === 'tree';
  const layout = tree ? computeLayout(view.nodes, view.links.filter((l) => !(l as any).removed)) : null;
  const gd = {
    nodes: view.nodes.map((n) => { const p = layout?.get(n.id); return p ? { ...n, x: p.x, y: p.y, fx: p.x, fy: p.y } : { ...n }; }),
    links: view.links.map((l) => ({ ...l, source: l.source, target: l.target })),
  };
  const common = (g: any) => g.graphData(gd).width(w).height(h).backgroundColor('rgba(0,0,0,0)').nodeId('id').nodeLabel(tooltip)
    .linkColor(linkColor).linkDirectionalParticles(particles);

  if (mode === '3d') {
    graph = common((ForceGraph3D as any)()(container))
      .nodeVal(nodeSize3D).nodeColor(nodeColor).nodeOpacity(0.95).linkOpacity(0.6)
      .linkWidth(linkWidth).linkDirectionalArrowLength(3.5).linkDirectionalArrowRelPos(1);
    if (cam) restoreCam(cam);
    else {
      const g3 = graph; let fit3 = false;
      g3.onEngineStop(() => { if (graph === g3 && !fit3) { fit3 = true; g3.zoomToFit(400, 60); } });
    }
  } else {
    const g = common((ForceGraph as any)()(container))
      .nodeRelSize(4)
      .nodeVal((n: GNode) => (tree ? (BOX_H / 2 / 4) ** 2 : (radius2D(n) / 4) ** 2)) // sert à placer les flèches au bord
      .nodeCanvasObject(drawNode).nodePointerAreaPaint(pointerArea)
      .linkWidth(linkWidth).linkLineDash((l: any) => (removedLinks.has(lk(idOf(l.source), idOf(l.target))) || l.removed ? [4, 3] : null))
      .linkDirectionalArrowLength(tree ? 5 : 3.5).linkDirectionalArrowRelPos(1)
      .enableNodeDrag(!tree)
      .autoPauseRedraw(false); // sinon le canvas ne se redessine pas après un changement de sélection
    graph = g;
    if (tree) {
      g.cooldownTicks(0);
      if (cam) restoreCam(cam); else setTimeout(() => { if (graph === g) g.zoomToFit(0, 40); }, 60);
    } else {
      g.cooldownTicks(200);
      let fitted = !!cam;
      if (cam) restoreCam(cam);
      g.onEngineStop(() => { if (graph === g && !fitted) { fitted = true; g.zoomToFit(400, 40); } });
    }
  }
  graph.onNodeClick((n: GNode) => select(n.id));
  graph.onNodeRightClick?.((n: GNode) => {
    if (view?.members.has(n.id)) { expanded.add(n.id.slice(4)); render(); } // dossier : on le déplie
    else openNode(n);
  });
  graph.onBackgroundClick(() => select(null));
  graph.onNodeHover((n: GNode | null) => { hovered = n ? n.id : null; updateFocus(); });
  renderSide();
}

function openNode(n: GNode | undefined): void {
  if (!n || n.kind === 'folder' || n.kind === 'package') return;
  vscode.postMessage({ type: 'open', file: fileOf(n), line: n.line });
}

function arrange(): void {
  if (!graph || !data) return;
  if (mode === 'tree') { render(); return; }
  for (const n of graph.graphData().nodes) { n.fx = undefined; n.fy = undefined; n.fz = undefined; }
  graph.d3Force('charge')?.strength(-110);
  graph.d3Force('link')?.distance(45);
  graph.d3Force('cluster', clusterForce(0.5));
  graph.d3AlphaDecay?.(0.02);
  graph.d3ReheatSimulation();
  const g = graph;
  setTimeout(() => { if (graph === g) g.zoomToFit?.(600, 40); }, 2500);
}

function select(id: string | null): void { selected = id; updateFocus(); renderSide(); }

function search(q: string): void {
  matches = new Set();
  const s = q.trim().toLowerCase();
  if (s && view) for (const n of view.nodes) if (n.id.toLowerCase().includes(s) || n.label.toLowerCase().includes(s)) matches.add(n.id);
  applyStyles();
}

function focusNode(id: string): void {
  const n = graph?.graphData().nodes.find((x: any) => x.id === id);
  if (!n) return;
  if (mode !== '3d') { graph.centerAt(n.x, n.y, 600); graph.zoom(mode === 'tree' ? 2.5 : 4, 600); }
  else { const d = 120, r = 1 + d / Math.hypot(n.x || 1, n.y || 1, n.z || 1); graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 800); }
}

/** Nœud affiché correspondant à un fichier de l'éditeur, selon la vue courante. */
function nodeForFile(file: string): string | null {
  if (!view || !data) return null;
  const full = layerOf(data, scope);
  let id: string | undefined;
  if (scope === 'files') id = full.nodes.find((n) => n.id === file)?.id;
  else if (scope === 'nest') id = full.nodes.find((n) => fileOf(n) === file)?.id;
  else id = full.nodes.filter((n) => n.id === '.' || file === n.id || file.startsWith(n.id + '/')).sort((a, b) => b.id.length - a.id.length)[0]?.id;
  if (!id) return null;
  const d = view.disp(id);
  return view.nodes.some((n) => n.id === d) ? d : null;
}

// ---------- panneau latéral (textContent partout : pas d'injection HTML) ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function nodeLink(id: string, label?: string): HTMLElement {
  const a = el('span', label ?? id, 'link');
  a.title = 'Clic : sélectionner · Ctrl/Cmd+clic : ouvrir';
  a.addEventListener('click', (e) => {
    const n = view?.nodes.find((x) => x.id === id) ?? data?.files.nodes.find((x) => x.id === id);
    if ((e.ctrlKey || e.metaKey) || !view?.nodes.some((x) => x.id === id)) { openNode(n ?? { id, label: id, dir: '', kind: 'other' }); return; }
    select(id); focusNode(id);
  });
  return a;
}
function openLink(file: string, line?: number, label?: string): HTMLElement {
  const a = el('span', label ?? file, 'link');
  a.title = 'Clic : ouvrir le fichier';
  a.addEventListener('click', () => vscode.postMessage({ type: 'open', file, line }));
  return a;
}
function list(title: string, ids: string[], mk: (id: string) => HTMLElement, limit = 30): void {
  side.append(el('h3', `${title} (${ids.length})`));
  const ul = el('ul');
  for (const id of ids.slice(0, limit)) { const li = el('li'); li.append(mk(id)); ul.append(li); }
  if (ids.length > limit) ul.append(el('li', `… et ${ids.length - limit} autres`));
  side.append(ul);
}
function btn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', text); if (title) b.title = title; b.addEventListener('click', onClick); return b;
}
function aiBox(box: AiBox | undefined | null): HTMLElement | null {
  if (!box) return null;
  const d = el('div', undefined, 'box');
  if (box.loading) d.textContent = '⏳ Le modèle réfléchit…';
  else if (box.error) {
    d.textContent = box.error; if (!box.copied) d.classList.add('err');
  } else if (box.text) d.textContent = box.text + (box.model ? `\n— ${box.model}` : '');
  return d;
}

function renderOverlays(): void {
  if (!data) return;
  if (changes) {
    side.append(el('h3', `Impact Git — ${changes.label}`));
    const nChanged = changedD.size, nImp = cImpactD.size;
    side.append(el('div', `${changes.files.length} fichier(s) modifié(s) · ${nChanged} nœud(s) touché(s) · ${nImp} impacté(s) indirectement. Jaune = modifié, orange = impacté.`, 'path'));
    list('Tests à relancer', testsToRerun, (id) => openLink(id));
    const row = el('div'); row.style.margin = '6px 0'; row.style.display = 'flex'; row.style.gap = '6px';
    row.append(
      btn('Copier la liste', () => vscode.postMessage({ type: 'copy', text: testsToRerun.join('\n') }), 'Une ligne par fichier de test'),
      btn('Analyser (IA)', () => {
        ai.diff = { loading: true }; renderSide();
        vscode.postMessage({ type: 'analyzeDiff', label: changes!.label, changed: changes!.files.slice(0, 200), impacted: [...cImpactD].slice(0, 200), tests: testsToRerun.slice(0, 200) });
      }),
    );
    side.append(row);
    const b = aiBox(ai.diff); if (b) side.append(b);
  }
  if (compare) {
    const d = diffOf(compare, scope);
    side.append(el('h3', `Comparaison avec ${compare.ref}`));
    side.append(el('div', `+${d.addedNodes.length} / −${d.removedNodes.length} nœud(s), +${d.addedLinks.length} / −${d.removedLinks.length} lien(s). Vert = ajouté, rouge = supprimé (fantôme).`, 'path'));
    if (d.addedNodes.length) list('Ajoutés', d.addedNodes, (id) => nodeLink(id), 15);
    if (d.removedNodes.length) list('Supprimés', d.removedNodes.map((n) => n.id), (id) => el('span', id), 15);
  }
  if (scope === 'files') {
    if (data.rulesError) side.append(el('h3', "Règles d'architecture"), el('div', data.rulesError, 'box err'));
    else if (data.violations.length) {
      side.append(el('h3', `Violations d'architecture (${data.violations.length})`));
      const ul = el('ul');
      for (const x of data.violations.slice(0, 30)) {
        const li = el('li'); li.append(el('span', x.rule + ' : '), nodeLink(x.source), el('span', ' → '), nodeLink(x.target)); ul.append(li);
      }
      side.append(ul);
    }
  }
}

function renderSuggestions(): void {
  side.append(el('h3', 'Simulations suggérées (IA)'));
  const s = ai.suggest;
  if (!s) return;
  const b = aiBox(s.items ? undefined : s); if (b && !s.items) side.append(b);
  for (const it of s.items ?? []) {
    const d = el('div', undefined, 'box');
    const t = el('div'); t.append(nodeLink(it.file, it.title)); d.append(t, el('div', it.why), el('div', '✔ ' + it.check));
    d.addEventListener('click', () => { if (scope !== 'files') setScope('files'); select(it.file); focusNode(it.file); });
    side.append(d);
  }
}

function renderSide(): void {
  side.replaceChildren();
  if (!data || !view) return;
  renderOverlays();
  if (ai.suggest) renderSuggestions();

  if (selected) {
    const n = view.nodes.find((x) => x.id === selected);
    side.append(el('h3', 'Simulation de panne'));
    const p = el('div', undefined, 'path'); p.append(el('span', selected, n?.kind === 'folder' ? undefined : 'link')); 
    if (n && n.kind !== 'folder' && n.kind !== 'package') p.firstElementChild?.addEventListener('click', () => openNode(n));
    side.append(p);
    if (n?.nest) {
      side.append(el('div', `@Module ${n.nest.name}`, 'path'));
      const nl = (t: string, a: string[]) => { if (a.length) side.append(el('div', `${t} : ${a.join(', ')}`, 'path')); };
      nl('providers', n.nest.providers); nl('controllers', n.nest.controllers); nl('exports', n.nest.exports); nl('modules externes', n.nest.externalImports);
    }
    side.append(el('div', `Si ce nœud casse, ${fImpact.size} autre(s) sont impactés (directement ou non).`));
    const inc = incidentByNode.get(selected);
    if (inc) { side.append(el('h3', 'Incidents connus')); const ul = el('ul'); inc.forEach((i) => { const li = el('li'); li.append(el('span', `[${i.severity ?? '?'}] `), openLink(i.file, i.line, i.title)); ul.append(li); }); side.append(ul); }
    if (n && n.kind !== 'folder') {
      const key = scope + ':' + selected;
      side.append(btn('Résumer avec l\'IA', () => { ai.summaries.set(key, { loading: true }); renderSide(); vscode.postMessage({ type: 'summarize', id: selected, scope }); }, 'Utilise un modèle de VS Code (Copilot) ou copie le prompt'));
      const b = aiBox(ai.summaries.get(key)); if (b) side.append(b);
    }
    list('Impactés', [...fImpact].sort(), (id) => nodeLink(id));
    list('Dépend de', view.dependencies.get(selected) ?? [], (id) => nodeLink(id));
    return;
  }

  const lg = el('div', undefined, 'legend');
  const legend: [string, string][] = [
    ['Module', KIND_COLOR.module], ['Controller', KIND_COLOR.controller], ['Service', KIND_COLOR.service], ['Vue', KIND_COLOR.vue],
    ['Svelte', KIND_COLOR.svelte], ['Dossier', KIND_COLOR.folder], ['Package', KIND_COLOR.package], ['Autre', KIND_COLOR.other],
    ['Cycle', COL_CYCLE], ['Incident', COL_INCIDENT], ['Violation', COL_VIOLATION], ['Modifié', COL_CHANGED],
    ['Impacté', COL_IMPACT], ['Ajouté', COL_ADDED], ['Supprimé', COL_REMOVED], ['Fichier actif', COL_ACTIVE],
  ];
  for (const [name, color] of legend) { const s = el('span'); const d = el('span', undefined, 'dot'); d.style.background = color; s.append(d, name); lg.append(s); }
  side.append(el('h3', 'Légende'), lg);
  side.append(el('div',
    "Une flèche va du fichier qui importe vers celui qui est importé. Clic : simuler la panne. Clic droit : ouvrir (ou déplier un dossier). " +
    'En 2D/3D, la taille = nombre de dépendants.', 'path'));
  if (scope === 'files' && !data.hasRules && !data.rulesError) side.append(el('div', "Astuce : crée un fichier .depgraph-rules.json pour définir des règles d'architecture (voir le README).", 'path'));

  if (data.incidents.length && scope === 'files') {
    side.append(el('h3', `Incidents (${data.incidents.length})`));
    const ul = el('ul');
    for (const i of data.incidents) {
      const li = el('li'); li.append(el('span', `[${i.severity ?? '?'}] ${i.title} — `)); const f = nodeLink(view.disp(i.file), i.file); li.append(f); ul.append(li);
    }
    side.append(ul);
  }
  const cyc = view.cycles.filter((c) => c.length > 1);
  if (cyc.length) {
    side.append(el('h3', `Cycles (${cyc.length})`));
    cyc.slice(0, 15).forEach((c, k) => {
      side.append(el('div', `Cycle ${k + 1} (${c.length})`, 'path'));
      const ul = el('ul'); c.forEach((f) => { const li = el('li'); li.append(nodeLink(f)); ul.append(li); }); side.append(ul);
    });
  }
  const top = [...view.nodes].filter((n) => (view!.inDegree.get(n.id) ?? 0) > 0).sort((a, b) => view!.inDegree.get(b.id)! - view!.inDegree.get(a.id)!).slice(0, 8);
  if (top.length) {
    side.append(el('h3', 'Les plus importés'));
    const ul = el('ul'); top.forEach((n) => { const li = el('li'); li.append(nodeLink(n.id), el('span', ` (${view!.inDegree.get(n.id)})`)); ul.append(li); }); side.append(ul);
  }
}

// ---------- export ----------
const clean = (c: string): string => (c.length === 9 && c.startsWith('#') ? c.slice(0, 7) : c);

function exportView(fmt: string): void {
  if (!graph || !view) return;
  const pos = new Map<string, any>(graph.graphData().nodes.map((n: any) => [n.id, n]));
  const mctx = document.createElement('canvas').getContext('2d')!;
  const nodes: ExNode[] = view.nodes.filter((n) => pos.has(n.id)).map((n) => {
    const p = pos.get(n.id);
    const rs = rings(n);
    if (mode === 'tree') { const b = boxLabel(mctx, n.label); return { id: n.id, label: b.text, x: p.x, y: p.y, w: b.w, h: BOX_H, shape: 'box', fill: clean(nodeColor(n)), text: '#101010', ring: rs[0] }; }
    const r = radius2D(n);
    return { id: n.id, label: n.label, x: p.x, y: p.y, w: r * 2, h: r * 2, shape: 'circle', fill: clean(nodeColor(n)), text: '#101010', ring: rs[0] };
  });
  const links: ExLink[] = view.links.map((l) => {
    const s = l.source, t = l.target, k = lk(s, t);
    return { s, t, color: clean(linkColor({ source: s, target: t, removed: (l as any).removed })), dashed: removedLinks.has(k) || !!(l as any).removed, width: linkWidth({ source: s, target: t }) };
  });
  const base = `${project || 'graph'}-${scope}`;
  if (fmt === 'mermaid') {
    const cls = (n: GNode): string | undefined =>
      n.id === activeFile ? 'active' : n.ghost || removedD.has(n.id) ? 'removed' : addedD.has(n.id) ? 'added' : changedD.has(n.id) ? 'changed' : cImpactD.has(n.id) ? 'impact'
        : violNodes.has(n.id) ? 'violation' : incidentByNode.has(n.id) ? 'incident' : view!.cyclic.has(n.id) ? 'cycle' : undefined;
    const mn: MNode[] = view.nodes.map((n) => ({ id: n.id, label: n.label, cls: cls(n) }));
    const ml: MLink[] = view.links.map((l) => {
      const k = lk(l.source, l.target);
      return { s: l.source, t: l.target, kind: removedLinks.has(k) || (l as any).removed ? 'removed' : addedLinks.has(k) ? 'added' : violLinks.has(k) ? 'violation' : undefined };
    });
    vscode.postMessage({ type: 'save', filename: base + '.md', text: toMermaid(`Dépendances — ${project} (${scope})`, mn, ml) });
    return;
  }
  const bg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
  const svg = toSvg(nodes, links, bg, fgColor());
  if (fmt === 'svg') { vscode.postMessage({ type: 'save', filename: base + '.svg', text: svg }); return; }
  const img = new Image();
  img.onload = () => {
    const sc = 2, c = document.createElement('canvas');
    c.width = Math.min(8000, img.width * sc); c.height = Math.min(8000, img.height * sc);
    const cx = c.getContext('2d')!; cx.drawImage(img, 0, 0, c.width, c.height);
    vscode.postMessage({ type: 'save', filename: base + '.png', base64: c.toDataURL('image/png').split(',')[1] });
  };
  img.onerror = () => vscode.postMessage({ type: 'copy', text: '' });
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// ---------- barre d'outils ----------
function setMode(m: Mode): void {
  mode = m;
  ['tree', '2d', '3d'].forEach((k) => $('m' + k).classList.toggle('on', k === m));
  render();
}
function setScope(s: Scope): void {
  scope = s; selected = null; matches = new Set();
  $<HTMLSelectElement>('scope').value = s;
  render();
}
$('mtree').addEventListener('click', () => setMode('tree'));
$('m2d').addEventListener('click', () => setMode('2d'));
$('m3d').addEventListener('click', () => setMode('3d'));
$('arrange').addEventListener('click', arrange);
$('scope').addEventListener('change', (e) => setScope((e.target as HTMLSelectElement).value as Scope));
$('bdiff').addEventListener('click', () => vscode.postMessage({ type: 'requestDiff' }));
$('bcmp').addEventListener('click', () => vscode.postMessage({ type: 'requestCompare' }));
$('bclear').addEventListener('click', () => { changes = null; compare = null; ai.diff = null; render(true); });
$('bsug').addEventListener('click', () => { ai.suggest = { loading: true }; renderSide(); vscode.postMessage({ type: 'suggest' }); });
$<HTMLSelectElement>('export').addEventListener('change', (e) => {
  const s = e.target as HTMLSelectElement; const v = s.value; s.value = ''; if (v) exportView(v);
});
$('ffollow').addEventListener('change', () => { if ($<HTMLInputElement>('ffollow').checked && activeFile) focusNode(activeFile); });

const KIND_LABEL: Record<string, string> = { module: 'Module', controller: 'Controller', service: 'Service', vue: 'Vue', svelte: 'Svelte', other: 'Autre' };
const kindBoxes: HTMLInputElement[] = [];
for (const k of ALL_KINDS) {
  const lab = el('label', undefined, 'chk');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
  cb.addEventListener('change', () => { if (cb.checked) filters.kinds.add(k); else filters.kinds.delete(k); scheduleRender(); });
  const dot = el('span', undefined, 'dot'); dot.style.background = KIND_COLOR[k];
  lab.append(dot, KIND_LABEL[k], cb); $('kinds').append(lab); kindBoxes.push(cb);
}
const fpath = $<HTMLInputElement>('fpath'), fshared = $<HTMLInputElement>('fshared'), fiso = $<HTMLInputElement>('fiso'), ftests = $<HTMLInputElement>('ftests');
fpath.addEventListener('input', () => { filters.path = fpath.value; scheduleRender(); });
fshared.addEventListener('input', () => { filters.maxShared = Math.max(0, parseInt(fshared.value, 10) || 0); scheduleRender(); });
fiso.addEventListener('change', () => { filters.hideIsolated = fiso.checked; scheduleRender(); });
ftests.addEventListener('change', () => { filters.hideTests = ftests.checked; scheduleRender(); });
$('fgroup').addEventListener('change', (e) => { groupDepth = parseInt((e.target as HTMLSelectElement).value, 10) || 0; expanded.clear(); selected = null; render(); });
$('freset').addEventListener('click', () => {
  filters.kinds = new Set(ALL_KINDS); filters.path = ''; filters.maxShared = 0; filters.hideIsolated = false;
  kindBoxes.forEach((c) => (c.checked = true));
  fpath.value = ''; fshared.value = '0'; fiso.checked = false; expanded.clear();
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

let initialized = false;
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'graph') {
    data = m.graph as Graph; project = m.project ?? '';
    gitAvailable = !!m.settings?.git;
    if (!initialized) {
      initialized = true;
      filters.hideTests = m.settings?.hideTests ?? true; ftests.checked = filters.hideTests;
      $<HTMLInputElement>('ffollow').checked = !!m.settings?.followActive;
    }
    $('bdiff').toggleAttribute('disabled', !gitAvailable); $('bcmp').toggleAttribute('disabled', !gitAvailable);
    if (!m.refresh) { selected = null; matches = new Set(); changes = null; compare = null; }
    // Après un rafraîchissement, les surcouches Git deviennent périmées : on les retire
    else if (changes || compare) { changes = null; compare = null; }
    render(!!m.refresh);
  } else if (m.type === 'active') {
    const id = nodeForFile(m.file);
    activeFile = id;
    applyStyles();
    if (id && $<HTMLInputElement>('ffollow').checked && graph) focusNode(id);
  } else if (m.type === 'changes') {
    changes = m.set as ChangeSet; compare = null; selected = null; ai.diff = null;
    render(true);
  } else if (m.type === 'compare') {
    compare = m.data as CompareResult; changes = null; selected = null; render(true);
  } else if (m.type === 'ai') {
    const box: AiBox = m.error ? { error: m.error, copied: m.copied } : { text: m.text, model: m.model };
    if (m.kind === 'summary') ai.summaries.set(m.scope + ':' + m.id, box);
    else if (m.kind === 'suggest') ai.suggest = m.items ? { items: m.items as Suggestion[] } : box;
    else if (m.kind === 'diff') ai.diff = box;
    if (m.cancelled) { if (m.kind === 'summary') ai.summaries.delete(m.scope + ':' + m.id); else if (m.kind === 'suggest') ai.suggest = null; else ai.diff = null; }
    renderSide();
  }
});
vscode.postMessage({ type: 'ready' });
