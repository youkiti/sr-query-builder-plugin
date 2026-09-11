/** 検索式の DOM 描画と、既存呼び出し元向けの純粋関数の再公開。 */
import {
  MESH_BROWSER_BASE, extractMeshTerm, tokenizeExpression, type DiffToken,
} from '@/lib/search-formula-md/expression';
export * from '@/lib/search-formula-md/expression';

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


/**
 * diffExpressions のトークン列を parent へ描画する。operand は status 別の要素
 * （removed=<del> / added=<ins> / same=<span>）で包み、中身は renderExpressionInto で
 * MeSH リンク・色分けを保つ。glue（演算子・括弧）は地のテキスト。
 */
export function renderDiffSideInto(parent: HTMLElement, tokens: DiffToken[]): void {
  const doc = parent.ownerDocument;
  for (const token of tokens) {
    if (!token.isOperand) {
      parent.appendChild(doc.createTextNode(token.text));
      continue;
    }
    const status = token.status ?? 'same';
    const el =
      status === 'removed'
        ? doc.createElement('del')
        : status === 'added'
          ? doc.createElement('ins')
          : doc.createElement('span');
    el.className = `formula-diff__term formula-diff__term--${status}`;
    renderExpressionInto(el, token.text);
    parent.appendChild(el);
  }
}
