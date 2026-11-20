import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { GLink, GNode, Layer } from './shared/types';
import { findCycles } from './shared/graph';
import { ClassInfo, namesOf, parseSource, readClasses, readImportSpecs } from './ts-read';

interface RawModule {
  id: string;
  file: string;
  name: string;
  line: number;
  refs: string[]; // noms des modules importés
  providers: string[];
  controllers: string[];
  exports: string[];
  providerEntries: ProviderEntry[];
  importSpecs: Map<string, string>; // nom local -> chemin d'import (pour départager des noms identiques)
}

/** Un élément du tableau `providers` : la classe fournie et/ou le jeton qui la désigne. */
interface ProviderEntry { token: string | null; classes: string[]; injects: string[] }

function providerEntry(e: ts.Expression): ProviderEntry {
  if (ts.isIdentifier(e)) return { token: e.text, classes: [e.text], injects: [] };
  if (ts.isObjectLiteralExpression(e)) {
    let token: string | null = null;
    const classes: string[] = [];
    const injects: string[] = [];
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = p.name.getText();
      if (k === 'provide') token = ts.isIdentifier(p.initializer) || ts.isStringLiteralLike(p.initializer) ? p.initializer.text : null;
      else if (k === 'useClass' || k === 'useExisting') classes.push(...namesOf(p.initializer));
      // useFactory: (cfg: ConfigService) => …, inject: [ConfigService] : ces classes sont bien utilisées
      else if (k === 'inject' && ts.isArrayLiteralExpression(p.initializer)) for (const x of p.initializer.elements) injects.push(...namesOf(x));
    }
    return { token, classes, injects };
  }
  return { token: null, classes: [], injects: [] };
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

const SPECIAL_NAME = /(Guard|Interceptor|Pipe|Filter|Strategy|Middleware|Resolver|Gateway|Processor|Consumer|Listener|Subscriber|Handler|Scheduler|Task|Job|Seeder|Command|Adapter)$/;
const TEST_FILE = /\.(spec|test|e2e-spec)\.[cm]?[jt]s$|(^|\/)(__tests__|__mocks__)\//;
const readable = (f: string) => /\.[cm]?[jt]s$/.test(f);

export interface NestResult {
  modules: Layer; // un nœud par @Module
  classes: Layer; // modules + controllers + providers, liens d'import / de déclaration / d'injection
}

/**
 * Lit le projet NestJS :
 * - `@Module({ imports, providers, controllers, exports })` pour le graphe des modules ;
 * - `@Controller` / `@Injectable` et les paramètres de constructeur pour le graphe des injections
 *   (l'injection de dépendances : Nest fournit lui-même à une classe les instances dont elle a besoin).
 */
export function parseNest(
  root: string,
  files: string[],
  resolveSpec: (from: string, spec: string) => string | null,
): NestResult {
  const raws: RawModule[] = [];
  const texts = new Map<string, string>();
  const classesByFile = new Map<string, { sf: ts.SourceFile; infos: ClassInfo[]; specs: Map<string, string> }>();

  for (const file of files) {
    if (!readable(file)) continue;
    let text: string;
    try {
      const abs = path.join(root, file);
      if (fs.statSync(abs).size > 500_000) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    texts.set(file, text);
    if (!/@(Module|Controller|Injectable)\b/.test(text)) continue;

    const sf = parseSource(file, text);
    const importSpecs = readImportSpecs(sf);
    const infos = readClasses(sf);
    classesByFile.set(file, { sf, infos, specs: importSpecs });
    if (!text.includes('@Module(')) continue;

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
        const providerExprs = obj ? listOf(obj, 'providers') : [];
        raws.push({
          id: countInFile === 0 ? file : `${file}#${name}`,
          file,
          name,
          line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1,
          refs: obj ? listOf(obj, 'imports').flatMap(namesOf) : [],
          providers: providerExprs.map(providerName).filter((x): x is string => !!x),
          controllers: obj ? listOf(obj, 'controllers').flatMap(namesOf) : [],
          exports: obj ? listOf(obj, 'exports').flatMap(namesOf) : [],
          providerEntries: providerExprs.map(providerEntry),
          importSpecs,
        });
        countInFile++;
      }
    }
  }

  // ---- couche « modules » ----
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
      links.push({ source: m.id, target: target.id, kind: 'import' });
    }
    return {
      id: m.id,
      label: m.name,
      dir: path.posix.dirname(m.file),
      kind: 'module' as const,
      file: m.file,
      line: m.line,
      role: 'module' as const,
      nest: {
        name: m.name,
        providers: [...new Set(m.providers)],
        controllers: [...new Set(m.controllers)],
        exports: [...new Set(m.exports)],
        externalImports: external,
      },
    };
  });
  const modules: Layer = { nodes, links: links.map((l) => ({ source: l.source, target: l.target })), cycles: findCycles(nodes.map((n) => n.id), links) };

  // ---- couche « modules + classes » ----
  const classNodes: GNode[] = [];
  const classInfoById = new Map<string, ClassInfo & { file: string }>();
  const byClassName = new Map<string, string[]>();
  for (const [file, { infos }] of classesByFile) {
    for (const c of infos) {
      const isCtrl = c.decorators.includes('Controller');
      const isProv = c.decorators.includes('Injectable');
      if (!isCtrl && !isProv) continue;
      const id = `${file}#${c.name}`;
      classInfoById.set(id, { ...c, file });
      byClassName.set(c.name, [...(byClassName.get(c.name) ?? []), id]);
      classNodes.push({
        id, label: c.name, dir: path.posix.dirname(file), kind: isCtrl ? 'controller' : 'service',
        file, line: c.line, role: isCtrl ? 'controller' : 'provider', isTest: TEST_FILE.test(file) || undefined,
      });
    }
  }
  const resolveClass = (fromFile: string, specs: Map<string, string>, name: string): string | null => {
    const spec = specs.get(name);
    if (spec) {
      const f = resolveSpec(fromFile, spec);
      if (f && classInfoById.has(`${f}#${name}`)) return `${f}#${name}`;
    }
    if (classInfoById.has(`${fromFile}#${name}`)) return `${fromFile}#${name}`;
    const c = byClassName.get(name);
    return c?.length === 1 ? c[0] : null;
  };

  const cLinks: GLink[] = [...links];
  const cSeen = new Set(cLinks.map((l) => `${l.source}\u0000${l.target}`));
  const add = (source: string, target: string, kind: 'declare' | 'inject') => {
    if (source === target) return;
    const k = `${source}\u0000${target}`;
    if (cSeen.has(k)) return;
    cSeen.add(k);
    cLinks.push({ source, target, kind });
  };

  // jeton -> classes qui le fournissent ; classes utilisées par des jetons du framework (APP_GUARD…)
  const tokenToClasses = new Map<string, string[]>();
  const frameworkUsed = new Set<string>();
  const exported = new Set<string>();
  for (const m of raws) {
    for (const e of m.providerEntries) {
      const ids = e.classes.map((n) => resolveClass(m.file, m.importSpecs, n)).filter((x): x is string => !!x);
      if (e.token) tokenToClasses.set(e.token, [...(tokenToClasses.get(e.token) ?? []), ...ids]);
      if (e.token?.startsWith('APP_')) ids.forEach((i) => frameworkUsed.add(i));
      for (const n of e.injects) { const id = resolveClass(m.file, m.importSpecs, n); if (id) frameworkUsed.add(id); }
    }
    const moduleId = m.id;
    for (const n of [...m.providerEntries.flatMap((e) => e.classes), ...m.controllers]) {
      const id = resolveClass(m.file, m.importSpecs, n);
      if (id) add(moduleId, id, 'declare');
    }
    for (const n of m.exports) { const id = resolveClass(m.file, m.importSpecs, n); if (id) exported.add(id); }
  }

  for (const [id, c] of classInfoById) {
    const specs = classesByFile.get(c.file)!.specs;
    for (const p of c.ctor) {
      let targets: string[] = [];
      if (p.type) {
        const t = resolveClass(c.file, specs, p.type);
        if (t) targets = [t];
        // classe abstraite / interface utilisée comme jeton : { provide: Cache, useClass: RedisCache }
        targets.push(...(tokenToClasses.get(p.type) ?? []));
      } else if (p.token) targets = tokenToClasses.get(p.token) ?? [];
      for (const t of targets) add(id, t, 'inject');
    }
  }

  // ---- providers probablement inutilisés ----
  const stripImports = (t: string) =>
    t.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '').replace(/^\s*export\s[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const scanText: { file: string; text: string }[] = [];
  for (const [file, text] of texts) {
    if (TEST_FILE.test(file) || /\.module\.[cm]?[jt]s$/.test(file)) continue;
    scanText.push({ file, text: stripImports(text) });
  }
  const injected = new Set(cLinks.filter((l) => l.kind === 'inject').map((l) => l.target));
  for (const n of classNodes) {
    if (n.role !== 'provider' || n.isTest) continue;
    const c = classInfoById.get(n.id)!;
    const special =
      SPECIAL_NAME.test(c.name) || c.decorators.some((d) => d !== 'Injectable') ||
      c.methodDecorators.length > 0 || c.implementsNames.length > 0;
    if (injected.has(n.id) || exported.has(n.id) || frameworkUsed.has(n.id) || special) continue;
    const re = new RegExp(`(?<![\\w$])${c.name.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (scanText.some((t) => t.file !== c.file && re.test(t.text))) continue;
    n.orphan = true;
  }

  const all = [...nodes, ...classNodes];
  const classes: Layer = {
    nodes: all,
    links: cLinks,
    cycles: findCycles(all.map((n) => n.id), cLinks.filter((l) => l.kind !== 'declare')),
  };
  return { modules, classes };
}
