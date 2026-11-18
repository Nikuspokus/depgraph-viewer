import { GNode, Graph, Layer } from './shared/types';
import { impactSizes, reverseAdj } from './shared/graph';

export interface Prompt {
  system: string;
  user: string;
}

const SYSTEM =
  "Tu es un assistant de revue d'architecture logicielle. Réponds en français, de façon concise et technique, " +
  "et définis brièvement les termes techniques peu courants. N'invente aucun fichier : appuie-toi uniquement sur les données fournies.";

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '\n… (tronqué)' : s);

/** Résumé d'un fichier ou d'un module : rôle, dépendances, risque si on le modifie. */
export function summaryPrompt(args: {
  node: GNode;
  dependsOn: string[];
  importedBy: string[];
  content: string;
}): Prompt {
  const { node, dependsOn, importedBy, content } = args;
  const nest = node.nest
    ? `Module NestJS ${node.nest.name} — providers : ${node.nest.providers.join(', ') || 'aucun'} ; controllers : ${node.nest.controllers.join(', ') || 'aucun'} ; exports : ${node.nest.exports.join(', ') || 'aucun'} ; modules externes : ${node.nest.externalImports.join(', ') || 'aucun'}.\n`
    : '';
  return {
    system: SYSTEM,
    user:
      `Fichier : ${node.file ?? node.id}\n${nest}` +
      `Il dépend de ${dependsOn.length} fichier(s) : ${dependsOn.slice(0, 15).join(', ') || 'aucun'}.\n` +
      `${importedBy.length} fichier(s) en dépendent : ${importedBy.slice(0, 15).join(', ') || 'aucun'}.\n\n` +
      `Contenu :\n\`\`\`\n${clip(content, 12000)}\n\`\`\`\n\n` +
      "Résume en 2 à 3 phrases le rôle de ce fichier, puis en une phrase le risque principal si on le modifie, vu ses dépendants.",
  };
}

export interface Digest {
  stats: Graph['stats'];
  topImpact: { file: string; dependents: number }[];
  cycles: string[][];
  violations: { rule: string; source: string; target: string }[];
  incidents: { file: string; title: string; severity?: string }[];
  nestModules: { name: string; file: string; imports: number; providers: number; controllers: number }[];
}

/** Version compacte du graphe, assez petite pour être envoyée à un modèle. */
export function buildDigest(g: Graph): Digest {
  const real = g.files.nodes.filter((n) => !n.isTest);
  const ids = real.map((n) => n.id);
  const idSet = new Set(ids);
  const links = g.files.links.filter((l) => idSet.has(l.source) && idSet.has(l.target));
  const sizes = impactSizes(ids, links);
  const outDeg = new Map<string, number>();
  for (const l of g.nest.links) outDeg.set(l.source, (outDeg.get(l.source) ?? 0) + 1);
  return {
    stats: g.stats,
    topImpact: [...sizes.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([file, dependents]) => ({ file, dependents })),
    cycles: g.files.cycles.slice(0, 5),
    violations: g.violations.slice(0, 10),
    incidents: g.incidents.slice(0, 10).map(({ file, title, severity }) => ({ file, title, severity })),
    nestModules: g.nest.nodes.slice(0, 20).map((n) => ({
      name: n.label, file: n.file ?? n.id, imports: outDeg.get(n.id) ?? 0,
      providers: n.nest?.providers.length ?? 0, controllers: n.nest?.controllers.length ?? 0,
    })),
  };
}

export function suggestPrompt(d: Digest): Prompt {
  return {
    system: SYSTEM,
    user:
      "Voici un résumé de l'architecture d'un projet (JSON) :\n```json\n" + JSON.stringify(d, null, 1) + "\n```\n\n" +
      "Propose 5 scénarios de simulation de panne à étudier en priorité (« et si ce fichier tombe ? »), en t'appuyant sur les fichiers " +
      "les plus impactants, les cycles, les violations d'architecture et les incidents. " +
      'Réponds UNIQUEMENT par un tableau JSON de 5 objets {"file": "...", "title": "...", "why": "...", "check": "..."} : ' +
      '"file" doit être un chemin présent dans les données, "title" un titre court, "why" pourquoi ce scénario est risqué (1 phrase), ' +
      '"check" ce qu\'il faut vérifier ou tester (1 phrase).',
  };
}

export interface Suggestion {
  file: string;
  title: string;
  why: string;
  check: string;
}

/** Extrait le tableau JSON de la réponse (même entouré de texte ou de ```), en ne gardant que des fichiers connus. */
export function parseSuggestions(text: string, known: Set<string>): Suggestion[] | null {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(arr)) return null;
    const items = arr
      .filter((x) => x && typeof x.file === 'string' && typeof x.title === 'string' && known.has(x.file))
      .map((x) => ({ file: x.file, title: String(x.title), why: String(x.why ?? ''), check: String(x.check ?? '') }));
    return items.length ? items : null;
  } catch {
    return null;
  }
}

/** Analyse de risque d'un ensemble de modifications Git. */
export function diffPrompt(args: { label: string; changed: string[]; impacted: string[]; tests: string[] }): Prompt {
  const { label, changed, impacted, tests } = args;
  return {
    system: SYSTEM,
    user:
      `Contexte : ${label}.\n` +
      `Fichiers modifiés (${changed.length}) : ${changed.slice(0, 40).join(', ')}\n` +
      `Fichiers impactés indirectement (${impacted.length}) : ${impacted.slice(0, 40).join(', ') || 'aucun'}\n` +
      `Tests concernés (${tests.length}) : ${tests.slice(0, 40).join(', ') || 'aucun'}\n\n` +
      "Évalue le risque de ces modifications (faible / moyen / élevé) avec une justification courte, " +
      "indique les 3 zones les plus sensibles à relire, et ce qu'il faudrait tester en plus des tests listés.",
  };
}

/** Liste des fichiers qui dépendent d'un nœud, directement (pour le résumé). */
export function directRelations(layer: Layer, id: string): { dependsOn: string[]; importedBy: string[] } {
  const rev = reverseAdj(layer.nodes.map((n) => n.id), layer.links);
  return {
    dependsOn: layer.links.filter((l) => l.source === id).map((l) => l.target),
    importedBy: rev.get(id) ?? [],
  };
}
