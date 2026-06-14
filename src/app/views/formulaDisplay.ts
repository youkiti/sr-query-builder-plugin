/**
 * 検索式ドラフトの表示用ヘルパー。
 *
 * 生の markdown（`## PubMed/MEDLINE` + コードブロック）をそのまま <pre> で出すと
 * 1 行が長くて横にはみ出し、ブロックの区切りや語の種類（MeSH / フリーワード）が
 * 読み取りづらい。本モジュールは検索式を「ブロック単位 + 語の種類で色分け」して
 * 描画するための分解ロジックを提供する（描画自体は draftView 側）。
 */

/** NCBI MeSH ブラウザの検索 URL。seedsView と同じ宛先（クリックで別タブに開く） */
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
 * MeSH / フリーワードの色分け凡例。draft / edit 双方で同じ見た目を使うための共通ヘルパー。
 */
export function buildLegend(doc: Document): HTMLElement {
  const legend = doc.createElement('div');
  legend.className = 'draft__legend';
  for (const [kind, label] of [
    ['mesh', 'MeSH'],
    ['freeword', 'フリーワード'],
  ] as const) {
    const item = doc.createElement('span');
    item.className = `draft__legend-item draft__term--${kind}`;
    item.textContent = label;
    legend.appendChild(item);
  }
  return legend;
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
 * tokenizeExpression の結果を parent へ DOM 描画する共通ヘルパー。
 * - MeSH セグメントは NCBI MeSH ブラウザへのリンク（別タブ）にする
 * - フリーワードは色分け span、演算子・括弧は地のテキスト
 *
 * 連結したテキスト内容は expr と一致するため、textContent ベースのテストやコピーは壊れない。
 */
export function renderExpressionInto(parent: HTMLElement, expr: string): void {
  const doc = parent.ownerDocument;
  for (const segment of tokenizeExpression(expr)) {
    if (segment.kind === 'plain') {
      parent.appendChild(doc.createTextNode(segment.text));
    } else if (segment.kind === 'mesh') {
      const a = doc.createElement('a');
      a.className = 'draft__term draft__term--mesh';
      a.href = `${MESH_BROWSER_BASE}${encodeURIComponent(extractMeshTerm(segment.text))}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = 'MeSH ブラウザで開く';
      a.textContent = segment.text;
      parent.appendChild(a);
    } else {
      const span = doc.createElement('span');
      span.className = `draft__term draft__term--${segment.kind}`;
      span.textContent = segment.text;
      parent.appendChild(span);
    }
  }
}

/** slice 内で最後に現れる演算子・括弧の直後（＝語の開始位置）を返す */
function findTermStart(slice: string): number {
  let start = 0;
  let match: RegExpExecArray | null;
  BOUNDARY_PATTERN.lastIndex = 0;
  while ((match = BOUNDARY_PATTERN.exec(slice)) !== null) {
    start = match.index + match[0].length;
  }
  return start;
}
