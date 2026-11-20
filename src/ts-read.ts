// Lecture partagée du code TypeScript (API du compilateur) : imports, classes, décorateurs, constructeurs.
import * as ts from 'typescript';

export interface CtorParam {
  type: string | null; // nom de la classe injectée (`UsersService`)
  token: string | null; // jeton explicite : @Inject(TOKEN) ou @Inject('nom')
  optional: boolean;
  forward: boolean; // @Inject(forwardRef(() => X))
}

export interface ClassInfo {
  name: string;
  line: number; // ligne du nom de la classe
  decorators: string[]; // noms des décorateurs de classe (sans @ ni arguments)
  ctor: CtorParam[]; // paramètres du constructeur + propriétés @Inject()
  implementsNames: string[];
  methodDecorators: string[]; // décorateurs de méthodes (@Cron, @OnEvent, @Get…)
}

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** nom local -> chemin d'import (`UsersService` -> `./users.service`). */
export function readImportSpecs(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const spec = st.moduleSpecifier.text;
    if (st.importClause.name) out.set(st.importClause.name.text, spec);
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) out.set(el.name.text, spec);
  }
  return out;
}

/** Noms de classes référencés par une expression : `Foo`, `Foo.forRoot()`, `forwardRef(() => Foo)`. */
export function namesOf(e: ts.Expression): string[] {
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

const decoratorsOf = (n: ts.Node): ts.Decorator[] => (ts.canHaveDecorators(n) ? [...(ts.getDecorators(n) ?? [])] : []);

function decoratorName(d: ts.Decorator): string | null {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

function typeName(t: ts.TypeNode | undefined): string | null {
  if (!t || !ts.isTypeReferenceNode(t)) return null;
  const n = t.typeName;
  return ts.isIdentifier(n) ? n.text : n.right.text;
}

/** Jeton / classe donnés à @Inject(...) : `@Inject(TOKEN)`, `@Inject('nom')`, `@Inject(forwardRef(() => X))`. */
function injectArg(d: ts.Decorator): { token: string | null; forward: string | null } {
  const e = d.expression;
  if (!ts.isCallExpression(e) || !e.arguments.length) return { token: null, forward: null };
  const a = e.arguments[0];
  if (ts.isCallExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === 'forwardRef') {
    return { token: null, forward: namesOf(a)[0] ?? null };
  }
  if (ts.isStringLiteralLike(a)) return { token: a.text, forward: null };
  if (ts.isIdentifier(a)) return { token: a.text, forward: null };
  return { token: null, forward: null };
}

function paramInfo(decs: ts.Decorator[], type: ts.TypeNode | undefined): CtorParam | null {
  const names = decs.map(decoratorName);
  let token: string | null = null;
  let forward = false;
  let t = typeName(type);
  const inj = decs.find((d) => decoratorName(d) === 'Inject');
  if (inj) {
    const a = injectArg(inj);
    if (a.forward) { t = a.forward; forward = true; } else if (a.token) token = a.token;
  }
  // @InjectRepository(User), @InjectModel(...) : injection fournie par une librairie, pas par une classe du projet
  if (names.some((n) => n && n !== 'Inject' && n !== 'Optional' && n.startsWith('Inject'))) return { type: null, token: null, optional: false, forward: false };
  if (!t && !token) return null;
  return { type: token ? null : t, token, optional: names.includes('Optional'), forward };
}

/** Classes d'un fichier avec leurs décorateurs et leurs dépendances de constructeur. */
export function readClasses(sf: ts.SourceFile): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const ctor: CtorParam[] = [];
    const methodDecorators: string[] = [];
    for (const m of st.members) {
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) {
          const info = paramInfo(decoratorsOf(p), p.type);
          if (info) ctor.push(info);
        }
      } else if (ts.isPropertyDeclaration(m)) {
        const decs = decoratorsOf(m);
        if (decs.some((d) => decoratorName(d) === 'Inject')) {
          const info = paramInfo(decs, m.type);
          if (info) ctor.push(info);
        }
      } else if (ts.isMethodDeclaration(m)) {
        for (const d of decoratorsOf(m)) { const n = decoratorName(d); if (n) methodDecorators.push(n); }
      }
    }
    const impl: string[] = [];
    for (const h of st.heritageClauses ?? []) {
      if (h.token === ts.SyntaxKind.ImplementsKeyword) {
        for (const t of h.types) if (ts.isIdentifier(t.expression)) impl.push(t.expression.text);
      }
    }
    out.push({
      name: st.name.text,
      line: sf.getLineAndCharacterOfPosition(st.name.getStart()).line + 1,
      decorators: decoratorsOf(st).map(decoratorName).filter((x): x is string => !!x),
      ctor,
      implementsNames: impl,
      methodDecorators,
    });
  }
  return out;
}
