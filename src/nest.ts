import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { GLink, GNode, Layer } from './shared/types';
import { findCycles } from './shared/graph';

interface RawModule {
  id: string;
  file: string;
  name: string;
  line: number;
  refs: string[]; // noms des modules importés
  providers: string[];
  controllers: string[];
  exports: string[];
  importSpecs: Map<string, string>; // nom local -> chemin d'import (pour départager des noms identiques)
}

/** Noms de classes référencés par une expression : `Foo`, `Foo.forRoot()`, `forwardRef(() => Foo)`. */
function namesOf(e: ts.Expression): string[] {
  if (ts.isIdentifier(e)) return [e.text];
  if (ts.isPropertyAccessExpression(e)) return namesOf(e.expression);
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return namesOf(e.expression);
  if (ts.isCallExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === 'forwardRef') {
      const a = e.arguments[0];
      if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
        const body = a.body;
        if (ts.isBlock(body)) {
          const ret = body.statements.find(ts.isReturnStatement);
          return ret?.expression ? namesOf(ret.expression) : [];
        }
        return namesOf(body);
      }
      return [];
    }
    return namesOf(e.expression);
  }
  return [];
}

/** Nom affichable d'un provider : `UsersService` ou `{ provide: TOKEN, useClass: … }`. */
function providerName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === 'provide') {
        const v = p.initializer;
        if (ts.isIdentifier(v) || ts.isStringLiteralLike(v)) return v.text;
        return v.getText().slice(0, 40);
      }
    }
  }
  return null;
}

function listOf(obj: ts.ObjectLiteralExpression, key: string): ts.Expression[] {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key && ts.isArrayLiteralExpression(p.initializer)) {
      return [...p.initializer.elements];
    }
  }
  return [];
}

/**
 * Lit les décorateurs `@Module({ imports, providers, controllers, exports })` pour construire le graphe
 * des modules NestJS (le vrai graphe d'injection de dépendances au niveau module).
 */
export function parseNest(
  root: string,
  files: string[],
  resolveSpec: (from: string, spec: string) => string | null,
): Layer {
  const raws: RawModule[] = [];

  for (const file of files) {
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    let text: string;
    try {
      const abs = path.join(root, file);
      if (fs.statSync(abs).size > 500_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (!text.includes('@Module(')) continue;

    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const importSpecs = new Map<string, string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
      const spec = st.moduleSpecifier.text;
      if (st.importClause.name) importSpecs.set(st.importClause.name.text, spec);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) importSpecs.set(el.name.text, spec);
    }

    let countInFile = 0;
    for (const st of sf.statements) {
      if (!ts.isClassDeclaration(st)) continue;
      const decs = ts.canHaveDecorators(st) ? ts.getDecorators(st) ?? [] : [];
      for (const d of decs) {
        const ex = d.expression;
        if (!ts.isCallExpression(ex) || !ts.isIdentifier(ex.expression) || ex.expression.text !== 'Module') continue;
        const arg = ex.arguments[0];
        const obj = arg && ts.isObjectLiteralExpression(arg) ? arg : undefined;
        const name = st.name?.text ?? 'default';
        raws.push({
          id: countInFile === 0 ? file : `${file}#${name}`,
          file,
          name,
          line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1,
          refs: obj ? listOf(obj, 'imports').flatMap(namesOf) : [],
          providers: obj ? listOf(obj, 'providers').map(providerName).filter((x): x is string => !!x) : [],
          controllers: obj ? listOf(obj, 'controllers').flatMap(namesOf) : [],
          exports: obj ? listOf(obj, 'exports').flatMap(namesOf) : [],
          importSpecs,
        });
        countInFile++;
      }
    }
  }

  const byName = new Map<string, RawModule[]>();
  for (const m of raws) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);

  const links: GLink[] = [];
  const seen = new Set<string>();
  const nodes: GNode[] = raws.map((m) => {
    const external: string[] = [];
    for (const ref of new Set(m.refs)) {
      const cands = byName.get(ref);
      let target: RawModule | undefined;
      if (cands?.length === 1) target = cands[0];
      else if (cands && cands.length > 1) {
        const spec = m.importSpecs.get(ref);
        const resolved = spec ? resolveSpec(m.file, spec) : null;
        target = cands.find((c) => c.file === resolved) ?? cands[0];
      }
      if (!target) { external.push(ref); continue; }
      if (target.id === m.id) continue;
      const key = `${m.id}\u0000${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: m.id, target: target.id });
    }
    return {
      id: m.id,
      label: m.name,
      dir: path.posix.dirname(m.file),
      kind: 'module' as const,
      file: m.file,
      line: m.line,
      nest: {
        name: m.name,
        providers: [...new Set(m.providers)],
        controllers: [...new Set(m.controllers)],
        exports: [...new Set(m.exports)],
        externalImports: external,
      },
    };
  });

  return { nodes, links, cycles: findCycles(nodes.map((n) => n.id), links) };
}
