// Types partagés entre la partie Node (extension) et le webview (navigateur).

export type NodeKind = 'module' | 'controller' | 'service' | 'vue' | 'svelte' | 'package' | 'folder' | 'other';

export interface NestInfo {
  name: string;
  providers: string[];
  controllers: string[];
  exports: string[];
  externalImports: string[]; // modules importés qui ne viennent pas du projet (TypeOrmModule, ConfigModule…)
}

export interface GNode {
  id: string; // chemin relatif au projet ("/"), ou identifiant propre à la vue
  label: string;
  dir: string;
  kind: NodeKind;
  file?: string; // fichier à ouvrir quand il diffère de l'id
  line?: number; // ligne à atteindre (1 = première)
  isTest?: boolean;
  pkg?: string; // dossier du package auquel appartient le fichier (monorepo)
  count?: number; // nombre de fichiers (vue packages) ou de membres (dossier regroupé)
  nest?: NestInfo;
  [k: string]: any; // la librairie de graphe ajoute x, y, fx, fy…
}

export interface GLink {
  source: string; // celui qui dépend…
  target: string; // …de celui-ci
  w?: number; // poids (nombre de liens agrégés)
}

export interface Layer {
  nodes: GNode[];
  links: GLink[];
  cycles: string[][];
}

export interface Incident {
  file: string;
  title: string;
  severity?: 'low' | 'medium' | 'high';
  line?: number;
}

export interface Violation {
  rule: string;
  source: string;
  target: string;
}

export interface Graph {
  files: Layer; // imports de fichiers
  nest: Layer; // modules NestJS (@Module)
  packages: Layer; // packages d'un monorepo
  incidents: Incident[];
  violations: Violation[];
  hasRules: boolean;
  rulesError?: string;
  stats: { files: number; links: number; unresolved: number; nestModules: number; packages: number };
}

export interface LayerDiff {
  addedNodes: string[];
  removedNodes: GNode[];
  addedLinks: GLink[];
  removedLinks: GLink[];
}

export interface CompareResult {
  ref: string;
  files: LayerDiff;
  nest: LayerDiff;
  packages: LayerDiff;
}

export interface ChangeSet {
  label: string;
  files: string[]; // chemins relatifs au projet
}
