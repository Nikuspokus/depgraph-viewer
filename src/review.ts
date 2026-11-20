// Revue d'impact avant une PR : fichiers touchés, tests à relancer, projets impactés,
// nouveaux problèmes introduits (par rapport à la base) et points chauds. Sans dépendance à VS Code.
import { ChangeMode, baseRefOf, changedFiles, churnByFile, scanRef } from './git';
import { scan, ScanOptions } from './scanner';
import { impactOf, reverseAdj } from './shared/graph';
import { projectsOf } from './shared/projects';
import { Graph, Layer, Violation } from './shared/types';

export interface RiskInfo { score: number; impact: number; churn: number; inCycle: boolean; untested: boolean }
export interface RiskyFile extends RiskInfo { file: string }

export interface Delta {
  newCycles: string[][];
  fixedCycles: number;
  newViolations: Violation[];
  fixedViolations: number;
  newOrphans: string[]; // providers devenus « probablement inutilisés »
}

export interface Review {
  label: string;
  base: string;
  changed: string[];
  impacted: string[];
  tests: string[];
  projects: { changed: string[]; impacted: string[] };
  delta: Delta;
  risky: RiskyFile[];
}

const logN = (x: number, max: number): number => (max > 0 ? Math.log1p(x) / Math.log1p(max) : 0);

/**
 * Score de risque 0-100 par fichier : impact (combien de fichiers en dépendent, 40 %), churn (fréquence de
 * modification récente, 30 %), appartenance à un cycle (15 %) et absence de test qui l'atteigne (15 %).
 */
export function computeRisk(layer: Layer, churn: Map<string, number>): Map<string, RiskInfo> {
  const ids = layer.nodes.map((n) => n.id);
  const isTest = new Set(layer.nodes.filter((n) => n.isTest).map((n) => n.id));
  const rev = reverseAdj(ids, layer.links);
  const cyc = new Set(layer.cycles.flat());
  const rows = layer.nodes.filter((n) => !n.isTest).map((n) => {
    const imp = impactOf(rev, [n.id]);
    const impact = [...imp].filter((x) => !isTest.has(x)).length;
    const tested = [...imp].some((x) => isTest.has(x));
    return { id: n.id, impact, churn: churn.get(n.id) ?? 0, inCycle: cyc.has(n.id), untested: impact > 0 && !tested };
  });
  const maxImpact = Math.max(0, ...rows.map((r) => r.impact));
  const maxChurn = Math.max(0, ...rows.map((r) => r.churn));
  const out = new Map<string, RiskInfo>();
  for (const r of rows) {
    const score = 100 * (0.4 * logN(r.impact, maxImpact) + 0.3 * logN(r.churn, maxChurn) + 0.15 * (r.inCycle ? 1 : 0) + 0.15 * (r.untested ? 1 : 0));
    out.set(r.id, { score: Math.round(score), impact: r.impact, churn: r.churn, inCycle: r.inCycle, untested: r.untested });
  }
  return out;
}

const cycleKey = (c: string[]): string => [...c].sort().join('|');

/** Ce que la branche ajoute (ou corrige) par rapport à la base : l'ancienne dette n'est pas comptée. */
export function newProblems(cur: Graph, base: Graph): Delta {
  const baseSets = base.files.cycles.map((c) => new Set(c));
  const isNew = (c: string[]): boolean => !baseSets.some((b) => c.every((x) => b.has(x)));
  const curSets = cur.files.cycles.map((c) => new Set(c));
  const stillThere = (c: string[]): boolean => curSets.some((s) => c.every((x) => s.has(x)));
  const vKey = (v: Violation): string => `${v.rule}\u0000${v.source}\u0000${v.target}`;
  const baseV = new Set(base.violations.map(vKey));
  const curV = new Set(cur.violations.map(vKey));
  const baseOrphans = new Set(base.nestClasses.nodes.filter((n) => n.orphan).map((n) => n.id));
  return {
    newCycles: cur.files.cycles.filter(isNew),
    fixedCycles: base.files.cycles.filter((c) => !stillThere(c)).length,
    newViolations: cur.violations.filter((v) => !baseV.has(vKey(v))),
    fixedViolations: base.violations.filter((v) => !curV.has(vKey(v))).length,
    newOrphans: cur.nestClasses.nodes.filter((n) => n.orphan && !baseOrphans.has(n.id)).map((n) => n.id),
  };
}

export async function buildReview(root: string, mode: ChangeMode, opts: ScanOptions): Promise<Review> {
  const set = await changedFiles(root, mode);
  const cur = scan(root, opts);
  const baseRef = await baseRefOf(root, mode);
  const base = baseRef ? await scanRef(root, baseRef, opts) : cur;
  const layer = cur.files;
  const changedSet = new Set(set.files);
  const roots = layer.nodes.filter((n) => changedSet.has(n.id)).map((n) => n.id);
  const impacted = impactOf(reverseAdj(layer.nodes.map((n) => n.id), layer.links), roots);
  const isTest = new Set(layer.nodes.filter((n) => n.isTest).map((n) => n.id));
  const tests = [...new Set([...roots, ...impacted])].filter((id) => isTest.has(id)).sort();
  const risk = computeRisk(layer, await churnByFile(root));
  const risky = roots
    .filter((id) => risk.has(id))
    .map((id) => ({ file: id, ...risk.get(id)! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    label: set.label,
    base: baseRef || '(aucun commit)',
    changed: set.files,
    impacted: [...impacted].filter((x) => !isTest.has(x)).sort(),
    tests,
    projects: projectsOf(cur.packages, set.files),
    delta: newProblems(cur, base),
    risky,
  };
}

/** Résumé Markdown, à coller dans la description d'une pull request. */
export function reviewMarkdown(r: Review): string {
  const L: string[] = [`## Revue d'impact — ${r.label}`, ''];
  L.push(`- **${r.changed.length}** fichier(s) modifié(s), **${r.impacted.length}** fichier(s) impacté(s), **${r.tests.length}** test(s) à relancer.`);
  if (r.projects.changed.length) {
    L.push(`- Projets touchés : ${r.projects.changed.map((p) => `\`${p}\``).join(', ')}`);
    if (r.projects.impacted.length) L.push(`- Projets dépendants à retester : ${r.projects.impacted.map((p) => `\`${p}\``).join(', ')}`);
  }
  const d = r.delta;
  L.push('', '### Nouveaux problèmes (par rapport à la base)');
  if (!d.newCycles.length && !d.newViolations.length && !d.newOrphans.length) L.push('Aucun nouveau cycle, aucune nouvelle violation, aucun nouveau provider inutilisé.');
  for (const c of d.newCycles) L.push(`- Cycle d'imports : ${c.map((f) => `\`${f}\``).join(' ↔ ')}`);
  for (const v of d.newViolations) L.push(`- Violation « ${v.rule} » : \`${v.source}\` → \`${v.target}\``);
  for (const o of d.newOrphans) L.push(`- Provider probablement inutilisé : \`${o}\``);
  if (d.fixedCycles || d.fixedViolations) L.push('', `Corrigés par cette branche : ${d.fixedCycles} cycle(s), ${d.fixedViolations} violation(s).`);
  if (r.risky.length) {
    L.push('', '### Points chauds (fichiers modifiés les plus risqués)');
    for (const f of r.risky) {
      const why = [`${f.impact} dépendant(s)`, `${f.churn} commit(s)/90 j`, f.inCycle ? 'dans un cycle' : '', f.untested ? 'aucun test ne l\'atteint' : ''].filter(Boolean).join(', ');
      L.push(`- \`${f.file}\` — risque ${f.score}/100 (${why})`);
    }
  }
  if (r.tests.length) L.push('', '### Tests à relancer', ...r.tests.map((t) => `- \`${t}\``));
  return L.join('\n') + '\n';
}
