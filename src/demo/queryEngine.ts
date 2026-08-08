import type { DemoPaper } from './corpus';

/**
 * PubMed 風ブールクエリの評価エンジン（デモ専用の簡易実装）。
 *
 * `esearch` のヒット数・PMID 一覧はすべてこのモジュールが `corpus.ts` を実際に
 * 走査して導出する。ハードコードした件数は一切持たない
 * （video/REQUIREMENTS.md §6-2「esearch のヒット数はコーパスから計算で導出する」）。
 *
 * 実際の PubMed は AND/OR/NOT を（括弧を除き）左から右へ逐次評価する
 * （一般的なブール演算子の優先順位を持たない）。本評価器も同じ規約を採用する。
 *
 * サポートするアトム表記（本デモの生成物はすべてこの範囲に収まる）:
 * - `"quoted phrase"[tag]` / `bareword[tag]` / `12345678[uid]`
 * - tag は大文字小文字を無視し、`:` 以降（NoExp 等）は無視する
 * - tag 省略時・`[tiab]` は title + abstract の部分一致
 * - `[ti]` / `[title]` は title のみの部分一致
 * - `[mesh]` / `[mh]` は MeSH descriptor の完全一致（explode は表現しない。
 *   本コーパスは階層を持たないフラットな descriptor 一覧のため、完全一致で十分）
 * - `[uid]` は PMID の完全一致
 * - `[sh]` / `[pt]` / `[la]` / 日付範囲 等、本コーパスが表現しない tag は常に不一致
 * - 末尾ワイルドカード（`word*`）は前方一致（部分文字列一致で近似する）
 *
 * 複数語からなる非引用符アトム（例: `randomized controlled trial[pt]`）は非対応。
 * 本デモの LLM フィクスチャ / フィルタはすべて引用符付きフレーズのみを生成するため、
 * 実際に評価される式でこの制約に触れることはない。
 */

interface QueryTerm {
  phrase: string;
  tag: string | null;
}

type QueryToken =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'term'; term: QueryTerm };

const RAW_TOKEN_RE = /"[^"]*"|\[[^\]]*\]|\(|\)|[^\s()]+/g;

function tokenize(query: string): QueryToken[] {
  const raw = query.match(RAW_TOKEN_RE) ?? [];
  const tokens: QueryToken[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const chunk = raw[i] as string;
    if (chunk === '(') {
      tokens.push({ kind: 'lparen' });
      continue;
    }
    if (chunk === ')') {
      tokens.push({ kind: 'rparen' });
      continue;
    }
    const upper = chunk.toUpperCase();
    if (upper === 'AND') {
      tokens.push({ kind: 'and' });
      continue;
    }
    if (upper === 'OR') {
      tokens.push({ kind: 'or' });
      continue;
    }
    if (upper === 'NOT') {
      tokens.push({ kind: 'not' });
      continue;
    }
    if (chunk.startsWith('"')) {
      const phrase = chunk.slice(1, chunk.endsWith('"') ? -1 : undefined).replace(/^"/, '');
      const next = raw[i + 1];
      if (next !== undefined && /^\[.*\]$/.test(next)) {
        tokens.push({ kind: 'term', term: { phrase, tag: next.slice(1, -1) } });
        i += 1;
      } else {
        tokens.push({ kind: 'term', term: { phrase, tag: null } });
      }
      continue;
    }
    const embedded = /^(.*?)\[([^\]]*)\]$/.exec(chunk);
    if (embedded) {
      tokens.push({ kind: 'term', term: { phrase: embedded[1] ?? '', tag: embedded[2] ?? null } });
      continue;
    }
    tokens.push({ kind: 'term', term: { phrase: chunk, tag: null } });
  }
  return tokens;
}

function normalizeTag(tag: string | null): string {
  if (tag === null || tag.trim() === '') {
    return 'tiab';
  }
  const head = tag.split(':')[0] ?? tag;
  return head.trim().toLowerCase();
}

function containsPhrase(haystack: string, needleRaw: string): boolean {
  const hs = haystack.toLowerCase();
  const needle = needleRaw.trim();
  if (needle === '') {
    return false;
  }
  if (needle.endsWith('*')) {
    return hs.includes(needle.slice(0, -1).toLowerCase());
  }
  return hs.includes(needle.toLowerCase());
}

/** 本コーパスが構造的に表現しない tag（常に不一致）。 */
const UNSUPPORTED_TAGS = new Set(['sh', 'pt', 'la', 'dp', 'date - publication', 'majr']);

function matchTerm(term: QueryTerm, paper: DemoPaper): boolean {
  const tag = normalizeTag(term.tag);
  const needle = term.phrase.trim();
  if (tag === 'uid') {
    return paper.pmid === needle;
  }
  if (tag === 'mesh' || tag === 'mh') {
    return paper.meshHeadings.some((h) => h.toLowerCase() === needle.toLowerCase());
  }
  if (tag === 'ti' || tag === 'title') {
    return containsPhrase(paper.title, needle);
  }
  if (UNSUPPORTED_TAGS.has(tag)) {
    return false;
  }
  // 既定（tiab 相当）: title + abstract の部分一致
  return containsPhrase(`${paper.title} ${paper.abstract}`, needle);
}

/**
 * トークン列を左から右へ逐次評価する（PubMed の実際の評価順）。
 * 括弧の中身は再帰的に同じ規約で評価する。
 */
function evalTokens(tokens: readonly QueryToken[], paper: DemoPaper): { value: boolean; next: number } {
  let pos = 0;

  function evalAtom(): boolean {
    const tok = tokens[pos];
    if (tok === undefined) {
      return false;
    }
    if (tok.kind === 'lparen') {
      pos += 1;
      const inner = evalSequence();
      if (tokens[pos]?.kind === 'rparen') {
        pos += 1;
      }
      return inner;
    }
    if (tok.kind === 'term') {
      pos += 1;
      return matchTerm(tok.term, paper);
    }
    // AND/OR/NOT が期待外の位置に来た場合は読み飛ばして false 扱いにする（防御的）。
    pos += 1;
    return false;
  }

  function evalSequence(): boolean {
    let result = evalAtom();
    for (;;) {
      const op = tokens[pos];
      if (op === undefined || op.kind === 'rparen') {
        break;
      }
      if (op.kind === 'and') {
        pos += 1;
        // `evalAtom()` は必ず呼ぶ（呼ばないとトークン位置が進まない）。
        // `result && evalAtom()` のように JS の短絡評価に頼ると、
        // result が既に false の時点で evalAtom() が呼ばれずトークン列の
        // 読み取り位置がずれ、以降の式全体の parse が崩れる（実際に踏んだ不具合）。
        const rhs = evalAtom();
        result = result && rhs;
      } else if (op.kind === 'or') {
        pos += 1;
        const rhs = evalAtom();
        result = result || rhs;
      } else if (op.kind === 'not') {
        pos += 1;
        const rhs = evalAtom();
        result = result && !rhs;
      } else {
        // 演算子の位置に term が来た（想定外の入力）。無限ループを避けて打ち切る。
        break;
      }
    }
    return result;
  }

  const value = evalSequence();
  return { value, next: pos };
}

/** 1 論文がクエリ文字列にマッチするかを判定する。 */
export function matchesQuery(query: string, paper: DemoPaper): boolean {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return false;
  }
  return evalTokens(tokens, paper).value;
}

/**
 * コーパス全体からクエリにマッチする論文を返す（出現順を保持）。
 * esearch のヒット数・PMID 一覧はすべてこの関数の戻り値から導出する。
 */
export function evaluateQuery(query: string, corpus: readonly DemoPaper[]): DemoPaper[] {
  return corpus.filter((p) => matchesQuery(query, p));
}
