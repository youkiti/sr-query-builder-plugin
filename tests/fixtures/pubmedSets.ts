/** 件数指定は配列生成時だけに使い、API の件数・捕捉・差集合は常に PMID 集合から導く。 */
export function papers(size: number, included: readonly string[] = []): string[] {
  if (!Number.isSafeInteger(size) || size < new Set(included).size) throw new Error('PMID 集合のサイズが不正');
  const result = new Set(included);
  for (let i = 0; result.size < size; i += 1) result.add(String(100000 + i));
  return [...result];
}

export function measureSet(pmids: readonly string[], seeds: readonly string[]) {
  const set = new Set(pmids);
  return { totalHits: set.size, capturedPmids: seeds.filter((id) => set.has(id)),
    missedPmids: seeds.filter((id) => !set.has(id)) };
}

export function setImpact(before: readonly string[], after: readonly string[]) {
  const left = new Set(before);
  const right = new Set(after);
  return { lostHits: [...left].filter((id) => !right.has(id)).length,
    gainedHits: [...right].filter((id) => !left.has(id)).length, inspected: [], error: null };
}

/** 旧形式の期待値を残す場合も、集合からの実測と一致しなければ fixture 作成時に失敗させる。 */
export function assertSetTransition(before: readonly string[], after: readonly string[],
  expected: { beforeHits: number; afterHits: number; lostHits: number; gainedHits: number }) {
  const actual = { beforeHits: new Set(before).size, afterHits: new Set(after).size, ...setImpact(before, after) };
  for (const key of ['beforeHits', 'afterHits', 'lostHits', 'gainedHits'] as const) {
    if (actual[key] !== expected[key]) throw new Error(`集合と不整合: ${key} は ${actual[key]}、指定値は ${expected[key]}`);
  }
}

function splitOuter(query: string): { left: string; operator: string; right: string } | undefined {
  let depth = 0;
  let quoted = false;
  for (let i = query.length - 1; i >= 0; i -= 1) {
    if (query[i] === '"') quoted = !quoted;
    if (quoted) continue;
    if (query[i] === ')') depth += 1;
    if (query[i] === '(') depth -= 1;
    if (depth !== 0) continue;
    for (const operator of [' NOT ', ' AND ', ' OR ']) {
      if (query.startsWith(operator, i)) return { left: query.slice(0, i), operator: operator.trim(), right: query.slice(i + operator.length) };
    }
  }
  return undefined;
}

/** 明示したクエリと集合の対応、およびテストで使う括弧・AND/OR/NOT・uid だけを扱う。 */
export function createSetSearch(resolve: (query: string) => readonly string[] | undefined) {
  const cache = new Map<string, readonly string[]>();
  const lookup = (raw: string): readonly string[] => {
    const query = raw.trim();
    const cached = cache.get(query);
    if (cached) return cached;
    const outer = splitOuter(query);
    if (!outer && query.startsWith('(') && query.endsWith(')')) return lookup(query.slice(1, -1));
    let pmids: readonly string[];
    // 候補の差集合と外側の確認を先に扱う。retmax で差の向きを切り替えない。
    if (outer?.operator === 'NOT' || (outer?.operator === 'AND' && outer.right.includes('[uid]'))) {
      const right = new Set(lookup(outer.right));
      pmids = lookup(outer.left).filter((id) => outer.operator === 'NOT' ? !right.has(id) : right.has(id));
    } else {
      const explicit = resolve(query);
      if (explicit !== undefined) pmids = explicit;
      else if (outer) {
        const left = lookup(outer.left);
        const right = new Set(lookup(outer.right));
        pmids = outer.operator === 'OR' ? [...left, ...right] : left.filter((id) => right.has(id));
      } else if (/^\d+\[uid\]$/.test(query)) pmids = [query.slice(0, -5)];
      else throw new Error(`集合未定義のクエリ: ${query}`);
    }
    const snapshot = Object.freeze([...new Set(pmids)]);
    cache.set(query, snapshot);
    return snapshot;
  };
  const search = (query: string, retmax = 20) => {
    const pmids = lookup(query);
    return { count: String(pmids.length), idlist: pmids.slice(0, retmax) };
  };
  return { lookup, search };
}
