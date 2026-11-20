import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Prompt } from './prompts';

export type AiResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: 'copied' | 'cancelled' | 'error'; message: string };

type Provider = 'copilot' | 'claude-cli' | 'copy';
const CONSENT_COPILOT = 'depgraph.aiConsent';
const CONSENT_CLAUDE = 'depgraph.aiConsentClaudeCli';
const CLI_TIMEOUT_MS = 180_000;
const MAX_PROMPT = 8_000_000; // l'entrée standard de `claude -p` est limitée à 10 Mo

/** Ordre d'essai des fournisseurs. `aiProvider = copy` (ancien réglage) force la copie. */
function providerOrder(cfg: vscode.WorkspaceConfiguration): Provider[] {
  if (cfg.get<string>('aiProvider', 'auto') === 'copy') return ['copy'];
  const raw = cfg.get<string[]>('aiProviders', ['copilot', 'copy']);
  const ok = (raw ?? []).filter((p): p is Provider => p === 'copilot' || p === 'claude-cli' || p === 'copy');
  return ok.length ? ok : ['copilot', 'copy'];
}

/**
 * Interroge un modèle, sans clé API, dans l'ordre configuré :
 * 1. `copilot` : modèles de VS Code (GitHub Copilot) ;
 * 2. `claude-cli` : ton abonnement Claude via la commande officielle `claude -p` (Claude Code) ;
 * 3. `copy` : copie le prompt dans le presse-papiers pour le coller dans l'app Claude.
 * Un fournisseur indisponible ou en échec laisse la main au suivant ; un refus de consentement arrête tout.
 */
export async function askAi(ctx: vscode.ExtensionContext, p: Prompt, what: string): Promise<AiResult> {
  const text = `${p.system}\n\n${p.user}`;
  const cfg = vscode.workspace.getConfiguration('depgraph');
  const notes: string[] = [];

  for (const provider of providerOrder(cfg)) {
    if (provider === 'copy') {
      const r = await copyPrompt(text);
      return r.ok || !notes.length ? r : { ...r, message: `${notes.join(' ')} ${r.message}` };
    }
    const r = provider === 'copilot' ? await viaCopilot(ctx, cfg, text, what) : await viaClaudeCli(ctx, cfg, text, what);
    if (r === null) continue; // fournisseur indisponible : suivant
    if (r.ok || r.reason === 'cancelled') return r;
    notes.push(r.message); // en échec (quota, refus…) : on essaie le suivant
  }
  return { ok: false, reason: 'error', message: notes.join(' ') || "Aucun fournisseur d'IA disponible (réglage depgraph.aiProviders)." };
}

async function consent(ctx: vscode.ExtensionContext, key: string, message: string): Promise<boolean> {
  if (ctx.globalState.get<boolean>(key)) return true;
  const ok = await vscode.window.showWarningMessage(message, { modal: true }, 'Continuer');
  if (ok !== 'Continuer') return false;
  await ctx.globalState.update(key, true);
  return true;
}

/**
 * Écarte les entrées inutilisables de la liste renvoyée par VS Code : modèles internes (`copilot-utility…`,
 * dictée), contexte trop petit pour un graphe (< 30 000 tokens) et doublons du fournisseur `copilotcli`
 * quand le fournisseur `copilot` existe.
 */
export function usableModels(all: vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const keep = all.filter((m) => !/^copilot-/.test(m.family) && !/^copilot-/.test(m.id) && m.id !== 'auto' && (m.maxInputTokens ?? Infinity) >= 30_000);
  const main = keep.filter((m) => m.vendor === 'copilot');
  return main.length ? main : keep;
}

async function viaCopilot(ctx: vscode.ExtensionContext, cfg: vscode.WorkspaceConfiguration, text: string, what: string): Promise<AiResult | null> {
  let models: vscode.LanguageModelChat[] = [];
  try { models = await vscode.lm.selectChatModels({}); } catch { /* API indisponible */ }
  models = usableModels(models);
  if (models.length === 0) return null;

  // Le contenu part vers le fournisseur du modèle : on demande une fois, explicitement.
  if (!(await consent(ctx, CONSENT_COPILOT,
    `Pour ${what}, des extraits de ton code (noms de fichiers, relations, contenu d'un fichier) seront envoyés au modèle sélectionné dans VS Code (GitHub Copilot). Continuer ?`))) {
    return { ok: false, reason: 'cancelled', message: 'Annulé.' };
  }

  const family = cfg.get<string>('aiModelFamily', '');
  const model =
    (family && models.find((m) => m.family === family || m.id === family)) ||
    models.find((m) => /sonnet/i.test(m.family)) ||
    models.find((m) => /claude/i.test(m.family)) ||
    models[0];

  try {
    const cts = new vscode.CancellationTokenSource();
    const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(text)], {}, cts.token);
    let out = '';
    for await (const chunk of res.text) out += chunk;
    if (!out.trim()) throw new Error('réponse vide');
    return { ok: true, text: out.trim(), model: model.name ?? model.family };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    const detail = err.code === 'NoPermissions' ? "l'accès au modèle a été refusé" : err.message ?? String(e);
    return { ok: false, reason: 'error', message: `Copilot n'a pas répondu (${detail}).` };
  }
}

/**
 * Appelle la commande officielle `claude -p` (Claude Code), qui utilise l'abonnement auquel tu es connecté.
 * - lancé depuis un dossier temporaire vide : un projet inconnu ne peut pas y déclencher ses propres hooks ;
 * - sans outils (`--tools ""`) : le modèle ne lit ni n'écrit aucun fichier ;
 * - la clé ANTHROPIC_API_KEY est retirée de l'environnement, sinon l'appel serait facturé à l'API.
 */
async function viaClaudeCli(ctx: vscode.ExtensionContext, cfg: vscode.WorkspaceConfiguration, text: string, what: string): Promise<AiResult | null> {
  const bin = cfg.get<string>('claudeCliPath', 'claude') || 'claude';
  if (text.length > MAX_PROMPT) return { ok: false, reason: 'error', message: 'Claude CLI : prompt trop volumineux.' };
  if (!(await consent(ctx, CONSENT_CLAUDE,
    `Pour ${what}, des extraits de ton code seront envoyés à Anthropic via la commande « claude » (ton compte Claude personnel). Vérifie que la politique de ton employeur ou de ton client l'autorise. Continuer ?`))) {
    return { ok: false, reason: 'cancelled', message: 'Annulé.' };
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-claude-'));
  try {
    return await new Promise<AiResult | null>((resolve) => {
      let out = '', err = '', done = false;
      const finish = (r: AiResult | null) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const child = spawn(bin, ['-p', '--output-format', 'json', '--tools', ''], { cwd, env, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); finish({ ok: false, reason: 'error', message: 'Claude CLI : délai dépassé.' }); }, CLI_TIMEOUT_MS);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e: NodeJS.ErrnoException) =>
        finish(e.code === 'ENOENT' ? null : { ok: false, reason: 'error', message: `Claude CLI : ${e.message}` }));
      child.on('close', (code) => {
        let j: { result?: unknown; is_error?: boolean; modelUsage?: Record<string, unknown> } | null = null;
        try { j = JSON.parse(out); } catch { /* sortie non JSON */ }
        if (code === 0 && j && !j.is_error && typeof j.result === 'string' && j.result.trim()) {
          return finish({ ok: true, text: j.result.trim(), model: `Claude (${Object.keys(j.modelUsage ?? {})[0] ?? 'CLI'})` });
        }
        const detail = (typeof j?.result === 'string' ? j.result : err || out).trim().slice(0, 300) || `code ${code}`;
        finish({ ok: false, reason: 'error', message: `Claude CLI : ${detail} (es-tu connecté ? lance « claude » dans un terminal).` });
      });
      child.stdin.on('error', () => { /* le processus s'est arrêté avant la fin de l'écriture */ });
      child.stdin.end(text);
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function copyPrompt(text: string): Promise<AiResult> {
  await vscode.env.clipboard.writeText(text);
  return { ok: false, reason: 'copied', message: 'Le prompt a été copié : colle-le dans Claude (app ou claude.ai) pour obtenir la réponse.' };
}

/** Modèles que VS Code expose à l'extension (identifiants techniques à mettre dans `aiModelFamily`). */
export async function describeModels(): Promise<string> {
  let models: vscode.LanguageModelChat[] = [];
  try { models = await vscode.lm.selectChatModels({}); } catch (e) { return `API indisponible : ${(e as Error).message}`; }
  if (!models.length) return "Aucun modèle exposé par VS Code (GitHub Copilot Chat est-il installé, connecté, et le modèle autorisé par ton organisation ?).";
  const rows = models.map((m) => `- nom : ${m.name} | family : ${m.family} | id : ${m.id} | éditeur : ${m.vendor} | contexte max : ${m.maxInputTokens} tokens`);
  return `Modèles disponibles pour l'extension (${models.length}) :\n${rows.join('\n')}`;
}
