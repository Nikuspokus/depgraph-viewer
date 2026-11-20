# Changelog

## 0.7.0
- IA : ordre de fournisseurs réglable (`depgraph.aiProviders`) : Copilot, puis Claude via la commande `claude` (abonnement, sans clé API), puis copie du prompt.
- Commande `Dependency Graph: List AI Models` : liste les modèles exposés par VS Code (family, id, contexte).

## 0.6.1
- Providers inutilisés : moins de faux positifs (`useFactory` + `inject`, classe abstraite fournie via `useClass`, noms avec `$`).

## 0.6.0
- Vue NestJS « modules + classes » : controllers, providers, injections par constructeur, `@Inject(forwardRef)` et jetons.
- Providers probablement inutilisés : couleur, filtre et soulignement dans l'éditeur.
- Revue PR : impact, tests, projets, nouveaux problèmes vs base, points chauds, résumé Markdown copiable.
- Points chauds : score de risque (impact, churn, cycle, absence de test).
- Liste des projets de monorepo impactés par un changement.
- CLI : `--base <ref>` pour ne compter que les nouveaux problèmes.

## 0.5.x
Modules Nest, packages, impact Git, comparaison, règles d'architecture, export, IA sans clé API, CLI.
