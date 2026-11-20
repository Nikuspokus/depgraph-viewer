// Tests automatisés : `npm test`. Pas de framework, juste node:assert.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = mkdtempSync(path.join(tmpdir(), 'depgraph-test-'));
async function load(entry, name) {
  const file = path.join(out, name + '.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: file, external: ['vscode'], logLevel: 'error' });
  return (await import(pathToFileURL(file).href)).default;
}
let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

const scanner = await load('src/scanner.ts', 'scanner');
const rules = await load('src/rules.ts', 'rules');
const mono = scanner.scan('test/fixtures/mono');
const files = mono.files;
const has = (l, s, t) => l.some((x) => x.source === s && x.target === t);

console.log('Analyse');
await ok('fichiers : alias de workspace (@mono/shared → index.ts via dist/ → src/)', () => {
  assert.ok(has(files.links, 'packages/api/src/users/users.service.ts', 'packages/shared/src/index.ts'));
  assert.ok(has(files.links, 'packages/web/src/main.ts', 'packages/shared/src/index.ts'));
});
await ok('fichiers : les tests sont inclus et marqués isTest', () => {
  const spec = files.nodes.find((n) => n.id.endsWith('users.service.spec.ts'));
  assert.equal(spec?.isTest, true);
  assert.equal(files.nodes.find((n) => n.id.endsWith('users.service.ts'))?.isTest, undefined);
});
await ok('nest : 3 modules, imports résolus, dynamiques et forwardRef compris', () => {
  assert.equal(mono.nest.nodes.length, 3);
  const L = mono.nest.links;
  assert.ok(has(L, 'packages/api/src/app.module.ts', 'packages/api/src/users/users.module.ts'));
  assert.ok(has(L, 'packages/api/src/app.module.ts', 'packages/api/src/auth/auth.module.ts'));
  assert.ok(has(L, 'packages/api/src/users/users.module.ts', 'packages/api/src/auth/auth.module.ts'));
  assert.ok(has(L, 'packages/api/src/auth/auth.module.ts', 'packages/api/src/users/users.module.ts'));
  assert.equal(L.length, 4);
});
await ok('nest : cycle users ↔ auth détecté', () => {
  assert.equal(mono.nest.cycles.length, 1);
  assert.deepEqual(mono.nest.cycles[0], ['packages/api/src/auth/auth.module.ts', 'packages/api/src/users/users.module.ts']);
});
await ok('nest : providers, controllers, exports, modules externes, ligne du décorateur', () => {
  const app = mono.nest.nodes.find((n) => n.label === 'AppModule');
  assert.deepEqual(app.nest.externalImports.sort(), ['ConfigModule', 'TypeOrmModule']);
  const users = mono.nest.nodes.find((n) => n.label === 'UsersModule');
  assert.deepEqual(users.nest.providers, ['UsersService', 'TOKEN']);
  assert.deepEqual(users.nest.controllers, ['UsersController']);
  assert.deepEqual(users.nest.exports, ['UsersService']);
  assert.equal(users.line, 6);
});
await ok('packages : 3 packages, liens agrégés, racine exclue car sans fichier', () => {
  const ids = mono.packages.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['packages/api', 'packages/shared', 'packages/web']);
  const web = mono.packages.links.filter((l) => l.source === 'packages/web');
  assert.deepEqual(web.map((l) => l.target).sort(), ['packages/api', 'packages/shared']);
  assert.equal(mono.packages.links.find((l) => l.source === 'packages/api' && l.target === 'packages/shared').w, 1);
});
await ok('règles : 2 violations détectées (front→back, controller→repository)', () => {
  assert.equal(mono.hasRules, true);
  const v = mono.violations.map((x) => `${x.source}>${x.target}`).sort();
  assert.deepEqual(v, [
    'packages/api/src/users/users.controller.ts>packages/api/src/users/user.repository.ts',
    'packages/web/src/main.ts>packages/api/src/users/users.service.ts',
  ]);
});
await ok('règles : globs ** * ? et dossiers', () => {
  const g = rules.globToRegExp;
  assert.ok(g('src/**/*.ts').test('src/a/b/c.ts') && g('src/**/*.ts').test('src/c.ts'));
  assert.ok(!g('src/*.ts').test('src/a/c.ts'));
  assert.ok(g('src/front').test('src/front/x/y.ts') && !g('src/front').test('src/frontend/x.ts'));
  assert.ok(g('**/*.controller.ts').test('a/b/x.controller.ts'));
});
await ok('règles : onlyTo et fichier invalide', () => {
  const v = rules.checkRules([{ name: 'r', from: ['a/**'], onlyTo: ['shared/**'] }], [
    { source: 'a/x.ts', target: 'shared/y.ts' }, { source: 'a/x.ts', target: 'b/z.ts' }, { source: 'a/x.ts', target: 'a/w.ts' }]);
  assert.deepEqual(v.map((x) => x.target), ['b/z.ts']);
});
await ok('projet simple : pas de packages, fixture historique intacte', () => {
  const g = scanner.scan('test-fixture');
  assert.equal(g.packages.nodes.length, 0);
  assert.equal(g.nest.nodes.length, 1); // AppModule seul : AuthModule/UsersModule n'ont pas de @Module dans ce jeu d'essai
  assert.equal(g.files.cycles.length, 1);
  assert.equal(g.incidents.length, 1);
});


// ---------- Git ----------
console.log('\nGit');
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const gitm = await load('src/git.ts', 'git');
const repo = mkdtempSync(path.join(out, 'repo-'));
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' }).toString();
const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); };
git('init', '-q', '-b', 'main');
put('src/a.ts', "import './b';"); put('src/b.ts', 'export const b = 1;'); put('src/c.ts', 'export const c = 1;');
git('add', '-A'); git('commit', '-q', '-m', 'v1');
fs.rmSync(path.join(repo, 'src/c.ts')); put('src/d.ts', "import './b';"); put('src/a.ts', "import './b'; import './d';");
git('add', '-A'); git('commit', '-q', '-m', 'v2');
git('checkout', '-q', '-b', 'feature'); put('src/d.ts', "import './b'; // modifié"); git('commit', '-qam', 'feat');
await ok('git : mode branche = fichiers modifiés depuis main', async () => {
  const r = await gitm.changedFiles(repo, { kind: 'branch' });
  assert.deepEqual(r.files, ['src/d.ts']);
  assert.match(r.label, /main/);
});
put('src/b.ts', 'export const b = 2;'); put('src/e.ts', 'export const e = 1;');
await ok('git : modifications non commitées + fichiers non suivis', async () => {
  const r = await gitm.changedFiles(repo, { kind: 'working' });
  assert.deepEqual(r.files.sort(), ['src/b.ts', 'src/e.ts']);
});
await ok('git : comparaison avec une version antérieure (ajoutés / supprimés)', async () => {
  const c = await gitm.compareWith(repo, 'main~1', {});
  assert.deepEqual(c.files.addedNodes.sort(), ['src/d.ts', 'src/e.ts']);
  assert.deepEqual(c.files.removedNodes.map((n) => n.id), ['src/c.ts']);
  const k = (l) => `${l.source}>${l.target}`;
  assert.deepEqual(c.files.addedLinks.map(k).sort(), ['src/a.ts>src/d.ts', 'src/d.ts>src/b.ts']);
  assert.deepEqual(c.files.removedLinks, []);
});
await ok('git : une référence qui ressemble à une option est refusée', async () => {
  await assert.rejects(gitm.compareWith(repo, '--output=/tmp/x', {}), /invalide/);
  await assert.rejects(gitm.changedFiles(repo, { kind: 'ref', ref: '-p' }), /invalide/);
  await assert.rejects(gitm.compareWith(repo, 'inconnue', {}), /introuvable/);
});

// ---------- Prompts & IA ----------
console.log('\nIA');
const prompts = await load('src/prompts.ts', 'prompts');
await ok('prompts : digest trié par impact, tests exclus', () => {
  const d = prompts.buildDigest(mono);
  assert.equal(d.topImpact[0].file.endsWith('shared/src/logger.ts') || d.topImpact[0].file.endsWith('shared/src/index.ts'), true);
  assert.ok(d.topImpact.every((x) => !x.file.endsWith('.spec.ts')));
  assert.equal(d.nestModules.length, 3);
  assert.equal(d.violations.length, 2);
});
await ok('prompts : lecture tolérante des suggestions (JSON entouré de texte, fichiers inconnus écartés)', () => {
  const known = new Set(['a.ts', 'b.ts']);
  const txt = 'Voici :\n```json\n[{"file":"a.ts","title":"T","why":"W","check":"C"},{"file":"zzz.ts","title":"X"}]\n```';
  const r = prompts.parseSuggestions(txt, known);
  assert.equal(r.length, 1); assert.equal(r[0].file, 'a.ts');
  assert.equal(prompts.parseSuggestions('pas de json', known), null);
  assert.equal(prompts.parseSuggestions('[{"file":"zzz.ts","title":"x"}]', known), null);
});

import Module from 'node:module';
const cfg = { aiProvider: 'auto', aiModelFamily: '' };
let state;
const resetState = () => (state = { models: [], clip: null, warn: undefined, calls: 0 });
resetState();
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => cfg[k] ?? d }) },
  window: { showWarningMessage: async () => state.warn },
  env: { clipboard: { writeText: async (t) => { state.clip = t; } } },
  lm: { selectChatModels: async () => { state.calls++; return state.models; } },
  LanguageModelChatMessage: { User: (c) => ({ role: 'user', content: c }) },
  CancellationTokenSource: class { token = {}; },
};
const origLoad = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscodeStub : origLoad.call(this, r, ...a); };
const ai = await load('src/ai.ts', 'ai');
const ctxOf = (consent) => ({ globalState: { get: () => consent, update: async () => {} } });
const P = { system: 'S', user: 'U' };
const model = (family, text, fail) => ({ family, name: family, sendRequest: async () => { if (fail) throw fail; return { text: (async function* () { for (const t of text) yield t; })() }; } });

await ok('ia : réponse du modèle Copilot, Sonnet préféré', async () => {
  resetState(); state.models = [model('gpt-x', ['non']), model('claude-sonnet', ['Bon', 'jour'])];
  const r = await ai.askAi(ctxOf(true), P, 'test');
  assert.deepEqual([r.ok, r.text, r.model], [true, 'Bonjour', 'claude-sonnet']);
});
await ok('ia : sans modèle, le prompt est copié (aucune clé API nécessaire)', async () => {
  resetState();
  const r = await ai.askAi(ctxOf(true), P, 'test');
  assert.equal(r.ok, false); assert.equal(r.reason, 'copied'); assert.equal(state.clip, 'S\n\nU');
});
await ok('ia : mode « copy » sans même interroger les modèles', async () => {
  resetState(); cfg.aiProvider = 'copy';
  const r = await ai.askAi(ctxOf(true), P, 'test');
  cfg.aiProvider = 'auto';
  assert.equal(r.reason, 'copied'); assert.equal(state.calls, 0);
});
await ok('ia : consentement refusé = rien n\'est envoyé', async () => {
  resetState(); state.models = [model('claude-sonnet', ['x'])]; state.warn = undefined;
  const r = await ai.askAi(ctxOf(false), P, 'test');
  assert.equal(r.reason, 'cancelled');
});
await ok('ia : accès refusé par VS Code = message clair', async () => {
  resetState(); state.models = [model('claude-sonnet', [], Object.assign(new Error('x'), { code: 'NoPermissions' }))];
  const r = await ai.askAi(ctxOf(true), P, 'test');
  assert.equal(r.reason, 'error'); assert.match(r.message, /refusé/);
});

console.log('\nIA : ordre Copilot puis Claude (CLI)');
const stubDir = mkdtempSync(path.join(out, 'stub-'));
const stub = (name, body) => { const f = path.join(stubDir, name); fs.writeFileSync(f, '#!/bin/sh\n' + body); fs.chmodSync(f, 0o755); return f; };
// faux « claude » : renvoie le dossier courant, la présence d'une clé API et les arguments reçus
const okCli = stub('claude-ok', `cat >/dev/null; printf '{"result":"cwd=%s key=%s args=%s","is_error":false,"modelUsage":{"claude-sonnet-x":{}}}' "$PWD" "\${ANTHROPIC_API_KEY:-absente}" "$*"`);
const failCli = stub('claude-fail', `cat >/dev/null; printf '{"result":"Not logged in","is_error":true}'; exit 1`);
const useOrder = (order, bin) => { cfg.aiProviders = order; cfg.claudeCliPath = bin; };
const reset2 = () => { delete cfg.aiProviders; delete cfg.claudeCliPath; cfg.aiProvider = 'auto'; };
await ok('ordre : Copilot répond → Claude CLI n\'est pas appelé', async () => {
  resetState(); state.models = [model('claude-sonnet', ['via copilot'])]; useOrder(['copilot', 'claude-cli', 'copy'], okCli);
  const r = await ai.askAi(ctxOf(true), P, 'test'); reset2();
  assert.equal(r.ok, true); assert.equal(r.text, 'via copilot');
});
await ok('ordre : sans modèle Copilot → Claude CLI (abonnement), dossier neutre, sans outils, sans clé API', async () => {
  resetState(); process.env.ANTHROPIC_API_KEY = 'sk-secret'; useOrder(['copilot', 'claude-cli', 'copy'], okCli);
  const r = await ai.askAi(ctxOf(true), P, 'test'); reset2(); delete process.env.ANTHROPIC_API_KEY;
  assert.equal(r.ok, true);
  assert.match(r.text, /key=absente/, 'la clé API ne doit pas être transmise');
  assert.match(r.text, /cwd=.*depgraph-claude-/, 'dossier temporaire, pas le projet');
  assert.match(r.text, /-p --output-format json --tools/);
  assert.match(r.model, /Claude \(claude-sonnet-x\)/);
});
await ok('ordre : Copilot en échec (quota) → on passe à Claude CLI', async () => {
  resetState(); state.models = [model('gpt', [], new Error('quota dépassé'))]; useOrder(['copilot', 'claude-cli', 'copy'], okCli);
  const r = await ai.askAi(ctxOf(true), P, 'test'); reset2();
  assert.equal(r.ok, true); assert.match(r.text, /cwd=/);
});
await ok('ordre : Claude CLI introuvable → copie du prompt', async () => {
  resetState(); useOrder(['claude-cli', 'copy'], path.join(stubDir, 'inexistant'));
  const r = await ai.askAi(ctxOf(true), P, 'test'); reset2();
  assert.equal(r.reason, 'copied'); assert.equal(state.clip, 'S\n\nU');
});
await ok('ordre : Claude CLI non connecté → message clair + copie', async () => {
  resetState(); useOrder(['claude-cli', 'copy'], failCli);
  const r = await ai.askAi(ctxOf(true), P, 'test'); reset2();
  assert.equal(r.reason, 'copied'); assert.match(r.message, /Not logged in/); assert.match(r.message, /claude/);
});
await ok('ordre : consentement refusé pour Claude CLI = rien n\'est envoyé', async () => {
  resetState(); state.warn = undefined; useOrder(['claude-cli', 'copy'], okCli);
  const r = await ai.askAi(ctxOf(false), P, 'test'); reset2();
  assert.equal(r.reason, 'cancelled'); assert.equal(state.clip, null);
});
await ok('modèles : la liste affiche family et id pour le réglage aiModelFamily', async () => {
  resetState(); state.models = [{ name: 'Claude Sonnet', family: 'claude-sonnet', id: 'x1', vendor: 'copilot', maxInputTokens: 1000 }];
  const t = await ai.describeModels();
  assert.match(t, /family : claude-sonnet/); assert.match(t, /id : x1/); assert.match(t, /1000 tokens/);
  resetState(); assert.match(await ai.describeModels(), /Aucun modèle/);
});

Module._load = origLoad;

console.log('NestJS : injections et providers inutilisés');
const nestG = scanner.scan('test/fixtures/nest-app');
const NC = nestG.nestClasses;
const cid = (f, n) => `src/${f}#${n}`;
const node = (name) => NC.nodes.find((n) => n.label === name);
await ok('classes : modules, controller et providers détectés avec leur rôle', () => {
  assert.equal(node('UsersController').role, 'controller');
  assert.equal(node('UsersService').role, 'provider');
  assert.equal(node('UsersModule').role, 'module');
  assert.equal(node("UsersService").line, 8);
});
await ok('injection : constructeur (type), @Inject(forwardRef) et @Inject(jeton) sont résolus', () => {
  const inj = NC.links.filter((l) => l.kind === 'inject');
  const has2 = (a, b) => inj.some((l) => l.source === node(a).id && l.target === node(b).id);
  assert.ok(has2('UsersController', 'UsersService'));
  assert.ok(has2('UsersController', 'SmtpMailer'), 'jeton MAILER -> SmtpMailer');
  assert.ok(has2('UsersService', 'UsersRepository'));
  assert.ok(has2('UsersController', 'RedisCache'), 'classe abstraite Cache -> useClass RedisCache');
  assert.ok(has2('UsersService', 'AuthService'), 'forwardRef');
  assert.ok(has2('AuthService', 'UsersService'));
});
await ok('injection : un type de librairie (ModuleRef) ne crée pas de lien', () => {
  assert.equal(NC.links.filter((l) => l.source === node('UsersService').id).filter((l) => l.kind === 'inject').length, 2);
});
await ok('déclaration : le module relie ses providers et controllers', () => {
  const dec = (a, b) => NC.links.some((l) => l.kind === 'declare' && l.source === node(a).id && l.target === node(b).id);
  assert.ok(dec('UsersModule', 'UsersService'));
  assert.ok(dec('UsersModule', 'UsersController'));
  assert.ok(dec('UsersModule', 'SmtpMailer'), 'via { provide, useClass }');
});
await ok('cycle d\'injection UsersService <-> AuthService détecté (hors liens de déclaration)', () => {
  assert.ok(NC.cycles.some((c) => c.includes(node('UsersService').id) && c.includes(node('AuthService').id)));
});
await ok('orphelins : seul UnusedService est signalé', () => {
  const orphans = NC.nodes.filter((n) => n.orphan).map((n) => n.label).sort();
  assert.deepEqual(orphans, ['UnusedService']);
});
await ok('orphelins : exporté, référencé (ModuleRef), garde APP_GUARD, @Cron et jeton ne sont pas signalés', () => {
  for (const n of ['ExportedOnlyService', 'ReferencedService', 'RolesGuard', 'CleanupService', 'SmtpMailer', 'UsersRepository', 'FactoryDepService', 'RedisCache']) {
    assert.ok(!node(n).orphan, n);
  }
});
await ok('orphelins : un test qui utilise le provider ne le rend pas « utilisé »', () => {
  assert.ok(node('UnusedService').orphan);
});

// ---------- Revue PR, nouveaux problèmes, risque ----------
console.log('\nRevue PR');
const review = await load('src/review.ts', 'review');
const repo2 = mkdtempSync(path.join(out, 'repo2-'));
const git2 = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo2, stdio: 'pipe' }).toString();
const put2 = (f, c) => { fs.mkdirSync(path.dirname(path.join(repo2, f)), { recursive: true }); fs.writeFileSync(path.join(repo2, f), c); };
git2('init', '-q', '-b', 'main');
put2('package.json', '{"name":"root","workspaces":["packages/*"]}');
put2('packages/app/package.json', '{"name":"@r/app","dependencies":{"@r/lib":"1"}}');
put2('packages/lib/package.json', '{"name":"@r/lib"}');
put2('packages/other/package.json', '{"name":"@r/other"}');
put2('packages/lib/src/index.ts', "import './old-a'; export const x = 1;");
put2('packages/lib/src/old-a.ts', "import './old-b'; export const a = 1;");
put2('packages/lib/src/old-b.ts', "import './old-a'; export const b = 1;"); // cycle déjà présent (ancienne dette)
put2('packages/app/src/main.ts', "import '../../lib/src/index'; export const m = 1;");
put2('packages/app/src/main.spec.ts', "import './main';");
put2('.depgraph-rules.json', JSON.stringify({ rules: [{ name: 'lib ne dépend pas de app', from: 'packages/lib/**', notTo: 'packages/app/**' }] }));
git2('add', '-A'); git2('commit', '-q', '-m', 'base');
git2('checkout', '-q', '-b', 'feature');
put2('packages/lib/src/new-a.ts', "import './new-b'; export const na = 1;");
put2('packages/lib/src/new-b.ts', "import './new-a'; import '../../app/src/main'; export const nb = 1;"); // nouveau cycle + violation
put2('packages/lib/src/index.ts', "import './old-a'; import './new-a'; export const x = 2;");
git2('add', '-A'); git2('commit', '-q', '-m', 'feat');
const rv = await review.buildReview(repo2, { kind: 'branch' }, {});
await ok('revue : seuls les nouveaux cycles sont signalés (l\'ancienne dette est ignorée)', () => {
  assert.equal(rv.delta.newCycles.length, 1);
  // new-b → main → index → new-a → new-b : le nouveau cycle englobe ces 4 fichiers, pas l'ancien (old-a/old-b)
  assert.deepEqual(rv.delta.newCycles[0].sort(), ['packages/app/src/main.ts', 'packages/lib/src/index.ts', 'packages/lib/src/new-a.ts', 'packages/lib/src/new-b.ts']);
});
await ok('revue : seules les nouvelles violations sont signalées', () => {
  assert.equal(rv.delta.newViolations.length, 1);
  assert.equal(rv.delta.newViolations[0].source, 'packages/lib/src/new-b.ts');
});
await ok('revue : fichiers modifiés, impactés et tests à relancer (via le test de main.ts)', () => {
  assert.deepEqual(rv.changed.sort(), ['packages/lib/src/index.ts', 'packages/lib/src/new-a.ts', 'packages/lib/src/new-b.ts']);
  assert.ok(rv.impacted.includes('packages/app/src/main.ts'));
  assert.deepEqual(rv.tests, ['packages/app/src/main.spec.ts']);
});
await ok('revue : projets touchés et projets dépendants à retester', () => {
  assert.deepEqual(rv.projects.changed, ['packages/lib']);
  assert.ok(rv.projects.impacted.includes('packages/app'));
  assert.ok(!rv.projects.impacted.includes('packages/other'));
});
await ok('revue : résumé Markdown prêt pour une PR', () => {
  const md = review.reviewMarkdown(rv);
  assert.match(md, /Nouveaux problèmes/); assert.match(md, /new-a\.ts/); assert.match(md, /Projets dépendants/); assert.match(md, /main\.spec\.ts/);
});
await ok('revue : mode « non commité » sans modification = rien de nouveau', async () => {
  const r2 = await review.buildReview(repo2, { kind: 'working' }, {});
  assert.equal(r2.changed.length, 0); assert.equal(r2.delta.newCycles.length, 0); assert.equal(r2.delta.newViolations.length, 0);
});
await ok('risque : plus un fichier est importé, modifié, dans un cycle et sans test, plus le score monte', async () => {
  const g = scanner.scan(repo2);
  const churn = await gitm.churnByFile(repo2);
  assert.ok(churn.get('packages/lib/src/index.ts') >= 2, 'index.ts modifié dans 2 commits');
  const risk = review.computeRisk(g.files, churn);
  const idx = risk.get('packages/lib/src/index.ts'), main = risk.get('packages/app/src/main.ts');
  assert.ok(idx.score > main.score);
  assert.equal(main.untested, false); // main.spec.ts l'atteint
  assert.equal(risk.get('packages/lib/src/old-a.ts').inCycle, true);
  assert.ok([...risk.values()].every((r) => r.score >= 0 && r.score <= 100));
});
await ok('nouveaux providers inutilisés : détectés par rapport à la base', async () => {
  const base = scanner.scan('test/fixtures/nest-app');
  const cur = JSON.parse(JSON.stringify(base));
  cur.nestClasses.nodes.find((n) => n.label === 'UsersRepository').orphan = true;
  assert.deepEqual(review.newProblems(cur, base).newOrphans.map((i) => i.split('#')[1]), ['UsersRepository']);
});

console.log(`\n${passed} test(s) réussi(s)`);
