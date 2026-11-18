import { build } from 'esbuild';

const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// Partie Node de l'extension (extension host)
await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
});

// Partie navigateur (webview)
await build({
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
});

// Ligne de commande pour la CI : `node dist/cli.js [dossier]`
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
});
