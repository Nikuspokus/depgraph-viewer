import { impactOf, reverseAdj } from './graph';
import { Layer } from './types';

/** Projets (packages d'un monorepo) touchés par des fichiers modifiés, puis ceux qui en dépendent. */
export function projectsOf(packages: Layer, changed: string[]): { changed: string[]; impacted: string[] } {
  if (!packages.nodes.length) return { changed: [], impacted: [] };
  const specific = packages.nodes.filter((q) => q.id !== '.');
  const touched = packages.nodes
    .filter((p) => changed.some((f) => p.id === '.' || f === p.id || f.startsWith(p.id + '/')))
    // le package racine (".") englobe tout : on ne le garde que si un fichier n'est couvert par aucun package plus précis
    .filter((p) => p.id !== '.' || changed.some((f) => !specific.some((q) => f.startsWith(q.id + '/'))))
    .map((p) => p.id);
  const imp = impactOf(reverseAdj(packages.nodes.map((n) => n.id), packages.links), touched);
  return { changed: touched.sort(), impacted: [...imp].sort() };
}
