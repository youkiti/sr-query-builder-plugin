import knownWords from './b1/known-words.json';

export interface OvidLine { n: number; body: string }
export type ApproximationKind = 'proximity_to_and' | 'wildcard_expanded' | 'phrase_truncation' | 'field_widened' | 'mesh_dropped' | 'unsupported';
export interface ManualOverride { query: string; note: string }
export interface TranspileOptions {
  meshHeadings?: readonly string[];
  knownWords?: readonly string[];
  overrides?: Record<string, ManualOverride>;
}
export interface PubmedLine {
  n: number; source: string; query: string;
  approximations: { kind: ApproximationKind; detail: string }[];
  manualOverride?: ManualOverride;
}

const subheadings: Record<string, string> = {
  su: 'surgery', ad: 'administration and dosage', ae: 'adverse effects', de: 'drug effects',
  sd: 'supply and distribution', tu: 'therapeutic use', th: 'therapy', to: 'toxicity', pd: 'pharmacology',
};
const wildcards: Record<string, string[]> = {
  'non?proliferative': ['nonproliferative', 'non proliferative'],
  'neo?vasculari*': ['neovascularis*', 'neovasculariz*'],
  'h?emorrhage*': ['hemorrhage*', 'haemorrhage*'],
};
const fields: Record<string, string[]> = {
  tw: ['tiab'], 'ti,ab': ['tiab'], 'tw,kf': ['tiab', 'ot'], ti: ['ti'], ab: ['tiab'],
  kw: ['ot'], kf: ['ot'], pt: ['pt'], jn: ['ta'], sh: ['sh'], mp: ['mp'],
};
const join = (parts: string[], op: string) => {
  const present = parts.filter(Boolean);
  return present.length > 1 ? `(${present.join(` ${op} `)})` : present[0] ?? '';
};

export function parseOvid(text: string): OvidLine[] {
  const source = text.replace(/^\s*#.*$/gm, '').trim();
  const matches = [...source.matchAll(/(?:^|\s)(\d+)\.\s+/g)];
  if (!matches.length && source) throw new Error('Ovid line numbers are missing');
  const lines = matches.map((match, i) => ({ n: Number(match[1]),
    body: source.slice(match.index! + match[0].length, matches[i + 1]?.index ?? source.length).trim() }));
  if (lines.some((line, i) => line.n !== i + 1 || !line.body)) throw new Error('Ovid lines must be consecutive and nonempty');
  return lines;
}

/** Split only outside parentheses and quotes; suffix fields bind to their preceding group. */
function splitTop(text: string, operator: RegExp): string[] {
  let depth = 0;
  let quoted = false;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    if (quoted) continue;
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth < 0) throw new Error(`Unbalanced parentheses: ${text}`);
    if (depth === 0) {
      const match = text.slice(i).match(operator);
      if (match) { parts.push(text.slice(start, i).trim()); i += match[0].length - 1; start = i + 1; }
    }
  }
  if (depth || quoted) throw new Error(`Unbalanced expression: ${text}`);
  parts.push(text.slice(start).trim());
  return parts;
}
function unwrap(text: string): string {
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0;
    let quoted = false;
    let whole = true;
    for (let i = 0; i < text.length - 1; i++) {
      if (text[i] === '"') quoted = !quoted;
      if (quoted) continue;
      if (text[i] === '(') depth++;
      if (text[i] === ')') depth--;
      if (depth === 0) { whole = false; break; }
    }
    if (!whole) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function transpile(lines: readonly OvidLine[], options: TranspileOptions = {}): PubmedLine[] {
  const headings = new Set((options.meshHeadings ?? []).map((word) => word.toLowerCase()));
  const vocabulary = new Set((options.knownWords ?? knownWords).map((word) => word.toLowerCase()));
  for (const [id, override] of Object.entries(options.overrides ?? {})) {
    if (!lines.some((line) => String(line.n) === id) || typeof override?.query !== 'string' || !override.query.trim()
      || typeof override.note !== 'string' || !override.note.trim()) throw new Error(`Invalid override: ${id}`);
  }
  const previous = new Map<number, string>();
  const unresolved = new Set<number>();
  return lines.map(({ n, body }) => {
    const approximations: PubmedLine['approximations'] = [];
    const note = (kind: ApproximationKind, detail: string) => {
      if (!approximations.some((a) => a.kind === kind && a.detail === detail)) approximations.push({ kind, detail });
    };
    const reference = (id: number) => {
      if (!previous.has(id)) throw new Error(`Line ${n}: unresolved reference ${id}`);
      if (unresolved.has(id)) note('unsupported', `unsupported reference ${id}`);
      if (!previous.get(id)) { note('unsupported', `empty reference ${id}`); return ''; }
      return `(${previous.get(id)})`;
    };
    const variants = (term: string): string[] => {
      const phraseNote = () => note('phrase_truncation', `${term}: singular/plural expansion requires known complete words`);
      if ((/\s/.test(term) || term.startsWith('"')) && term.includes('*')) phraseNote();
      let terms = [term.replace(/^"|"$/g, '')];
      for (const token of term.match(/[^\s"()]*\?[^\s"()]*/g) ?? []) {
        const expansions = wildcards[token.toLowerCase()];
        if (!expansions) { note('unsupported', token); return []; }
        note('wildcard_expanded', `${token} → ${expansions.join(' OR ')}`);
        terms = terms.flatMap((value) => expansions.map((word) => value.replace(token, word)));
      }
      if (terms.some((value) => (/\s/.test(value) || term.startsWith('"')) && value.includes('*'))) {
        phraseNote();
        const unknown = terms.flatMap((value) => value.split(/\s+/)).filter((word) => word.includes('*')
          && (!/^[^*]+\*$/.test(word) || !vocabulary.has(word.slice(0, -1).toLowerCase())));
        if (unknown.length) { note('unsupported', `${term}: unknown truncated stems ${[...new Set(unknown)].join(', ')}`); return []; }
        terms = terms.flatMap((value) => {
          let expanded = [''];
          for (const word of value.split(/\s+/)) {
            const stem = word.replace(/\*$/, '');
            const forms = word.endsWith('*') ? [stem, /[^aeiou]y$/i.test(stem) ? stem.slice(0, -1) + 'ies' : stem + 's'] : [word];
            expanded = expanded.flatMap((prefix) => forms.map((form) => `${prefix} ${form}`.trim()));
          }
          return expanded;
        });
      }
      return terms;
    };
    const render = (source: string, field?: string): string => {
      const text = unwrap(source.trim());
      if (/^exp animals\/ not humans\/$/i.test(text)) return '("Animals"[Mesh] NOT "Humans"[Mesh])';
      for (const op of ['or', 'and', 'not']) {
        const parts = splitTop(text, new RegExp(`^\\s+${op}\\s+`, 'i'));
        if (parts.length > 1) {
          const rendered = parts.map((part) => render(part, field));
          // Dropping an unsupported NOT operand must not invert the remaining operand.
          if (op === 'not' && rendered.some((part) => !part)) { note('unsupported', text); return ''; }
          return join(rendered, op.toUpperCase());
        }
      }
      const suffix = text.match(/\.([a-z]+(?:,[a-z]+)*)\.$/i);
      if (suffix) {
        const name = suffix[1]!.toLowerCase();
        const tags = fields[name];
        if (!tags) { note('unsupported', text); return ''; }
        if (name === 'ab') note('field_widened', `.${name}. → ${tags.join(' OR ')}`);
        const inner = text.slice(0, -suffix[0].length);
        if (name === 'jn' && /^Cochrane Database of systematic reviews$/i.test(inner)) return '"Cochrane Database Syst Rev"[ta]';
        return join(tags.map((tag) => render(inner, tag)), 'OR');
      }
      const range = text.match(/^(or|and)\/(\d+)[-‐–](\d+)$/i);
      if (range) {
        const first = Number(range[2]); const last = Number(range[3]);
        if (first > last) throw new Error(`Line ${n}: reversed range`);
        return join(Array.from({ length: last - first + 1 }, (_, i) => reference(first + i)), range[1]!.toUpperCase());
      }
      if (!field && /^\d+$/.test(text)) return reference(Number(text));
      const prox = splitTop(text, /^\s+adj\d*\s+/i);
      if (prox.length > 1) {
        if (text.includes('*') || !['tiab', 'ti', 'ad'].includes(field ?? '') || prox.length > 2) {
          note('proximity_to_and', text);
          const parts = prox.map((part) => render(part, field));
          if (parts.some((part) => !part)) { note('unsupported', text); return ''; }
          return join(parts, 'AND');
        }
        const distance = Number(text.match(/\badj(\d*)\b/i)![1] || '1') - 1;
        if (distance < 0) throw new Error(`Line ${n}: invalid adjacency distance`);
        const operands = prox.map((part) => splitTop(unwrap(part), /^\s+or\s+/i).flatMap(variants));
        return join(operands[0]!.flatMap((left) => operands[1]!.map((right) => `"${left} ${right}"[${field}:~${distance}]`)), 'OR');
      }
      const mesh = !field && text.match(/^(exp\s+)?(\*)?(.+?)\/([a-z,\s]*)$/i);
      if (mesh) {
        const name = mesh[3]!.replace(/^"|"$/g, '');
        if (mesh[1] && /^Randomized Controlled Trial$/i.test(name)) {
          note('field_widened', `${text} → publication type`);
          return '"Randomized Controlled Trial"[pt]';
        }
        const tag = `${mesh[2] ? 'MAJR' : 'Mesh'}${mesh[1] ? '' : ':noexp'}`;
        const qualifiers = mesh[4]!.trim() ? mesh[4]!.split(/,\s*/).map((abbr) => {
          const full = subheadings[abbr.toLowerCase()];
          if (!full) throw new Error(`Line ${n}: unknown subheading ${abbr}`);
          return '/' + full;
        }) : [''];
        return join(qualifiers.map((qualifier) => `"${name}${qualifier}"[${tag}]`), 'OR');
      }
      if (!field) { note('unsupported', text); return ''; }
      if (field === 'mp') {
        const meshAllowed = !text.includes('*') && headings.has(text.replace(/^"|"$/g, '').toLowerCase());
        if (!meshAllowed) note('mesh_dropped', `${text}: truncated or not in MeSH allowlist`);
        return join([render(text, 'tiab'), ...(meshAllowed ? [render(text, 'Mesh')] : [])], 'OR');
      }
      return join(variants(text).map((value) => `${/\s/.test(value) || text.startsWith('"') ? `"${value}"` : value}[${field}]`), 'OR');
    };
    const manualOverride = options.overrides?.[String(n)];
    const query = manualOverride ? manualOverride.query : render(body);
    if (previous.has(n)) throw new Error(`Duplicate line ${n}`);
    if (approximations.some((a) => a.kind === 'unsupported')) unresolved.add(n);
    previous.set(n, query);
    return { n, source: body, query, approximations, ...(manualOverride ? { manualOverride } : {}) };
  });
}
