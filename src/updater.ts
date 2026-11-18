import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

const LAST_CHECK_KEY = 'depgraph.lastUpdateCheck';
const SKIPPED_KEY = 'depgraph.skippedVersion';
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000; // au plus une vérification automatique toutes les 12 h

interface ReleaseAsset { name: string; browser_download_url: string; digest?: string }
interface Release { tag_name: string; html_url: string; assets: ReleaseAsset[] }

/** Lit "owner/repo" dans le champ `repository` du package.json de l'extension. */
function parseRepo(ctx: vscode.ExtensionContext): { owner: string; repo: string } | null {
  const r = ctx.extension.packageJSON.repository;
  const url: string = typeof r === 'string' ? r : r?.url ?? '';
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Vrai si la version `a` est strictement plus récente que `b` (x.y.z). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export async function checkForUpdates(ctx: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('depgraph');
  if (!manual) {
    if (!cfg.get<boolean>('autoCheckUpdates', true)) return;
    const last = ctx.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - last < CHECK_EVERY_MS) return;
  }
  const repo = parseRepo(ctx);
  if (!repo) {
    if (manual) vscode.window.showWarningMessage('Dependency Graph : dépôt GitHub introuvable dans package.json.');
    return;
  }
  await ctx.globalState.update(LAST_CHECK_KEY, Date.now());

  let release: Release;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'depgraph-viewer-updater' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
    release = (await res.json()) as Release;
  } catch (e) {
    if (manual) vscode.window.showWarningMessage(`Dependency Graph : vérification impossible (${(e as Error).message}).`);
    return; // en automatique on reste silencieux (hors ligne, limite d'API…)
  }

  const latest = release.tag_name.replace(/^v/, '');
  const current: string = ctx.extension.packageJSON.version;
  if (!isNewer(latest, current)) {
    if (manual) vscode.window.showInformationMessage(`Dependency Graph Viewer est à jour (v${current}).`);
    return;
  }
  if (!manual && ctx.globalState.get<string>(SKIPPED_KEY) === latest) return;

  const asset = release.assets?.find((a) => a.name.endsWith('.vsix'));
  if (!asset) {
    if (manual) vscode.window.showWarningMessage(`La version ${latest} n'a pas de fichier .vsix attaché.`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Dependency Graph Viewer ${latest} est disponible (version installée : ${current}).`,
    'Installer', 'Notes de version', 'Ignorer cette version',
  );
  if (choice === 'Notes de version') {
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === 'Ignorer cette version') {
    await ctx.globalState.update(SKIPPED_KEY, latest);
  } else if (choice === 'Installer') {
    await install(repo, asset);
  }
}

async function install(repo: { owner: string; repo: string }, asset: ReleaseAsset): Promise<void> {
  // On ne télécharge que ce qui vient des releases du dépôt de l'extension.
  const expected = `https://github.com/${repo.owner}/${repo.repo}/releases/download/`;
  if (!asset.browser_download_url.startsWith(expected)) {
    vscode.window.showErrorMessage('Dependency Graph : URL de téléchargement inattendue, installation annulée.');
    return;
  }
  try {
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dependency Graph : téléchargement…' },
      async () => {
        const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`téléchargement refusé (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        // GitHub fournit l'empreinte SHA-256 de chaque fichier de release : on la vérifie si elle existe.
        const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
        if (m && createHash('sha256').update(buf).digest('hex') !== m[1].toLowerCase()) {
          throw new Error('empreinte SHA-256 différente de celle annoncée par GitHub');
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-'));
        const target = path.join(dir, path.basename(asset.name));
        fs.writeFileSync(target, buf);
        return target;
      },
    );
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    const reload = await vscode.window.showInformationMessage(
      'Dependency Graph Viewer est mis à jour. Recharge la fenêtre pour l\'activer.', 'Recharger',
    );
    if (reload === 'Recharger') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    vscode.window.showErrorMessage(`Dependency Graph : échec de la mise à jour (${(e as Error).message}).`);
  }
}
