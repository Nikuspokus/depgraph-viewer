import { GLink, GNode } from '../shared/types';

export const BOX_H = 18;
export const BOX_FONT = 11;
export const MAX_LABEL_W = 170;

/** Texte (tronqué si besoin) et largeur de la boîte d'un nœud en mode organigramme. */
export function boxLabel(ctx: CanvasRenderingContext2D, label: string): { text: string; w: number } {
  ctx.font = `${BOX_FONT}px sans-serif`;
  let text = label;
  let w = ctx.measureText(text).width;
  if (w > MAX_LABEL_W) {
    text = label.slice(0, Math.max(3, Math.floor((label.length * MAX_LABEL_W) / w) - 1)) + '…';
    w = ctx.measureText(text).width;
  }
  return { text, w: w + 14 };
}

/** Disposition en couches : points d'entrée en haut, fichiers très partagés en bas. */
export function computeLayout(nodes: GNode[], links: GLink[]): Map<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of ids) { out.set(id, []); incoming.set(id, 0); }
  for (const l of links) {
    if (!out.has(l.source) || !out.has(l.target)) continue;
    out.get(l.source)!.push(l.target);
    incoming.set(l.target, (incoming.get(l.target) ?? 0) + 1);
  }

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

  // 2) Couches par plus long chemin.
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
  for (const n of nodes) maxW = Math.max(maxW, boxLabel(mctx, n.label).w);
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
