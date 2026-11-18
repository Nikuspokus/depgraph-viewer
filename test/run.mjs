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
const ok = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

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
Module._load = origLoad;

console.log(`\n${passed} test(s) réussi(s)`);
