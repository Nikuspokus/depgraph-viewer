import * as fs from 'fs';
import * as path from 'path';
import { GLink, Violation } from './shared/types';

export interface Rule {
  name: string;
  from: string[]; // fichiers concernés (globs)
  notTo?: string[]; // ces fichiers ne doivent PAS importer…
  onlyTo?: string[]; // …ou ne doivent importer QUE ceux-là
}

export interface RulesResult {
  present: boolean;
  rules: Rule[];
  error?: string;
}

const CANDIDATES = ['.depgraph-rules.json', '.depgraph/rules.json'];

/** Glob → RegExp : `**` = n'importe quels dossiers, `*` = dans un dossier, `?` = un caractère. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  if (!/[*?]/.test(g)) return new RegExp(`^${escape(g)}(?:/.*)?$`); // dossier ou fichier exact
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function asList(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

export function loadRules(root: string): RulesResult {
  for (const c of CANDIDATES) {
    const p = path.join(root, c);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || !Array.isArray(raw.rules)) return { present: true, rules: [], error: `${c} : la clé "rules" (tableau) est obligatoire.` };
      const rules: Rule[] = [];
      for (const [i, r] of raw.rules.entries()) {
        const from = asList(r?.from);
        const notTo = asList(r?.notTo);
        const onlyTo = asList(r?.onlyTo);
        if (typeof r?.name !== 'string' || !from || (!notTo && !onlyTo)) {
          return { present: true, rules: [], error: `${c} : la règle n°${i + 1} doit avoir "name", "from" et "notTo" et/ou "onlyTo".` };
        }
        rules.push({ name: r.name, from, notTo, onlyTo });
      }
      return { present: true, rules };
    } catch (e) {
      return { present: true, rules: [], error: `${c} : JSON invalide (${(e as Error).message}).` };
    }
  }
  return { present: false, rules: [] };
}

export function checkRules(rules: Rule[], links: GLink[]): Violation[] {
  const compiled = rules.map((r) => ({
    r,
    from: r.from.map(globToRegExp),
    notTo: r.notTo?.map(globToRegExp),
    onlyTo: r.onlyTo?.map(globToRegExp),
  }));
  const out: Violation[] = [];
  for (const l of links) {
    for (const c of compiled) {
      if (!c.from.some((re) => re.test(l.source))) continue;
      const forbidden = c.notTo?.some((re) => re.test(l.target));
      const outside = c.onlyTo && !c.onlyTo.some((re) => re.test(l.target)) && !c.from.some((re) => re.test(l.target));
      if (forbidden || outside) out.push({ rule: c.r.name, source: l.source, target: l.target });
    }
  }
  return out;
}
