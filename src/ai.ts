import * as vscode from 'vscode';
import { Prompt } from './prompts';

export type AiResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: 'copied' | 'cancelled' | 'error'; message: string };

const CONSENT_KEY = 'depgraph.aiConsent';

/**
 * Interroge un modèle via l'API de modèles de langage de VS Code (celle de GitHub Copilot), sans clé API.
 * Si aucun modèle n'est disponible, le prompt est copié dans le presse-papiers pour le coller dans l'app Claude.
 */
export async function askAi(ctx: vscode.ExtensionContext, p: Prompt, what: string): Promise<AiResult> {
  const text = `${p.system}\n\n${p.user}`;
  const cfg = vscode.workspace.getConfiguration('depgraph');
  const provider = cfg.get<string>('aiProvider', 'auto');

  if (provider === 'copy') return copyPrompt(text);

  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({});
  } catch { /* API indisponible : on bascule sur la copie */ }
  if (models.length === 0) {
    const r = await copyPrompt(text);
    return r.ok ? r : { ...r, message: `Aucun modèle disponible via VS Code (GitHub Copilot est-il installé et connecté ?). ${r.message}` };
  }

  // Le contenu part vers le fournisseur du modèle : on demande une fois, explicitement.
  if (!ctx.globalState.get<boolean>(CONSENT_KEY)) {
    const ok = await vscode.window.showWarningMessage(
      `Pour ${what}, des extraits de ton code (noms de fichiers, relations, contenu d'un fichier) seront envoyés au modèle sélectionné dans VS Code (GitHub Copilot). Continuer ?`,
      { modal: true }, 'Continuer',
    );
    if (ok !== 'Continuer') return { ok: false, reason: 'cancelled', message: 'Annulé.' };
    await ctx.globalState.update(CONSENT_KEY, true);
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
    return { ok: false, reason: 'error', message: `Le modèle n'a pas répondu (${detail}).` };
  }
}

async function copyPrompt(text: string): Promise<AiResult> {
  await vscode.env.clipboard.writeText(text);
  return { ok: false, reason: 'copied', message: 'Le prompt a été copié : colle-le dans Claude (app ou claude.ai) pour obtenir la réponse.' };
}
