import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { scan } from './scanner';
import { checkForUpdates } from './updater';

let panel: vscode.WebviewPanel | undefined;
let currentRoot: string | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('depgraph.show', () => show(ctx)),
    vscode.commands.registerCommand('depgraph.checkUpdates', () => checkForUpdates(ctx, true)),
  );
  // Vérification discrète après le démarrage (au plus une fois toutes les 12 h)
  setTimeout(() => void checkForUpdates(ctx, false), 8000);
}

export function deactivate(): void {
  panel?.dispose();
}

async function pickRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Dependency Graph : ouvre d'abord un dossier de projet.");
    return undefined;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Projet à analyser' });
  return picked?.uri.fsPath;
}

async function show(ctx: vscode.ExtensionContext): Promise<void> {
  const root = await pickRoot();
  if (!root) return;
  currentRoot = root;

  if (panel) {
    panel.reveal();
    await sendGraph();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'depgraph',
    'Dependency Graph',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    },
  );
  panel.webview.html = html(panel.webview, ctx.extensionUri);
  panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; file?: string }) => {
      if (msg.type === 'ready' || msg.type === 'refresh') {
        await sendGraph();
      } else if (msg.type === 'open' && msg.file && currentRoot) {
        // Sécurité : on ne s'autorise que des chemins à l'intérieur du projet
        const abs = path.resolve(currentRoot, msg.file);
        if (!abs.startsWith(currentRoot + path.sep)) return;
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
      }
    },
    undefined,
    ctx.subscriptions,
  );
}

async function sendGraph(): Promise<void> {
  if (!panel || !currentRoot) return;
  const root = currentRoot;
  const cfg = vscode.workspace.getConfiguration('depgraph');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Dependency Graph : analyse…' },
    async () => {
      try {
        const graph = scan(root, {
          excludeDirs: cfg.get<string[]>('excludeDirs', []),
          includeTests: cfg.get<boolean>('includeTests', false),
        });
        panel?.webview.postMessage({ type: 'graph', graph, project: path.basename(root) });
      } catch (e) {
        vscode.window.showErrorMessage(`Dependency Graph : échec de l'analyse (${(e as Error).message})`);
      }
    },
  );
}

function html(webview: vscode.Webview, extUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', 'webview.js'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dependency Graph</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; }
    #bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    button, input { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; padding: 3px 9px; border-radius: 3px; cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    input { cursor: text; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-color: var(--vscode-input-border, transparent); min-width: 160px; }
    #stats { margin-left: auto; opacity: .7; }
    #filters { display: flex; gap: 10px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    #filters input[type=search] { min-width: 190px; }
    #filters input[type=number] { width: 52px; min-width: 0; }
    .chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
    input[type=checkbox] { padding: 0; min-width: 0; cursor: pointer; }
    #hoverinfo { margin-left: auto; color: var(--vscode-textLink-foreground); }
    #main { flex: 1; display: flex; min-height: 0; }
    #graph { flex: 1; min-width: 0; position: relative; }
    #canvas { position: absolute; inset: 0; overflow: hidden; }
    #side { width: 280px; border-left: 1px solid var(--vscode-panel-border); overflow-y: auto; padding: 8px 10px; box-sizing: border-box; }
    #side h3 { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
    #side .path { word-break: break-all; opacity: .85; }
    #side ul { margin: 0; padding-left: 16px; }
    #side li { margin: 2px 0; word-break: break-all; }
    .link { color: var(--vscode-textLink-foreground); cursor: pointer; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
    #legend span { display: inline-block; margin-right: 10px; }
    #empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center; opacity: .7; padding: 20px; }
  </style>
</head>
<body>
  <div id="bar">
    <button id="mtree" class="on" title="Vue hiérarchique à plat : entrées en haut, fondations en bas">Organigramme</button>
    <button id="m2d">2D</button>
    <button id="m3d">3D</button>
    <button id="arrange" title="Réorganise la vue : hiérarchie recalculée, ou nœuds écartés et regroupés par dossier en 2D/3D">Organiser</button>
    <input id="q" type="search" placeholder="Chercher un fichier…" />
    <button id="refresh">Rafraîchir</button>
    <button id="reset">Désélectionner</button>
    <span id="stats"></span>
  </div>
  <div id="filters">
    <span id="kinds"></span>
    <input id="fpath" type="search" placeholder="Filtrer : auth, users, !shared" title="Mots du chemin séparés par des virgules. Un ! exclut (ex. !shared)." />
    <label class="chk" title="Masque les fichiers importés par au moins N autres (utilitaires omniprésents). 0 = désactivé.">Masquer importés par ≥ <input id="fshared" type="number" min="0" value="0" /></label>
    <label class="chk"><input id="fiso" type="checkbox" /> Masquer isolés</label>
    <button id="freset">Réinitialiser</button>
    <span id="hoverinfo"></span>
  </div>
  <div id="main">
    <div id="graph"><div id="canvas"></div><div id="empty">Aucun fichier source trouvé dans ce dossier.</div></div>
    <div id="side"></div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
