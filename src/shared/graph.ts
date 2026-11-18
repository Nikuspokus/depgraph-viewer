import { GLink } from './types';

/** Pour chaque nœud, la liste de ceux qui en dépendent (liens inversés). */
export function reverseAdj(ids: string[], links: GLink[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const id of ids) rev.set(id, []);
  for (const l of links) rev.get(l.target)?.push(l.source);
  return rev;
}

/** Tout ce qui dépend (même indirectement) d'au moins un des nœuds `roots`, sans compter les racines. */
export function impactOf(rev: Map<string, string[]>, roots: string[]): Set<string> {
  const rootSet = new Set(roots);
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const d of rev.get(cur) ?? []) {
      if (!seen.has(d) && !rootSet.has(d)) { seen.add(d); queue.push(d); }
    }
  }
  return seen;
}

/** Composantes fortement connexes (Tarjan, itératif) de taille > 1 = cycles. */
export function findCycles(ids: string[], links: GLink[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const l of links) adj.get(l.source)?.push(l.target);

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  for (const start of ids) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      const nbrs = adj.get(frame.v) ?? [];
      if (frame.i < nbrs.length) {
        const w = nbrs[frame.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        }
      } else {
        if (low.get(frame.v) === idx.get(frame.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          if (comp.length > 1) result.push(comp.sort());
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
      }
    }
  }
  return result;
}

/** Taille de l'impact (nombre de dépendants directs et indirects) de chaque nœud. */
export function impactSizes(ids: string[], links: GLink[]): Map<string, number> {
  const rev = reverseAdj(ids, links);
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, impactOf(rev, [id]).size);
  return out;
}
