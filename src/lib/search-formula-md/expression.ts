/** 検索式の語分解・分類・差分を扱う純粋関数。 */

/** NCBI MeSH ブラウザの検索 URL */
export const MESH_BROWSER_BASE = 'https://www.ncbi.nlm.nih.gov/mesh/?term=';

export type TermKind = 'mesh' | 'freeword' | 'plain';

/** 検索式 1 ブロックを表示用に分割した 1 セグメント */
export interface ExprSegment {
  text: string;
  kind: TermKind;
}

/** `[...]` のフィールドタグ抽出（中身を group1 に取る） */
const TAG_PATTERN = /\[([^\]]+)\]/g;
/** 語の境界（ブール演算子・括弧）。直前の語の開始位置を求めるのに使う */
const BOUNDARY_PATTERN = /\bOR\b|\bAND\b|\bNOT\b|[()]/gi;

/** MeSH 系フィールドタグ（`[Mesh]`, `[mh]`, `[Majr]`, `[sh]` など） */
const MESH_TAG_PATTERN = /^(mesh|mesh terms|mh|majr|mesh major topic|sh|subheading|nm)$/;
/** フリーワード系フィールドタグ（`[tiab]`, `[tw]`, `[ti]`, `[ab]` など） */
const FREEWORD_TAG_PATTERN =
  /^(tiab|tw|ti|ab|tt|ot|title|title\/abstract|text word|all fields|all|word)$/;

/**
 * フィールドタグ（`[...]` の中身）を MeSH / フリーワード / その他 に分類する。
 * `:noexp` などのサフィックスは無視する。判定できないタグ（`[pt]`, `[la]` 等の
 * フィルタ系）は 'plain' を返す。
 */
export function classifyFieldTag(tag: string): TermKind {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/:noexp$/, '')
    .trim();
  if (MESH_TAG_PATTERN.test(normalized)) {
    return 'mesh';
  }
  if (FREEWORD_TAG_PATTERN.test(normalized)) {
    return 'freeword';
  }
  return 'plain';
}

/**
 * 検索式ブロックの expression を「語 + フィールドタグ」単位に分割する。
 * `term[tag]` のまとまりごとに種類（mesh/freeword/plain）を付け、演算子や括弧は
 * plain セグメントとして残す。タグの無い結合行（`#1 AND #2`）は全体が plain。
 */
export function tokenizeExpression(expr: string): ExprSegment[] {
  const segments: ExprSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;
  while ((match = TAG_PATTERN.exec(expr)) !== null) {
    const tag = match[1] ?? '';
    const tagStart = match.index;
    const tagEnd = TAG_PATTERN.lastIndex;

    // 直前のタグ末尾〜今回のタグ開始までが「演算子 + 語」。語の開始位置を求める
    const slice = expr.slice(cursor, tagStart);
    const termStart = findTermStart(slice);
    const prefix = slice.slice(0, termStart);
    let term = slice.slice(termStart);
    // 語の前の空白は演算子側（plain）に寄せる
    const leadWs = term.match(/^\s+/)?.[0] ?? '';
    term = term.slice(leadWs.length);

    const before = prefix + leadWs;
    if (before.length > 0) {
      segments.push({ text: before, kind: 'plain' });
    }
    segments.push({ text: `${term}[${tag}]`, kind: classifyFieldTag(tag) });
    cursor = tagEnd;
  }
  if (cursor < expr.length) {
    segments.push({ text: expr.slice(cursor), kind: 'plain' });
  }
  return segments;
}

/**
 * MeSH セグメント（`"Heart Failure"[Mesh]` / `Asthma[mh]` 等）から、MeSH ブラウザ検索に
 * 使う用語だけを取り出す。末尾のフィールドタグ・前後の引用符・末尾ワイルドカードを落とす。
 */
export function extractMeshTerm(segmentText: string): string {
  return segmentText
    .replace(/\[[^\]]*\]\s*$/, '') // 末尾の [tag]
    .trim()
    .replace(/^"+|"+$/g, '') // 前後の引用符
    .replace(/\*+$/, '') // 末尾ワイルドカード
    .trim();
}

/**
 * 検索式の差分表示用トークン。式を「OR/AND/NOT の最上位区切り」で句（operand）に割り、
 * 演算子・括弧は glue として残す。status は diffExpressions が付ける。
 */
export interface DiffToken {
  text: string;
  /** true なら 1 つの被演算子（語/句）。false なら演算子・括弧などの地のテキスト */
  isOperand: boolean;
  /** diffExpressions で付与。同一 / 削除 / 追加 */
  status?: 'same' | 'removed' | 'added';
}

/** before/after の式を句単位で比較した結果 */
export interface ExpressionDiff {
  beforeTokens: DiffToken[];
  afterTokens: DiffToken[];
  /** before にあって after に無い句（削除された語） */
  removed: string[];
  /** after にあって before に無い句（追加された語） */
  added: string[];
}

/** 行頭が最上位のブール演算子か判定（後ろが空白・開き括弧・終端のときだけ演算子とみなす） */
const DIFF_OPERATOR_PATTERN = /^(OR|AND|NOT)(?=\s|\(|$)/i;

/** 式全体が 1 組の括弧で包まれているか（`(A OR B)` の外側括弧を glue に寄せるため） */
function isWrappedByOuterParens(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) {
    return false;
  }
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && ch === '(') {
      depth += 1;
    } else if (!inQuote && ch === ')') {
      depth -= 1;
      // 末尾より手前で depth が 0 に戻る＝外側括弧は全体を包んでいない
      if (depth === 0 && i < s.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * 式を「最上位のブール演算子で区切った句（operand）」と「演算子・括弧（glue）」の列に分解する。
 * 括弧の深さと引用符の内側を尊重し、ネストした群（`(x OR y)`）は 1 つの operand として保つ。
 */
export function tokenizeOperands(expr: string): DiffToken[] {
  const tokens: DiffToken[] = [];
  const trimmed = expr.trim();
  if (trimmed === '') {
    return tokens;
  }
  const hasOuter = isWrappedByOuterParens(trimmed);
  const inner = hasOuter ? trimmed.slice(1, -1) : trimmed;
  if (hasOuter) {
    tokens.push({ text: '(', isOperand: false });
  }
  let depth = 0;
  let inQuote = false;
  let buf = '';
  const flushOperand = (): void => {
    const term = buf.trim();
    if (term !== '') {
      tokens.push({ text: term, isOperand: true });
    }
    buf = '';
  };
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i] ?? '';
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      i += 1;
      continue;
    }
    if (!inQuote && ch === '(') {
      depth += 1;
      buf += ch;
      i += 1;
      continue;
    }
    if (!inQuote && ch === ')') {
      depth -= 1;
      buf += ch;
      i += 1;
      continue;
    }
    if (!inQuote && depth === 0) {
      const prevWs = i === 0 || /\s/.test(inner[i - 1] ?? ' ');
      const match = prevWs ? DIFF_OPERATOR_PATTERN.exec(inner.slice(i)) : null;
      if (match) {
        flushOperand();
        tokens.push({ text: ` ${(match[1] ?? '').toUpperCase()} `, isOperand: false });
        i += match[0].length;
        // 演算子直後の空白は glue 側に含めた扱いにし、operand の先頭からは外す
        while (i < inner.length && /\s/.test(inner[i] ?? '')) {
          i += 1;
        }
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flushOperand();
  if (hasOuter) {
    tokens.push({ text: ')', isOperand: false });
  }
  return tokens;
}

/** 句の同一判定キー（空白の差・大文字小文字を無視） */
export function normalizeOperand(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * before / after の検索式を句単位で比較する。順序非依存の集合差で「削除/追加された語」を求め、
 * 各句に status（same/removed/added）を付けて返す。語順や記法だけの違いは increment 0 になる。
 */
export function diffExpressions(before: string, after: string): ExpressionDiff {
  const beforeTokens = tokenizeOperands(before);
  const afterTokens = tokenizeOperands(after);
  const beforeKeys = new Set(
    beforeTokens.filter((t) => t.isOperand).map((t) => normalizeOperand(t.text))
  );
  const afterKeys = new Set(
    afterTokens.filter((t) => t.isOperand).map((t) => normalizeOperand(t.text))
  );
  const removed: string[] = [];
  const added: string[] = [];
  for (const token of beforeTokens) {
    if (!token.isOperand) {
      continue;
    }
    if (afterKeys.has(normalizeOperand(token.text))) {
      token.status = 'same';
    } else {
      token.status = 'removed';
      removed.push(token.text);
    }
  }
  for (const token of afterTokens) {
    if (!token.isOperand) {
      continue;
    }
    if (beforeKeys.has(normalizeOperand(token.text))) {
      token.status = 'same';
    } else {
      token.status = 'added';
      added.push(token.text);
    }
  }
  return { beforeTokens, afterTokens, removed, added };
}

/** ブロック式から取り出した「単体で件数計測できるキーワード」。 */
export interface KeywordQuery {
  /** 表示用ラベル（MeSH descriptor or フリーワードのテキスト） */
  display: string;
  /** 単体 esearch にかけるクエリ。ブロック・インスペクタと同じ文字列にしてキャッシュを共有する */
  query: string;
  kind: 'mesh' | 'freeword';
}

/**
 * ブロック式を「単体ヒット数を測れるキーワード」へ分解する。MeSH は descriptor を
 * `"X"[Mesh]`（explode）/ `"X"[Mesh:NoExp]`（noexp）に、フリーワードはタグ込みのテキストを
 * そのままクエリにする。MeSH は descriptor、フリーワードは query で重複除去する。
 *
 * クエリ文字列は blockInspector の個別件数計測と一致させてあるので、同じヒット数キャッシュを共有し、
 * 「編集画面に入ったときに計測した実数」をそのまま AI 文脈に流用できる。
 */
export function deriveKeywordQueries(expression: string): KeywordQuery[] {
  const meshByDescriptor = new Map<string, KeywordQuery>();
  const freewordByQuery = new Map<string, KeywordQuery>();
  for (const segment of tokenizeExpression(expression)) {
    if (segment.kind === 'mesh') {
      const descriptor = extractMeshTerm(segment.text);
      if (descriptor === '') {
        continue;
      }
      const tag = segment.text.match(/\[([^\]]+)\]\s*$/)?.[1] ?? '';
      const explode = !/:\s*noexp/i.test(tag);
      const query = explode ? `"${descriptor}"[Mesh]` : `"${descriptor}"[Mesh:NoExp]`;
      const existing = meshByDescriptor.get(descriptor);
      if (!existing) {
        meshByDescriptor.set(descriptor, { display: descriptor, query, kind: 'mesh' });
      } else if (explode && existing.query.endsWith('[Mesh:NoExp]')) {
        // 同じ descriptor が explode/noexp 両方で出たら explode を優先（インスペクタと同じ寄せ方）
        existing.query = query;
      }
    } else if (segment.kind === 'freeword') {
      const query = segment.text.trim();
      if (query !== '' && !freewordByQuery.has(query)) {
        freewordByQuery.set(query, { display: query, query, kind: 'freeword' });
      }
    }
  }
  return [...meshByDescriptor.values(), ...freewordByQuery.values()];
}

/** slice 内で最後に現れる（引用符の外の）演算子・括弧の直後（＝語の開始位置）を返す */
function findTermStart(slice: string): number {
  let start = 0;
  let match: RegExpExecArray | null;
  BOUNDARY_PATTERN.lastIndex = 0;
  while ((match = BOUNDARY_PATTERN.exec(slice)) !== null) {
    // 引用符の内側にある AND/OR/NOT（例: `"Oral and Maxillofacial Surgeons"`）は
    // ブール演算子ではなく語の一部なので、境界として扱わない。
    if (isInsideQuotes(slice, match.index)) {
      continue;
    }
    start = match.index + match[0].length;
  }
  return start;
}

/** s の index 位置が引用符（"）の内側か（先頭から数えた " の数が奇数なら内側）。 */
function isInsideQuotes(s: string, index: number): boolean {
  let quotes = 0;
  for (let i = 0; i < index; i += 1) {
    if (s[i] === '"') {
      quotes += 1;
    }
  }
  return quotes % 2 === 1;
}
