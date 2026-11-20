import * as path from 'path';
import { scan } from './scanner';
import { scanRef } from './git';
import { newProblems } from './review';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const baseIdx = args.indexOf('--base');
const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : undefined;
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && !(baseIdx >= 0 && i === baseIdx + 1)) ?? '.');

if (flags.has('--help') || flags.has('-h')) {
  console.log(`depgraph-check [dossier] [options]

Analyse les imports d'un projet et vérifie les règles d'architecture (.depgraph-rules.json).

Options :
  --base <ref>       ne compte que les NOUVEAUX problèmes par rapport à cette branche, ce tag ou ce commit
                     (ex. --base origin/main) : l'ancienne dette ne fait pas échouer la CI
  --fail-on-cycles   échoue aussi s'il existe des cycles d'imports (nouveaux avec --base)
  --json             sortie JSON (stats, violations, cycles)
  --help             cette aide

Code de sortie : 0 = OK, 1 = violation de règle (ou cycle avec --fail-on-cycles), 2 = erreur de configuration.`);
  process.exit(0);
}

async function main(): Promise<number> {
  const g = scan(dir);
  let violations = g.violations;
  let cycles = g.files.cycles;
  let scope = '';
  if (baseRef) {
    const d = newProblems(g, await scanRef(dir, baseRef, {}));
    violations = d.newViolations;
    cycles = d.newCycles;
    scope = ` (nouveaux depuis ${baseRef})`;
  }

  if (flags.has('--json')) {
    console.log(JSON.stringify({ stats: g.stats, base: baseRef ?? null, violations, cycles, rulesError: g.rulesError }, null, 2));
  } else {
    console.log(`${g.stats.files} fichiers, ${g.stats.links} liens, ${g.stats.nestModules} module(s) Nest, ${g.stats.packages} package(s).`);
    if (g.rulesError) console.error(`Règles invalides : ${g.rulesError}`);
    else if (!g.hasRules) console.log('Aucun fichier de règles (.depgraph-rules.json) : seules les analyses sont effectuées.');
    for (const v of violations) console.error(`✗ ${v.rule}\n    ${v.source}  →  ${v.target}`);
    if (violations.length) console.error(`\n${violations.length} violation(s) d'architecture${scope}.`);
    else if (g.hasRules) console.log(`✓ Aucune violation d'architecture${scope}.`);
    if (cycles.length) console.log(`${cycles.length} cycle(s) d'imports${scope} :\n` + cycles.map((c) => '  - ' + c.join(' ↔ ')).join('\n'));
  }

  if (g.rulesError) return 2;
  return violations.length > 0 || (flags.has('--fail-on-cycles') && cycles.length > 0) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(`Erreur : ${(e as Error).message}`); process.exit(2); },
);
