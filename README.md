# Dependency Graph Viewer

Affiche le graphe de dépendances (imports) d'un projet **TS / JS / Vue / Svelte / NestJS** en organigramme, 2D ou 3D : cycles, incidents, simulation de panne, impact Git, règles d'architecture.

## Utilisation

1. Ouvre un dossier de projet dans VS Code.
2. `Cmd/Ctrl+Shift+P` → **Dependency Graph: Show**.
3. Choisis la vue dans la barre du haut : **Organigramme** (hiérarchie à plat : points d'entrée en haut, fichiers partagés en bas), **2D** ou **3D**.
4. Le bouton **Organiser** recalcule la hiérarchie (organigramme) ou écarte les nœuds et les regroupe par dossier (2D/3D).

| Action | Effet |
| --- | --- |
| Survol d'un nœud | Aperçu immédiat : tout ce qui serait impacté passe en orange, le reste est estompé |
| Clic sur un nœud | Fige la simulation et détaille les fichiers impactés dans le panneau latéral |
| Clic droit sur un nœud | Ouvre le fichier dans l'éditeur |
| Clic dans le vide | Désélectionne |
| Recherche + Entrée | Sélectionne et centre le premier fichier correspondant |

Couleurs : module Nest (bleu), controller (violet), service (turquoise), Vue (vert), Svelte (orange vif), cycle (rose), incident (rouge). La taille d'un nœud augmente avec le nombre de fichiers qui l'importent.

## Filtres

Cases par type de fichier, champ de chemin (`auth, users, !shared` : mots séparés par des virgules, `!` exclut), « Masquer importés par ≥ N », « Masquer isolés », « Masquer tests » (actif par défaut, `depgraph.hideTestsByDefault`) et **Regrouper** par dossier (niveau 1 à 4 ; clic droit sur un dossier pour le déplier). Les filtres ne changent que l'affichage : les impacts sont toujours calculés sur le projet entier.

## Vues

Le sélecteur **Vue** bascule entre **Fichiers**, **Modules NestJS** (décorateurs `@Module` : imports entre modules, providers, controllers, exports ; clic droit = ouvre la ligne du décorateur) et **Packages** (monorepo : dépendances entre packages, détecté dès 2 `package.json`).

## Fonctions

- **Rafraîchissement automatique** à l'enregistrement, la création et la suppression de fichiers (`depgraph.autoRefresh`) ; caméra et sélection sont conservées.
- **Fichier actif** : anneau cyan sur le fichier ouvert ; « Suivre le fichier actif » recentre la vue.
- **Impact Git** : modifications non commitées, branche vs `main`, ou depuis un tag/commit. Fichiers modifiés en jaune, impactés en orange, et la liste des **tests à relancer** (copiable).
- **Comparer…** le projet actuel à une branche, un tag ou un commit : nœuds/liens ajoutés en vert, supprimés en rouge (fantômes).
- **Exporter** la vue en Mermaid (`.md`, s'affiche dans GitHub), SVG ou PNG.
- **IA** (résumer un fichier, suggérer des simulations, analyser le risque d'un diff) : utilise les modèles de VS Code (GitHub Copilot), **sans clé API**. Sans modèle disponible, ou avec `depgraph.aiProvider = copy`, le prompt est copié dans le presse-papiers pour le coller dans Claude. Une confirmation est demandée avant le premier envoi de code.

## Règles d'architecture

Fichier `.depgraph-rules.json` (ou `.depgraph/rules.json`) :

```json
{
  "rules": [
    { "name": "Un controller n'importe pas un repository", "from": "**/*.controller.ts", "notTo": "**/*.repository.ts" },
    { "name": "Le domaine ne dépend que du domaine", "from": "src/domain/**", "onlyTo": ["src/domain/**"] }
  ]
}
```

Les violations apparaissent en violet (liens, nœuds, panneau latéral). Exemple d'usage en CI :

```bash
curl -sL https://github.com/Nikuspokus/depgraph-viewer/releases/latest/download/cli.js -o depgraph-check.js
node depgraph-check.js . --fail-on-cycles   # code 1 si violation (ou cycle)
```

## Mises à jour

Au démarrage de VS Code (au plus toutes les 12 h), l'extension regarde la dernière release GitHub. S'il y a une version plus récente, elle propose **Installer** : le `.vsix` est téléchargé, son empreinte SHA-256 est vérifiée, puis installé. `Dependency Graph: Check for Updates` force la vérification (`depgraph.autoCheckUpdates` la désactive).

Publier : changer `version` dans `package.json`, commiter, pousser sur `main` ; GitHub Actions teste, construit le `.vsix` et crée la release.

## Incidents

`incidents.json` (ou `.depgraph/incidents.json`) à la racine du projet :

```json
[ { "file": "src/auth/auth.service.ts", "line": 42, "title": "Timeout sur login", "severity": "high" } ]
```

## Limites

- Analyse **statique** des imports (injection de dépendances Nest non résolue, pas de runtime) ; imports npm non affichés.
- Le scan est complet à chaque rafraîchissement (pas incrémental) : sur un très gros projet, filtre ou exclus des dossiers.
- Export Mermaid : au-delà de quelques centaines de nœuds, filtre ou regroupe avant.
