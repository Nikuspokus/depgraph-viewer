import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { GLink, GNode, Graph, Incident, Layer, NodeKind } from './shared/types';
import { findCycles } from './shared/graph';
import { parseNest } from './nest';
import { checkRules, loadRules } from './rules';

export { findCycles };
export type { Graph, GNode, GLink, Incident, Layer };

export interface ScanOptions {
  excludeDirs?: string[];
}

const SRC_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.nuxt', '.output', '.svelte-kit',
  'coverage', '.next', '.angular', '.idea', '.vscode', '.turbo', '.cache',
]);
const TEST_RE = /\.(spec|test|stories)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__)\//;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function walk(root: string, dir: string, opts: ScanOptions, out: string[], pkgDirs: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const extra = new Set(opts.excludeDirs ?? []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || extra.has(e.name)) continue;
      walk(root, full, opts, out, pkgDirs);
    } else if (e.isFile()) {
      if (e.name === 'package.json') {
        pkgDirs.push(toPosix(path.relative(root, dir)) || '.');
        continue;
      }
      if (!SRC_EXT.includes(path.extname(e.name))) continue;
      if (e.name.endsWith('.d.ts')) continue;
      out.push(toPosix(path.relative(root, full)));
    }
  }
}

function kindOf(file: string): NodeKind {
  if (file.endsWith('.vue')) return 'vue';
  if (file.endsWith('.svelte')) return 'svelte';
  if (/\.module\.[jt]s$/.test(file)) return 'module';
  if (/\.controller\.[jt]s$/.test(file)) return 'controller';
  if (/\.service\.[jt]s$/.test(file)) return 'service';
  return 'other';
}

/** Récupère le code JS/TS d'un fichier (bloc <script> pour .vue/.svelte). */
function scriptSource(file: string, text: string): string {
  if (!file.endsWith('.vue') && !file.endsWith('.svelte')) return text;
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let code = '';
  while ((m = re.exec(text)) !== null) code += m[1] + '\n';
  return code;
}

function extractImports(file: string, text: string): string[] {
  const code = scriptSource(file, text);
  if (!code.trim()) return [];
  const info = ts.preProcessFile(code, true, true);
  return info.importedFiles.map((f) => f.fileName);
}

interface AliasConfig {
  baseDir: string;
  paths: Record<string, string[]>;
}

function loadAliases(root: string): AliasConfig {
  const cfgPath = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']
    .map((n) => path.join(root, n))
    .find((p) => fs.existsSync(p));
  const result: AliasConfig = { baseDir: root, paths: {} };
  if (!cfgPath) return result;
  // ts.sys n'existe pas quand typescript est bundlé : on lit le fichier nous-mêmes
  // (parseConfigFileTextToJson tolère commentaires et virgules finales).
  let co: { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
  try {
    co = ts.parseConfigFileTextToJson(cfgPath, fs.readFileSync(cfgPath, 'utf8')).config?.compilerOptions;
  } catch {
    return result;
  }
  if (!co) return result;
  const baseUrl = co.baseUrl;
  result.baseDir = baseUrl ? path.resolve(path.dirname(cfgPath), baseUrl) : path.dirname(cfgPath);
  result.paths = co.paths ?? {};
  return result;
}

// ---------- packages (monorepo) ----------
interface Pkg {
  dir: string; // "." pour la racine
  name: string;
  entry: string[];
}

function readPackages(root: string, pkgDirs: string[]): Pkg[] {
  const out: Pkg[] = [];
  for (const dir of pkgDirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
      const entry = [j.source, j.module, j.main, j.types, j.typings].filter((x): x is string => typeof x === 'string');
      const fallback = dir === '.' ? path.basename(root) : path.posix.basename(dir);
      out.push({ dir, name: typeof j.name === 'string' ? j.name : fallback, entry });
    } catch { /* package.json illisible : ignoré */ }
  }
  return out;
}

function packageLayer(pkgs: Pkg[], pkgOf: Map<string, string>, links: GLink[]): Layer {
  const counts = new Map<string, number>();
  for (const p of pkgOf.values()) counts.set(p, (counts.get(p) ?? 0) + 1);
  const nodes: GNode[] = pkgs
    .filter((p) => counts.has(p.dir))
    .map((p) => ({
      id: p.dir,
      label: p.name,
      dir: p.dir === '.' ? '.' : path.posix.dirname(p.dir),
      kind: 'package' as const,
      file: p.dir === '.' ? 'package.json' : `${p.dir}/package.json`,
      count: counts.get(p.dir),
    }));
  const agg = new Map<string, GLink>();
  for (const l of links) {
    const s = pkgOf.get(l.source), t = pkgOf.get(l.target);
    if (!s || !t || s === t) continue;
    const key = `${s}\u0000${t}`;
    const cur = agg.get(key);
    if (cur) cur.w = (cur.w ?? 1) + 1;
    else agg.set(key, { source: s, target: t, w: 1 });
  }
  const pl = [...agg.values()];
  return { nodes, links: pl, cycles: findCycles(nodes.map((n) => n.id), pl) };
}

export function scan(root: string, opts: ScanOptions = {}): Graph {
  const files: string[] = [];
  const pkgDirs: string[] = [];
  walk(root, root, opts, files, pkgDirs);
  const fileSet = new Set(files);
  const aliases = loadAliases(root);

  const allPkgs = readPackages(root, pkgDirs);
  const pkgs = allPkgs.length >= 2 ? allPkgs : []; // "monorepo" dès qu'il y a au moins 2 package.json
  const wsPkgs = pkgs.filter((p) => p.dir !== '.').sort((a, b) => b.name.length - a.name.length);

  const fileExists = (rel: string): boolean => fileSet.has(rel);

  /** Essaie de résoudre une base (sans ou avec extension) vers un fichier connu. */
  const tryResolve = (absBase: string): string | null => {
    const rel = toPosix(path.relative(root, absBase));
    if (rel.startsWith('..')) return null;
    const candidates: string[] = [rel];
    // import './x.js' qui pointe en réalité vers x.ts (ESM TypeScript)
    const stripped = rel.replace(/\.[cm]?jsx?$/, '');
    if (stripped !== rel) candidates.push(stripped);
    const out: string[] = [];
    for (const c of candidates) {
      out.push(c);
      for (const e of SRC_EXT) out.push(c + e);
      for (const e of SRC_EXT) out.push(`${c}/index${e}`);
    }
    return out.find(fileExists) ?? null;
  };

  /** `import … from '@mon-org/lib'` quand `lib` est un package du monorepo. */
  const resolveWorkspace = (spec: string): string | null => {
    const pkg = wsPkgs.find((p) => spec === p.name || spec.startsWith(p.name + '/'));
    if (!pkg) return null;
    const sub = spec.slice(pkg.name.length).replace(/^\//, '');
    const base = path.resolve(root, pkg.dir);
    if (sub) return tryResolve(path.join(base, sub)) ?? tryResolve(path.join(base, 'src', sub));
    const entries = pkg.entry.map((e) => e.replace(/^\.\//, '').replace(/^(dist|build|lib|out)\//, 'src/'));
    for (const e of [...entries, 'src/index', 'index']) {
      const r = tryResolve(path.join(base, e));
      if (r) return r;
    }
    return null;
  };

  const resolveSpec = (fromFile: string, spec: string): string | null => {
    if (spec.startsWith('.')) {
      return tryResolve(path.resolve(root, path.dirname(fromFile), spec));
    }
    // alias tsconfig "paths"
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
      const star = pattern.indexOf('*');
      let rest: string | null = null;
      if (star === -1) {
        if (spec === pattern) rest = '';
      } else {
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
          rest = spec.slice(prefix.length, spec.length - suffix.length);
        }
      }
      if (rest === null) continue;
      for (const t of targets) {
        const r = tryResolve(path.resolve(aliases.baseDir, star === -1 ? t : t.replace('*', rest)));
        if (r) return r;
      }
    }
    // alias usuels Nuxt / Vite : "~/", "@/", "~~/"
    const m = /^(~~|~|@)\/(.*)$/.exec(spec);
    if (m) {
      const bases = m[1] === '~~' ? [root] : [path.join(root, 'src'), root, path.join(root, 'app')];
      for (const b of bases) {
        const r = tryResolve(path.resolve(b, m[2]));
        if (r) return r;
      }
    }
    return resolveWorkspace(spec); // packages du monorepo, sinon paquet npm externe
  };

  const linkSet = new Set<string>();
  const links: GLink[] = [];
  let unresolved = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractImports(file, text)) {
      const target = resolveSpec(file, spec);
      if (!target) {
        if (spec.startsWith('.') || spec.startsWith('~') || spec.startsWith('@/')) unresolved++;
        continue;
      }
      if (target === file) continue;
      const key = `${file}\u0000${target}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);
      links.push({ source: file, target });
    }
  }

  // package d'appartenance : le plus proche dossier contenant un package.json
  const pkgOf = new Map<string, string>();
  if (pkgs.length) {
    for (const f of files) {
      let best: Pkg | undefined;
      for (const p of pkgs) {
        if ((p.dir === '.' || f.startsWith(p.dir + '/')) && (!best || p.dir.length > best.dir.length)) best = p;
      }
      if (best) pkgOf.set(f, best.dir);
    }
  }

  const nodes: GNode[] = files.map((f) => ({
    id: f,
    label: path.posix.basename(f),
    dir: path.posix.dirname(f),
    kind: kindOf(f),
    isTest: TEST_RE.test(f) || TEST_DIR_RE.test(f) || undefined,
    pkg: pkgOf.get(f),
  }));

  const nest = parseNest(root, files, resolveSpec);
  const packages = pkgs.length ? packageLayer(pkgs, pkgOf, links) : { nodes: [], links: [], cycles: [] };
  const rulesInfo = loadRules(root);

  return {
    files: { nodes, links, cycles: findCycles(files, links) },
    nest,
    packages,
    incidents: loadIncidents(root, fileSet),
    violations: rulesInfo.rules.length ? checkRules(rulesInfo.rules, links) : [],
    hasRules: rulesInfo.present && !rulesInfo.error,
    rulesError: rulesInfo.error,
    stats: {
      files: files.length,
      links: links.length,
      unresolved,
      nestModules: nest.nodes.length,
      packages: packages.nodes.length,
    },
  };
}

function loadIncidents(root: string, fileSet: Set<string>): Incident[] {
  const candidates = ['incidents.json', '.depgraph/incidents.json'];
  for (const c of candidates) {
    const p = path.join(root, c);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((i) => i && typeof i.file === 'string' && typeof i.title === 'string')
        .map((i) => ({
          file: toPosix(i.file).replace(/^\.\//, ''),
          title: String(i.title),
          severity: ['low', 'medium', 'high'].includes(i.severity) ? i.severity : 'medium',
          line: Number.isInteger(i.line) && i.line > 0 ? i.line : undefined,
        }))
        .filter((i) => fileSet.has(i.file));
    } catch {
      return [];
    }
  }
  return [];
}
