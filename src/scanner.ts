import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export type NodeKind = 'module' | 'controller' | 'service' | 'vue' | 'svelte' | 'other';

export interface GNode {
  id: string; // chemin relatif au workspace, séparateurs "/"
  label: string;
  dir: string;
  kind: NodeKind;
}

export interface GLink {
  source: string; // fichier qui importe
  target: string; // fichier importé
}

export interface Incident {
  file: string;
  title: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface Graph {
  nodes: GNode[];
  links: GLink[];
  cycles: string[][];
  incidents: Incident[];
  stats: { files: number; links: number; unresolved: number };
}

export interface ScanOptions {
  excludeDirs?: string[];
  includeTests?: boolean;
}

const SRC_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.nuxt', '.output', '.svelte-kit',
  'coverage', '.next', '.angular', '.idea', '.vscode', '.turbo', '.cache',
]);
const TEST_RE = /\.(spec|test|stories)\.[cm]?[jt]sx?$/;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function walk(root: string, dir: string, opts: ScanOptions, out: string[]): void {
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
      walk(root, full, opts, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!SRC_EXT.includes(ext)) continue;
      if (e.name.endsWith('.d.ts')) continue;
      if (!opts.includeTests && TEST_RE.test(e.name)) continue;
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

export function scan(root: string, opts: ScanOptions = {}): Graph {
  const files: string[] = [];
  walk(root, root, opts, files);
  const fileSet = new Set(files);
  const aliases = loadAliases(root);

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
    return null; // paquet npm externe ou alias inconnu
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

  const nodes: GNode[] = files.map((f) => ({
    id: f,
    label: path.posix.basename(f),
    dir: path.posix.dirname(f),
    kind: kindOf(f),
  }));

  return {
    nodes,
    links,
    cycles: findCycles(files, links),
    incidents: loadIncidents(root, fileSet),
    stats: { files: files.length, links: links.length, unresolved },
  };
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
        }))
        .filter((i) => fileSet.has(i.file));
    } catch {
      return [];
    }
  }
  return [];
}
