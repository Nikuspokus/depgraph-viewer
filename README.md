# Dependency Graph Viewer

Affiche le graphe de dépendances (imports) d'un projet **TS / JS / Vue / Svelte / NestJS** en 2D ou en 3D.

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

Barre sous la barre d'outils : cases par type de fichier, champ de chemin (`auth, users, !shared` : mots séparés par des virgules, `!` exclut), « Masquer importés par ≥ N » (retire les utilitaires omniprésents) et « Masquer isolés ». Les filtres ne changent que l'affichage : les impacts sont toujours calculés sur le projet entier.

## Mises à jour

Au démarrage de VS Code (au plus toutes les 12 h), l'extension regarde la dernière release GitHub du dépôt. S'il y a une version plus récente, elle propose **Installer** : le `.vsix` est téléchargé, son empreinte SHA-256 est vérifiée, puis installé. La commande `Dependency Graph: Check for Updates` force la vérification, et le réglage `depgraph.autoCheckUpdates` la désactive.

Publier une version : changer `version` dans `package.json`, commiter, puis `git tag vX.Y.Z && git push --tags`. GitHub Actions construit le `.vsix` et crée la release.

## Incidents

Crée un fichier `incidents.json` (ou `.depgraph/incidents.json`) à la racine du projet :

```json
[
  { "file": "src/auth/auth.service.ts", "title": "Timeout sur login", "severity": "high" }
]
```

`severity` : `low`, `medium` ou `high`. Les fichiers qui n'existent pas sont ignorés.

## Réglages

- `depgraph.excludeDirs` : dossiers supplémentaires à ignorer.
- `depgraph.includeTests` : inclure `*.spec.*` / `*.test.*` (désactivé par défaut).

## Limites de la v0.1

- Analyse **statique** des imports uniquement (pas d'injection de dépendances Nest résolue, pas de runtime).
- Les imports de paquets npm ne sont pas affichés ; les alias exotiques (hors `tsconfig paths`, `@/`, `~/`) ne sont pas résolus.
