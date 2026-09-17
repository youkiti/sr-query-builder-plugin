/**
 * 概念ブロックの検索式で、括弧の無い AND/NOT と OR が同じ括弧の深さに混在していないかを
 * 判定する純粋関数（issue #202）。PubMed は結合演算子を左から評価するため、
 * `a OR b AND c` は `(a OR b) AND c` にも `a OR (b AND c)` にもならず、意図と違う集合になる。
 *
 * 自動調整の変更案検査（queryOptimizationService.validateOptimizationCandidate）と、
 * AI 呼び出し前のブロック構造診断（blockDiagnosis.diagnosePrecedenceMixing）の両方から使う。
 */
import { tokenizeCombination } from '@/lib/combination-expression/parse';
import { tokenizeExpression } from '@/lib/search-formula-md/expression';

// PMID などの文献識別子で検索集合を直接指定させないための対象タグ。変更案検査（タグ付き語の
// 許可範囲チェック）と、ここでの語置換の両方で同じ判定基準を共有する。
export const IDENTIFIER_FIELD_TAGS = new Set([
  'uid', 'pmid', 'pmcid', 'pmc', 'doi',
  'aid', 'article identifier', 'lid', 'location id', 'si', 'secondary source id',
]);

export function hasIdentifierFieldTag(text: string): boolean {
  const tag = /\[([^\]]+)\]$/.exec(text)?.[1];
  return tag !== undefined && IDENTIFIER_FIELD_TAGS.has(tag.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * 概念ブロックの式を、タグ付き語（tokenizeExpression のセグメントのうち末尾に
 * フィールドタグ `[...]` を持つもの）を仮参照 `#termN` に置き換えた結合構文へ変換する。
 * 識別子系のタグ付き語はそのまま残す（呼び出し側のタグ検査に使うため、置換しない）。
 * 演算子・括弧・タグなし自由文はそのまま残るので、`tokenizeCombination` でブール構造だけを
 * 検査できる。
 */
export function expressionToOperatorSyntax(expression: string): { syntax: string; operandIds: Set<string> } {
  const operandIds = new Set<string>();
  const syntax = tokenizeExpression(expression).map((segment) => {
    if (hasIdentifierFieldTag(segment.text)) return segment.text;
    if (segment.kind === 'plain' && !/\[[^\]]+\]$/.test(segment.text)) return segment.text;
    const id = `term${operandIds.size}`;
    operandIds.add(id);
    return `#${id}`;
  }).join('');
  return { syntax, operandIds };
}

/**
 * 括弧の無い AND/NOT と OR が同じ深さに混在しているかを判定する。
 * 判定は正規化前のトークン列（`normalizeConceptNotForValidation` を通す前の syntax）で行う:
 * `a OR b NOT c` は「被演算子直後の NOT」を暗黙の AND NOT とみなし、OR との混在として検出する。
 * 先頭・`(` の直後・AND/OR の直後に現れる NOT は単項の否定とみなし、混在判定には数えない。
 * 構文が壊れている（tokenizeCombination がエラーを返す）場合は判定できないため false を返す
 * （呼び出し側が既存の構文検査を通したあとにだけ呼ぶ設計）。
 */
export function hasPrecedenceMixing(expression: string): boolean {
  const { syntax } = expressionToOperatorSyntax(expression);
  const { tokens, errors } = tokenizeCombination(syntax);
  if (errors.length > 0) return false;
  let depth = 0;
  const hasOrAtDepth = new Map<number, boolean>();
  const hasAndLikeAtDepth = new Map<number, boolean>();
  tokens.forEach((token, index) => {
    if (token.kind === 'lparen') { depth += 1; return; }
    if (token.kind === 'rparen') { depth -= 1; return; }
    if (token.kind !== 'op') return;
    if (token.op === 'OR') { hasOrAtDepth.set(depth, true); return; }
    if (token.op === 'AND') { hasAndLikeAtDepth.set(depth, true); return; }
    // NOT: 被演算子（ref または `)`）の直後だけ暗黙の AND NOT として数える。
    const previous = tokens[index - 1];
    if (previous && (previous.kind === 'ref' || previous.kind === 'rparen')) hasAndLikeAtDepth.set(depth, true);
  });
  for (const [d, hasOr] of hasOrAtDepth) {
    if (hasOr && hasAndLikeAtDepth.get(d)) return true;
  }
  return false;
}

/** AI の変更案を実測前に却下する理由文（queryOptimizationService.validateOptimizationCandidate）。 */
export const PRECEDENCE_MIXING_REJECT_MESSAGE =
  'AND / NOT と OR を括弧なしで同じ階層に混在させています（PubMed は左から評価するため意図と違う集合になります）。混在する部分を括弧で囲んでください';

/** ブロック構造の診断（blockDiagnosisLines）に載せる注意喚起の note。却下ではなく参考情報。 */
export const PRECEDENCE_MIXING_DIAGNOSIS_NOTE =
  'AND / NOT と OR が括弧なしで同じ階層に混在しています。PubMed は左から評価するため、意図と違う集合になっている可能性があります';
