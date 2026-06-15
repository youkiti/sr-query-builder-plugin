/**
 * MeSH ブラウザからの「追加 / 削除」でブロック式（concept block の OR リスト）を
 * 書き換えるための純粋関数。描画は blockInspector、適用は editView 経由で行う。
 *
 * 方針:
 * - 式は [tokenizeOperands](./formulaDisplay.ts) で operand（句）と glue（演算子・括弧）の
 *   トークン列に分解し、トークン列を編集して文字列へ戻す。これで `(A OR B)` の外側括弧や
 *   演算子（OR/AND/NOT）を壊さずに 1 句だけ足し引きできる。
 * - 追加する MeSH は explode（`"<label>"[Mesh]`）固定（PubMed 既定）。
 * - 同じ descriptor が既にあれば追加は無視（重複させない）。
 */

import { extractMeshTerm, tokenizeExpression, tokenizeOperands, type DiffToken } from './formulaDisplay';

/** operand が「単一の MeSH 句」なら、その descriptor を返す（そうでなければ null）。 */
export function operandMeshDescriptor(operandText: string): string | null {
  const nonEmpty = tokenizeExpression(operandText.trim()).filter((s) => s.text.trim() !== '');
  if (nonEmpty.length === 1 && nonEmpty[0]!.kind === 'mesh') {
    const descriptor = extractMeshTerm(nonEmpty[0]!.text);
    return descriptor === '' ? null : descriptor;
  }
  return null;
}

/** descriptor 比較キー（前後空白・大小無視）。 */
function descriptorKey(descriptor: string): string {
  return descriptor.trim().toLowerCase();
}

/** この式に descriptor の MeSH 句が既に含まれているか。 */
export function hasMeshDescriptor(expression: string, descriptor: string): boolean {
  const target = descriptorKey(descriptor);
  return tokenizeOperands(expression).some(
    (t) => t.isOperand && operandMeshDescriptor(t.text) !== null &&
      descriptorKey(operandMeshDescriptor(t.text)!) === target
  );
}

/** トークン列を文字列へ戻す。 */
function joinTokens(tokens: DiffToken[]): string {
  return tokens.map((t) => t.text).join('').trim();
}

/**
 * descriptor の MeSH 句（explode）をブロック式に追加する。
 * 既に含まれていれば原文のまま返す。空式なら単独の句にする。
 */
export function addMeshDescriptor(expression: string, label: string): string {
  const descriptor = label.trim();
  if (descriptor === '') {
    return expression;
  }
  if (hasMeshDescriptor(expression, descriptor)) {
    return expression;
  }
  const newOperand: DiffToken = { text: `"${descriptor}"[Mesh]`, isOperand: true };
  const tokens = tokenizeOperands(expression);
  const operandIdx = tokens.map((t) => t.isOperand).lastIndexOf(true);
  if (operandIdx < 0) {
    // operand が無い（空式）。単独の句にする。
    return newOperand.text;
  }
  // 最後の operand の直後に ` OR <新句>` を差し込む（末尾の `)` などは後ろに残る）。
  const next = [...tokens];
  next.splice(operandIdx + 1, 0, { text: ' OR ', isOperand: false }, newOperand);
  return joinTokens(next);
}

/**
 * descriptor の MeSH 句をブロック式から取り除く。隣接する演算子 glue も 1 つ落として
 * `A OR  OR B` のような壊れを防ぐ。該当が無ければ原文のまま返す。
 */
export function removeMeshDescriptor(expression: string, descriptor: string): string {
  const target = descriptorKey(descriptor);
  const tokens = tokenizeOperands(expression);
  // 後ろから処理してインデックスのずれを避ける。
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    if (!token.isOperand) {
      continue;
    }
    const d = operandMeshDescriptor(token.text);
    if (d === null || descriptorKey(d) !== target) {
      continue;
    }
    // 隣接 glue を 1 つ落とす。直前が演算子 glue ならそれを、無ければ直後の glue を落とす。
    const prev = tokens[i - 1];
    const nextGlue = tokens[i + 1];
    if (prev && !prev.isOperand && /\b(OR|AND|NOT)\b/i.test(prev.text)) {
      tokens.splice(i - 1, 2);
    } else if (nextGlue && !nextGlue.isOperand && /\b(OR|AND|NOT)\b/i.test(nextGlue.text)) {
      tokens.splice(i, 2);
    } else {
      tokens.splice(i, 1);
    }
  }
  const result = joinTokens(tokens);
  // 中身が空の外側括弧（`()`）だけ残ったら空文字にする。
  if (/^\(\s*\)$/.test(result)) {
    return '';
  }
  return result;
}
