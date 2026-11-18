import * as path from 'path';
import { scan } from './scanner';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? '.');

if (flags.has('--help') || flags.has('-h')) {
  console.log(`depgraph-check [dossier] [options]

Analyse les imports d'un projet et vérifie les règles d'architecture (.depgraph-rules.json).

Options :
  --fail-on-cycles   échoue aussi s'il existe des cycles d'imports
  --json             sortie JSON (stats, violations, cycles)
  --help             cette aide

Code de sortie : 0 = OK, 1 = violation de règle (ou cycle avec --fail-on-cycles), 2 = erreur de configuration.`);
  process.exit(0);
}

const g = scan(dir);
const cycles = g.files.cycles;

if (flags.has('--json')) {
  console.log(JSON.stringify({ stats: g.stats, violations: g.violations, cycles, rulesError: g.rulesError }, null, 2));
} else {
  console.log(`${g.stats.files} fichiers, ${g.stats.links} liens, ${g.stats.nestModules} module(s) Nest, ${g.stats.packages} package(s).`);
  if (g.rulesError) console.error(`Règles invalides : ${g.rulesError}`);
  else if (!g.hasRules) console.log("Aucun fichier de règles (.depgraph-rules.json) : seules les analyses sont effectuées.");
  for (const v of g.violations) console.error(`✗ ${v.rule}\n    ${v.source}  →  ${v.target}`);
  if (g.violations.length) console.error(`\n${g.violations.length} violation(s) d'architecture.`);
  else if (g.hasRules) console.log('✓ Aucune violation d\'architecture.');
  if (cycles.length) console.log(`${cycles.length} cycle(s) d'imports :\n` + cycles.map((c) => '  - ' + c.join(' ↔ ')).join('\n'));
}

if (g.rulesError) process.exit(2);
process.exit(g.violations.length > 0 || (flags.has('--fail-on-cycles') && cycles.length > 0) ? 1 : 0);
