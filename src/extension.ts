import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { scan } from './scanner';
import { checkForUpdates } from './updater';
import { ChangeMode, changedFiles, compareWith, defaultBase, isGitRepo, listRefs } from './git';
import { askAi, AiResult } from './ai';
import { buildDigest, diffPrompt, directRelations, parseSuggestions, suggestPrompt, summaryPrompt } from './prompts';
import { Graph, Layer } from './shared/types';

let panel: vscode.WebviewPanel | undefined;
let panelDisposables: vscode.Disposable[] = [];
let currentRoot: string | undefined;
let lastGraph: Graph | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;
const RELEVANT_FILES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'incidents.json', '.depgraph-rules.json', 'rules.json']);

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

/** Chemin relatif au projet (séparateur "/"), ou null s'il sort du projet. */
function relInRoot(abs: string): string | null {
  if (!currentRoot) return null;
  const rel = path.relative(currentRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Chemin absolu, uniquement s'il reste à l'intérieur du projet. */
function absInRoot(rel: string): string | null {
  if (!currentRoot || typeof rel !== 'string') return null;
  const abs = path.resolve(currentRoot, rel);
  return abs.startsWith(currentRoot + path.sep) ? abs : null;
}

async function show(ctx: vscode.ExtensionContext): Promise<void> {
  const root = await pickRoot();
  if (!root) return;
  currentRoot = root;

  if (panel) {
    panel.reveal();
    await sendGraph(false);
    return;
  }

  panel = vscode.window.createWebviewPanel('depgraph', 'Dependency Graph', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
  });
  panel.webview.html = html(panel.webview, ctx.extensionUri);
  panel.onDidDispose(() => {
    panelDisposables.forEach((d) => d.dispose());
    panelDisposables = [];
    clearTimeout(refreshTimer);
    panel = undefined;
  }, null, ctx.subscriptions);

  // Rafraîchissement automatique à l'enregistrement, à la création et à la suppression de fichiers
  panelDisposables.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = relInRoot(doc.uri.fsPath);
      if (rel && (SRC_RE.test(rel) || RELEVANT_FILES.has(path.posix.basename(rel)))) scheduleRefresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => postActive()),
  );
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}'));
  panelDisposables.push(
    watcher,
    watcher.onDidCreate((u) => { const r = relInRoot(u.fsPath); if (r && !/(^|\/)(node_modules|dist|\.git)\//.test(r)) scheduleRefresh(); }),
    watcher.onDidDelete((u) => { const r = relInRoot(u.fsPath); if (r && !/(^|\/)(node_modules|dist|\.git)\//.test(r)) scheduleRefresh(); }),
  );

  panel.webview.onDidReceiveMessage((msg) => void onMessage(ctx, msg), undefined, ctx.subscriptions);
}

function scheduleRefresh(): void {
  if (!vscode.workspace.getConfiguration('depgraph').get<boolean>('autoRefresh', true)) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void sendGraph(true), 1000);
}

function post(msg: unknown): void {
  void panel?.webview.postMessage(msg);
}

function postActive(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const rel = doc && doc.uri.scheme === 'file' ? relInRoot(doc.uri.fsPath) : null;
  if (rel) post({ type: 'active', file: rel });
}

async function sendGraph(refresh: boolean): Promise<void> {
  if (!panel || !currentRoot) return;
  const root = currentRoot;
  const cfg = vscode.workspace.getConfiguration('depgraph');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Dependency Graph : analyse…' },
    async () => {
      try {
        const graph = scan(root, { excludeDirs: cfg.get<string[]>('excludeDirs', []) });
        lastGraph = graph;
        post({
          type: 'graph',
          graph,
          project: path.basename(root),
          refresh,
          settings: {
            hideTests: cfg.get<boolean>('hideTestsByDefault', true),
            followActive: cfg.get<boolean>('followActiveFile', true),
            git: await isGitRepo(root),
            aiProvider: cfg.get<string>('aiProvider', 'auto'),
          },
        });
        postActive();
      } catch (e) {
        vscode.window.showErrorMessage(`Dependency Graph : échec de l'analyse (${(e as Error).message})`);
      }
    },
  );
}

// ---------- messages venant du webview ----------
interface Msg { type: string; [k: string]: any }

async function onMessage(ctx: vscode.ExtensionContext, msg: Msg): Promise<void> {
  try {
    switch (msg.type) {
      case 'ready': await sendGraph(false); break;
      case 'refresh': await sendGraph(true); break;
      case 'open': await openFile(msg.file, msg.line); break;
      case 'save': await saveFile(msg); break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(msg.text ?? ''));
        vscode.window.setStatusBarMessage('Dependency Graph : copié dans le presse-papiers', 3000);
        break;
      case 'requestDiff': await requestDiff(); break;
      case 'requestCompare': await requestCompare(); break;
      case 'summarize': await summarize(ctx, msg.id, msg.scope); break;
      case 'suggest': await suggest(ctx); break;
      case 'analyzeDiff': await analyzeDiff(ctx, msg); break;
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Dependency Graph : ${(e as Error).message}`);
  }
}

async function openFile(rel: string, line?: number): Promise<void> {
  const abs = rel ? absInRoot(rel) : null;
  if (!abs || !fs.existsSync(abs)) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const l = Number.isInteger(line) && (line as number) > 0 ? (line as number) - 1 : undefined;
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preview: true,
    selection: l !== undefined ? new vscode.Range(l, 0, l, 0) : undefined,
  });
}

async function saveFile(msg: Msg): Promise<void> {
  const name = path.basename(String(msg.filename ?? 'export.txt'));
  const ext = path.extname(name).slice(1);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(currentRoot ?? '', name)),
    filters: { [ext.toUpperCase() || 'Fichier']: [ext || '*'] },
  });
  if (!target) return;
  const bytes = msg.base64 ? Buffer.from(String(msg.base64), 'base64') : Buffer.from(String(msg.text ?? ''), 'utf8');
  await vscode.workspace.fs.writeFile(target, bytes);
  const open = await vscode.window.showInformationMessage(`Exporté : ${path.basename(target.fsPath)}`, 'Ouvrir');
  if (open) await vscode.commands.executeCommand('vscode.open', target);
}

// ---------- Git ----------
async function pickRef(placeHolder: string): Promise<string | undefined> {
  if (!currentRoot) return undefined;
  const refs = await listRefs(currentRoot);
  const manual = 'Saisir une référence…';
  const choice = await vscode.window.showQuickPick([...refs, manual], { placeHolder });
  if (!choice) return undefined;
  if (choice !== manual) return choice;
  return vscode.window.showInputBox({ prompt: 'Branche, tag ou commit (ex. main, v1.2.0, a1b2c3d, HEAD~5)' });
}

async function requestDiff(): Promise<void> {
  const root = currentRoot;
  if (!root) return;
  if (!(await isGitRepo(root))) {
    vscode.window.showWarningMessage("Dependency Graph : ce dossier n'est pas un dépôt Git.");
    return;
  }
  const base = await defaultBase(root);
  type Item = vscode.QuickPickItem & { mode?: ChangeMode; pick?: boolean };
  const items: Item[] = [
    { label: '$(git-commit) Modifications non commitées', description: 'par rapport à HEAD, fichiers non suivis inclus', mode: { kind: 'working' } },
    ...(base ? [{ label: `$(git-branch) Branche courante vs ${base}`, description: 'comme dans une pull request', mode: { kind: 'branch' } } as Item] : []),
    { label: '$(tag) Depuis une branche, un tag ou un commit…', pick: true },
  ];
  const choice = await vscode.window.showQuickPick(items, { placeHolder: "Quelles modifications analyser ?" });
  if (!choice) return;
  let mode = choice.mode;
  if (choice.pick) {
    const ref = await pickRef('Modifications depuis…');
    if (!ref) return;
    mode = { kind: 'ref', ref };
  }
  const set = await changedFiles(root, mode as ChangeMode);
  post({ type: 'changes', set });
}

async function requestCompare(): Promise<void> {
  const root = currentRoot;
  if (!root) return;
  if (!(await isGitRepo(root))) {
    vscode.window.showWarningMessage("Dependency Graph : ce dossier n'est pas un dépôt Git.");
    return;
  }
  const ref = await pickRef('Comparer le projet actuel avec…');
  if (!ref) return;
  const cfg = vscode.workspace.getConfiguration('depgraph');
  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Dependency Graph : comparaison avec ${ref}…` },
    () => compareWith(root, ref, { excludeDirs: cfg.get<string[]>('excludeDirs', []) }),
  );
  post({ type: 'compare', data });
}

// ---------- IA (modèles de VS Code / Copilot, sans clé API) ----------
function postAi(kind: string, extra: Record<string, unknown>, r: AiResult): void {
  if (r.ok) post({ type: 'ai', kind, ...extra, text: r.text, model: r.model });
  else post({ type: 'ai', kind, ...extra, error: r.message, copied: r.reason === 'copied', cancelled: r.reason === 'cancelled' });
}

function layerOf(g: Graph, scope: string): Layer {
  return scope === 'nest' ? g.nest : scope === 'packages' ? g.packages : g.files;
}

async function summarize(ctx: vscode.ExtensionContext, id: string, scope: string): Promise<void> {
  if (!lastGraph) return;
  const layer = layerOf(lastGraph, scope);
  const node = layer.nodes.find((n) => n.id === id);
  const abs = node ? absInRoot(node.file ?? node.id) : null;
  if (!node || !abs) return;
  let content = '';
  try { content = fs.readFileSync(abs, 'utf8'); } catch { /* fichier illisible : on résume avec les seules relations */ }
  const rel = directRelations(layer, id);
  const r = await askAi(ctx, summaryPrompt({ node, ...rel, content }), 'résumer ce fichier');
  postAi('summary', { id, scope }, r);
}

async function suggest(ctx: vscode.ExtensionContext): Promise<void> {
  if (!lastGraph) return;
  const known = new Set(lastGraph.files.nodes.map((n) => n.id));
  const r = await askAi(ctx, suggestPrompt(buildDigest(lastGraph)), 'proposer des simulations');
  if (r.ok) {
    const items = parseSuggestions(r.text, known);
    post({ type: 'ai', kind: 'suggest', items, text: items ? undefined : r.text, model: r.model });
  } else postAi('suggest', {}, r);
}

async function analyzeDiff(ctx: vscode.ExtensionContext, msg: Msg): Promise<void> {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const r = await askAi(
    ctx,
    diffPrompt({ label: String(msg.label ?? 'Modifications'), changed: list(msg.changed), impacted: list(msg.impacted), tests: list(msg.tests) }),
    "analyser le risque de ces modifications",
  );
  postAi('diff', {}, r);
}

// ---------- page du webview ----------
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
    .row { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
    button, input, select { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; padding: 3px 9px; border-radius: 3px; cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button[disabled] { opacity: .45; cursor: default; }
    input { cursor: text; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border-color: var(--vscode-input-border, transparent); min-width: 160px; }
    select { color: var(--vscode-dropdown-foreground, inherit); background: var(--vscode-dropdown-background, inherit); padding: 3px 6px; }
    input[type=search] { min-width: 190px; }
    input[type=number] { width: 52px; min-width: 0; }
    input[type=checkbox] { padding: 0; min-width: 0; cursor: pointer; }
    .chk { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
    #stats { margin-left: auto; opacity: .7; }
    #hoverinfo { margin-left: auto; color: var(--vscode-textLink-foreground); }
    #main { flex: 1; display: flex; min-height: 0; }
    #graph { flex: 1; min-width: 0; position: relative; }
    #canvas { position: absolute; inset: 0; overflow: hidden; }
    #side { width: 300px; border-left: 1px solid var(--vscode-panel-border); overflow-y: auto; padding: 8px 10px; box-sizing: border-box; }
    #side h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
    #side .path { word-break: break-all; opacity: .85; }
    #side .box { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
    #side .err { color: var(--vscode-errorForeground); }
    #side ul { margin: 0; padding-left: 16px; }
    #side li { margin: 2px 0; word-break: break-all; }
    .link { color: var(--vscode-textLink-foreground); cursor: pointer; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
    #legend span { display: inline-block; margin-right: 10px; }
    #empty { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; text-align: center; opacity: .7; padding: 20px; }
  </style>
</head>
<body>
  <div id="bar" class="row">
    <button id="mtree" class="on" title="Vue hiérarchique à plat : entrées en haut, fondations en bas">Organigramme</button>
    <button id="m2d">2D</button>
    <button id="m3d">3D</button>
    <button id="arrange" title="Réorganise la vue : hiérarchie recalculée, ou nœuds écartés et regroupés par dossier en 2D/3D">Organiser</button>
    <input id="q" type="search" placeholder="Chercher un fichier…" />
    <button id="refresh">Rafraîchir</button>
    <button id="reset">Désélectionner</button>
    <span id="stats"></span>
  </div>
  <div id="filters" class="row">
    <span id="kinds"></span>
    <input id="fpath" type="search" placeholder="Filtrer : auth, users, !shared" title="Mots du chemin séparés par des virgules. Un ! exclut (ex. !shared)." />
    <label class="chk" title="Masque les fichiers importés par au moins N autres (utilitaires omniprésents). 0 = désactivé.">Masquer importés par ≥ <input id="fshared" type="number" min="0" value="0" /></label>
    <label class="chk"><input id="fiso" type="checkbox" /> Masquer isolés</label>
    <label class="chk"><input id="ftests" type="checkbox" checked /> Masquer tests</label>
    <label class="chk" title="Regroupe les fichiers par dossier à cette profondeur. Clic droit sur un dossier : le déplier.">Regrouper
      <select id="fgroup"><option value="0">non</option><option value="1">niveau 1</option><option value="2">niveau 2</option><option value="3">niveau 3</option><option value="4">niveau 4</option></select>
    </label>
    <button id="freset">Réinitialiser</button>
  </div>
  <div id="tools" class="row">
    <label class="chk">Vue
      <select id="scope">
        <option value="files">Fichiers</option>
        <option value="nest">Modules NestJS</option>
        <option value="packages">Packages (monorepo)</option>
      </select>
    </label>
    <button id="bdiff" title="Quels fichiers sont impactés par mes modifications Git, et quels tests relancer ?">Impact Git</button>
    <button id="bcmp" title="Compare le projet actuel à une branche, un tag ou un commit">Comparer…</button>
    <button id="bclear" style="display:none">Quitter</button>
    <button id="bsug" title="Propose des scénarios de panne à étudier (modèle de VS Code / Copilot)">Suggestions IA</button>
    <select id="export" title="Exporter la vue">
      <option value="">Exporter…</option>
      <option value="mermaid">Mermaid (.md)</option>
      <option value="svg">SVG</option>
      <option value="png">PNG</option>
    </select>
    <label class="chk"><input id="ffollow" type="checkbox" /> Suivre le fichier actif</label>
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
