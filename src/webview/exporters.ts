export interface ExNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'box' | 'circle';
  fill: string;
  text: string;
  ring?: string;
}

export interface ExLink {
  s: string;
  t: string;
  color: string;
  dashed?: boolean;
  width?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Point où le segment centre→centre coupe le bord du nœud `n` (côté `o`). */
function boundary(n: ExNode, o: ExNode): { x: number; y: number } {
  const dx = o.x - n.x, dy = o.y - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  if (n.shape === 'circle') {
    const d = Math.hypot(dx, dy);
    return { x: n.x + (dx * n.w) / 2 / d, y: n.y + (dy * n.w) / 2 / d };
  }
  const k = Math.min(dx ? n.w / 2 / Math.abs(dx) : Infinity, dy ? n.h / 2 / Math.abs(dy) : Infinity);
  return { x: n.x + dx * k, y: n.y + dy * k };
}

/** SVG autonome de la vue (formes et positions identiques à l'écran). */
export function toSvg(nodes: ExNode[], links: ExLink[], bg: string, fg: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pad = 30;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.w / 2); x1 = Math.max(x1, n.x + n.w / 2);
    y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2 + (n.shape === 'circle' ? 16 : 0));
  }
  if (!nodes.length) { x0 = y0 = 0; x1 = y1 = 100; }
  const W = x1 - x0 + pad * 2, H = y1 - y0 + pad * 2;

  const colors = [...new Set(links.map((l) => l.color))];
  const markers = colors
    .map((c, i) => `<marker id="a${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${esc(c)}"/></marker>`)
    .join('');

  const lines = links
    .map((l) => {
      const s = byId.get(l.s), t = byId.get(l.t);
      if (!s || !t) return '';
      const p = boundary(s, t), q = boundary(t, s);
      const dash = l.dashed ? ' stroke-dasharray="5 4"' : '';
      return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${esc(l.color)}" stroke-width="${l.width ?? 1}"${dash} marker-end="url(#a${colors.indexOf(l.color)})"/>`;
    })
    .join('\n');

  const shapes = nodes
    .map((n) => {
      const ring = n.ring ? ` stroke="${esc(n.ring)}" stroke-width="2"` : '';
      if (n.shape === 'box') {
        return `<rect x="${(n.x - n.w / 2).toFixed(1)}" y="${(n.y - n.h / 2).toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h}" rx="4" fill="${esc(n.fill)}"${ring}/>` +
          `<text x="${n.x.toFixed(1)}" y="${(n.y + 0.5).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="11" fill="${esc(n.text)}">${esc(n.label)}</text>`;
      }
      return `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.w / 2).toFixed(1)}" fill="${esc(n.fill)}"${ring}/>` +
        `<text x="${n.x.toFixed(1)}" y="${(n.y + n.h / 2 + 12).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="${esc(fg)}">${esc(n.label)}</text>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${W.toFixed(1)} ${H.toFixed(1)}" width="${Math.round(W)}" height="${Math.round(H)}">
<defs>${markers}</defs>
<rect x="${(x0 - pad).toFixed(1)}" y="${(y0 - pad).toFixed(1)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="${esc(bg)}"/>
${lines}
${shapes}
</svg>
`;
}

export interface MNode { id: string; label: string; cls?: string }
export interface MLink { s: string; t: string; kind?: 'added' | 'removed' | 'violation' | 'impact' }

const MERMAID_STYLES: Record<string, string> = {
  root: 'fill:#ffffff,stroke:#333,color:#111',
  changed: 'fill:#ffd43b,stroke:#333,color:#111',
  impact: 'fill:#ffa733,stroke:#333,color:#111',
  added: 'fill:#3fb950,stroke:#333,color:#111',
  removed: 'fill:#f85149,stroke:#333,color:#fff,stroke-dasharray:4 3',
  violation: 'fill:#9b5de5,stroke:#333,color:#fff',
  incident: 'fill:#f14c4c,stroke:#333,color:#fff',
  cycle: 'fill:#ff4fd8,stroke:#333,color:#111',
  active: 'fill:#00e5ff,stroke:#333,color:#111',
};
const LINK_COLOR: Record<string, string> = { added: '#3fb950', removed: '#f85149', violation: '#9b5de5', impact: '#ffa733' };

/** Diagramme Mermaid dans un fichier Markdown : GitHub l'affiche directement (README, pull request). */
export function toMermaid(title: string, nodes: MNode[], links: MLink[]): string {
  const idx = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const out: string[] = ['```mermaid', 'graph TD'];
  for (const n of nodes) out.push(`  ${idx.get(n.id)}["${n.label.replace(/"/g, "'")}"]`);
  const styled: { i: number; kind: string }[] = [];
  let li = 0;
  for (const l of links) {
    const s = idx.get(l.s), t = idx.get(l.t);
    if (!s || !t) continue;
    out.push(`  ${s} ${l.kind === 'removed' ? '-.->' : '-->'} ${t}`);
    if (l.kind) styled.push({ i: li, kind: l.kind });
    li++;
  }
  const byCls = new Map<string, string[]>();
  for (const n of nodes) if (n.cls) byCls.set(n.cls, [...(byCls.get(n.cls) ?? []), idx.get(n.id)!]);
  for (const [cls, ids] of byCls) {
    out.push(`  classDef ${cls} ${MERMAID_STYLES[cls] ?? 'fill:#ddd'}`);
    out.push(`  class ${ids.join(',')} ${cls}`);
  }
  for (const s of styled) out.push(`  linkStyle ${s.i} stroke:${LINK_COLOR[s.kind]},stroke-width:2px`);
  out.push('```');
  const warn = nodes.length > 300 ? '\n> Grand graphe : Mermaid peut refuser de l\'afficher au-delà de quelques centaines de nœuds. Filtre ou regroupe avant d\'exporter.\n' : '';
  return `# ${title}\n${warn}\n${out.join('\n')}\n`;
}
