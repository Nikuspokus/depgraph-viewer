import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scan, ScanOptions } from './scanner';
import { ChangeSet, CompareResult, Layer, LayerDiff } from './shared/types';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr?.toString() || err.message).trim()));
      else resolve(stdout.toString());
    });
  });
}

/** Une référence ne doit jamais pouvoir être prise pour une option de git. */
function safeRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new Error(`Référence Git invalide : « ${ref} »`);
  return ref;
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);

export async function isGitRepo(root: string): Promise<boolean> {
  try { return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
}

/** Branche de référence usuelle (celle d'une PR) : origin/main, origin/master, main, master. */
export async function defaultBase(root: string): Promise<string | null> {
  for (const r of ['origin/main', 'origin/master', 'main', 'master']) if (await refExists(root, r)) return r;
  return null;
}

/** Branches et tags, du plus récent au plus ancien. */
export async function listRefs(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  return lines(out).filter((r) => !r.endsWith('/HEAD')).slice(0, 60);
}

export type ChangeMode = { kind: 'working' } | { kind: 'branch' } | { kind: 'ref'; ref: string };

/** Fichiers modifiés (chemins relatifs au dossier ouvert), y compris les fichiers non suivis. */
export async function changedFiles(root: string, mode: ChangeMode): Promise<ChangeSet> {
  let diffArgs: string[];
  let label: string;
  if (mode.kind === 'working') {
    diffArgs = (await refExists(root, 'HEAD')) ? ['HEAD'] : ['--cached'];
    label = 'Modifications non commitées';
  } else if (mode.kind === 'branch') {
    const base = await defaultBase(root);
    if (!base) throw new Error("Aucune branche main/master trouvée pour servir de base à la comparaison.");
    const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).trim();
    diffArgs = [mergeBase];
    label = `Branche courante vs ${base}`;
  } else {
    diffArgs = [safeRef(mode.ref)];
    label = `Modifications depuis ${mode.ref}`;
  }
  const tracked = await git(root, ['diff', '--name-only', '--relative', ...diffArgs, '--']);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
  return { label, files: [...new Set([...lines(tracked), ...lines(untracked)])] };
}

/** Extrait le contenu d'une référence dans un dossier, sans toucher au dossier de travail. */
function archiveTo(root: string, treeish: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const g = spawn('git', ['archive', '--format=tar', treeish], { cwd: root, windowsHide: true });
    const t = spawn('tar', ['-x', '-C', dir], { windowsHide: true });
    let err = '';
    g.stderr.on('data', (d) => (err += d));
    t.stderr.on('data', (d) => (err += d));
    g.stdout.pipe(t.stdin);
    g.on('error', reject);
    t.on('error', reject);
    const done: number[] = [];
    const finish = (code: number | null) => {
      done.push(code ?? 1);
      if (done.length === 2) done.every((c) => c === 0) ? resolve() : reject(new Error(err.trim() || 'extraction impossible'));
    };
    g.on('close', finish);
    t.on('close', finish);
  });
}

function diffLayer(cur: Layer, old: Layer): LayerDiff {
  const curIds = new Set(cur.nodes.map((n) => n.id));
  const oldIds = new Set(old.nodes.map((n) => n.id));
  const key = (l: { source: string; target: string }) => `${l.source}\u0000${l.target}`;
  const curLinks = new Set(cur.links.map(key));
  const oldLinks = new Set(old.links.map(key));
  return {
    addedNodes: cur.nodes.filter((n) => !oldIds.has(n.id)).map((n) => n.id),
    removedNodes: old.nodes.filter((n) => !curIds.has(n.id)),
    addedLinks: cur.links.filter((l) => !oldLinks.has(key(l))),
    removedLinks: old.links.filter((l) => !curLinks.has(key(l))),
  };
}

/** Compare le projet actuel à celui d'une branche, d'un tag ou d'un commit. */
export async function compareWith(root: string, ref: string, opts: ScanOptions): Promise<CompareResult> {
  safeRef(ref);
  if (!(await refExists(root, ref))) throw new Error(`Référence introuvable : « ${ref} »`);
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');
  const treeish = prefix ? `${ref}:${prefix}` : ref;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-cmp-'));
  try {
    await archiveTo(root, treeish, dir);
    const oldG = scan(dir, opts);
    const curG = scan(root, opts);
    return {
      ref,
      files: diffLayer(curG.files, oldG.files),
      nest: diffLayer(curG.nest, oldG.nest),
      packages: diffLayer(curG.packages, oldG.packages),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
