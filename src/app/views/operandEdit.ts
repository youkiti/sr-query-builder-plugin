/**
 * ブロック式（concept block の OR リスト）を「operand 単位・インデックス基準」で
 * 書き換える純粋関数群。
 *
 * descriptor 指定の MeSH 専用操作（add/replace/remove）は [meshExpressionEdit.ts](./meshExpressionEdit.ts)
 * にある。こちらは編集画面のインタラクティブ表示（チップ）からの「クリックしたまさにその句」を
 * 一意に指して削除・置換するための、語種非依存・インデックス基準の操作を担う。
 *
 * テキストキーではなくインデックスで識別するのは、同じ綴りのフリーワードが複数あると
 * テキスト一致では曖昧になり、描画されたチップと 1:1 で対応できないため。
 * 式は [tokenizeOperands](./formulaDisplay.ts) で operand（句）と glue（演算子・括弧）に分解し、
 * トークン列を編集して文字列へ戻すことで、`(A OR B)` の外側括弧や演算子を壊さずに足し引きできる。
 */

import {
  extractMeshTerm,
  normalizeOperand,
  tokenizeExpression,
  tokenizeOperands,
  type DiffToken,
} from './formulaDisplay';

export type OperandKind = 'mesh' | 'freeword' | 'other';

/** 描画・編集に必要な 1 operand の情報。 */
export interface OperandInfo {
  /** tokenizeOperands の全トークン列における位置（削除・置換のキー） */
  index: number;
  /** operand だけを数えた 0 始まりの並び順（UI ラベル用） */
  order: number;
  /** operand 全文（例 `"Heart Failure"[Mesh]` / `asthma*[tiab]` / `(a OR b)`） */
  text: string;
  kind: OperandKind;
  /** タグを除いた編集対象の語（mesh=descriptor / freeword=タグ前テキスト）。other は全文 */
  term: string;
  /** 単一トークン operand のフィールドタグ（`[...]` の中身）。複合句・タグ無しは null */
  tag: string | null;
}

/** トークン列を文字列へ戻す。 */
function joinTokens(tokens: DiffToken[]): string {
  return tokens.map((t) => t.text).join('').trim();
}

/**
 * 1 つの operand 文字列を語種・編集対象語・タグへ分解する。
 * 単一の MeSH/フリーワード句のときだけ kind を確定し、複合句（`(a OR b)` 等）は 'other'。
 */
function analyzeOperand(text: string): { kind: OperandKind; term: string; tag: string | null } {
  const segments = tokenizeExpression(text.trim()).filter((s) => s.text.trim() !== '');
  if (segments.length === 1) {
    const seg = segments[0]!;
    const tag = seg.text.match(/\[([^\]]+)\]\s*$/)?.[1] ?? null;
    if (seg.kind === 'mesh') {
      const descriptor = extractMeshTerm(seg.text);
      return { kind: 'mesh', term: descriptor, tag };
    }
    if (seg.kind === 'freeword') {
      const term = seg.text.replace(/\[[^\]]*\]\s*$/, '').trim();
      return { kind: 'freeword', term, tag };
    }
  }
  return { kind: 'other', term: text.trim(), tag: null };
}

/** 式を operand 単位に分解し、各句の語種・編集対象語・タグ・位置を返す。 */
export function listOperands(expression: string): OperandInfo[] {
  const tokens = tokenizeOperands(expression);
  const out: OperandInfo[] = [];
  let order = 0;
  tokens.forEach((token, index) => {
    if (!token.isOperand) {
      return;
    }
    const a = analyzeOperand(token.text);
    out.push({ index, order, text: token.text, kind: a.kind, term: a.term, tag: a.tag });
    order += 1;
  });
  return out;
}

/**
 * テキスト（タグ込み、例 `surgeon*[tiab]`）に一致する operand の情報を返す（無ければ null）。
 * 大小・連続空白を無視して照合する。Δ 表のように operand 順とは別の並びから
 * 「この語」を式上の operand へ引き当てるのに使う。
 */
export function findOperandByText(expression: string, query: string): OperandInfo | null {
  const target = normalizeOperand(query);
  return listOperands(expression).find((info) => normalizeOperand(info.text) === target) ?? null;
}

/**
 * index 位置の operand を、隣接する演算子 glue 1 つごと取り除く。
 * `A OR  OR B` のような壊れを防ぐ（meshExpressionEdit と同じ glue 始末）。
 */
function dropOperandWithGlue(tokens: DiffToken[], index: number): void {
  const prev = tokens[index - 1];
  const nextGlue = tokens[index + 1];
  if (prev && !prev.isOperand && /\b(OR|AND|NOT)\b/i.test(prev.text)) {
    tokens.splice(index - 1, 2);
  } else if (nextGlue && !nextGlue.isOperand && /\b(OR|AND|NOT)\b/i.test(nextGlue.text)) {
    tokens.splice(index, 2);
  } else {
    tokens.splice(index, 1);
  }
}

/**
 * index 位置の operand をブロック式から取り除く。該当が operand でなければ原文のまま。
 * 中身が空の外側括弧（`()`）だけ残ったら空文字にする。
 */
export function removeOperandAt(expression: string, index: number): string {
  const tokens = tokenizeOperands(expression);
  const token = tokens[index];
  if (!token || !token.isOperand) {
    return expression;
  }
  dropOperandWithGlue(tokens, index);
  const result = joinTokens(tokens);
  if (/^\(\s*\)$/.test(result)) {
    return '';
  }
  return result;
}

/**
 * index 位置の operand の「語」だけを newTerm へ差し替える（フィールドタグは保持）。
 * - newTerm が空なら削除に倒す。
 * - タグの無い複合句（other）は全文置換扱い。
 * - 該当が operand でなければ原文のまま。
 */
export function setOperandTerm(expression: string, index: number, newTerm: string): string {
  const term = newTerm.trim();
  const tokens = tokenizeOperands(expression);
  const token = tokens[index];
  if (!token || !token.isOperand) {
    return expression;
  }
  if (term === '') {
    return removeOperandAt(expression, index);
  }
  const { tag } = analyzeOperand(token.text);
  token.text = tag === null ? term : `${term}[${tag}]`;
  return joinTokens(tokens);
}

/**
 * フリーワード句を式の末尾に OR で追加する（既定タグ `tiab`）。
 * 空語は無視。空式なら単独の句にする（addMeshDescriptor と同じ末尾追加ロジック）。
 */
export function appendFreeword(expression: string, term: string, tag = 'tiab'): string {
  const t = term.trim();
  if (t === '') {
    return expression;
  }
  const newOperand: DiffToken = { text: `${t}[${tag}]`, isOperand: true };
  const tokens = tokenizeOperands(expression);
  const operandIdx = tokens.map((x) => x.isOperand).lastIndexOf(true);
  if (operandIdx < 0) {
    return newOperand.text;
  }
  const next = [...tokens];
  next.splice(operandIdx + 1, 0, { text: ' OR ', isOperand: false }, newOperand);
  return joinTokens(next);
}
