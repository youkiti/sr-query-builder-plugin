/**
 * 概念ブロックの検索式で、括弧の無い AND/NOT と OR が同じ括弧グループ（括弧で囲まれていない
 * 同じ並び）に混在していないかを判定する純粋関数（issue #202）。PubMed は結合演算子を左から
 * 評価するため、`a OR b AND c` は `(a OR b) AND c` にも `a OR (b AND c)` にもならず、意図と
 * 違う集合になる。
 *
 * 判定は「括弧の深さ」ではなく「括弧グループ」単位で行う（issue #202 の codex レビュー指摘）。
 * 深さだけで見ると、同じ深さにある別々の括弧グループ（例: `(a OR b) AND (c AND d)` の 2 つの
 * 括弧はどちらも深さ 1）の演算子を取り違えて混在と誤判定する。
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

interface PrecedenceGroup { hasOr: boolean; hasAndLike: boolean }

/**
 * 括弧の無い AND/NOT と OR が同じ括弧グループに混在しているかを判定する。
 * 括弧グループとは「同じ `(` `)` の対、または最外側（括弧で囲まれていない並び）に属する演算子
 * の集まり」を指す。`(` でグループをスタックに積み、`)` で取り出すことで、兄弟関係にある
 * 別々のグループ（同じ深さでも異なる括弧）を混同しない。
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
  const groups: PrecedenceGroup[] = [];
  const stack: PrecedenceGroup[] = [];
  const openGroup = (): void => {
    const group: PrecedenceGroup = { hasOr: false, hasAndLike: false };
    groups.push(group);
    stack.push(group);
  };
  openGroup(); // 最外側（括弧で囲まれていない並び）も 1 グループとして扱う
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'lparen') { openGroup(); continue; }
    if (token.kind === 'rparen') {
      stack.pop();
      // 閉じ括弧が多い式は判定できない。初期式の診断は構文検査を経ずに呼ばれるため、例外にしない。
      if (stack.length === 0) return false;
      continue;
    }
    if (token.kind !== 'op') continue;
    const current = stack[stack.length - 1]!;
    if (token.op === 'OR') { current.hasOr = true; continue; }
    if (token.op === 'AND') { current.hasAndLike = true; continue; }
    // NOT: 被演算子（ref または `)`）の直後だけ暗黙の AND NOT として数える。
    const previous = tokens[index - 1];
    if (previous && (previous.kind === 'ref' || previous.kind === 'rparen')) current.hasAndLike = true;
  }
  return groups.some((group) => group.hasOr && group.hasAndLike);
}

/** AI の変更案を実測前に却下する理由文（queryOptimizationService.validateOptimizationCandidate）。 */
export const PRECEDENCE_MIXING_REJECT_MESSAGE =
  'AND / NOT と OR を括弧なしで同じ階層に混在させています（PubMed は左から評価するため意図と違う集合になります）。混在する部分を括弧で囲んでください';

/** ブロック構造の診断（blockDiagnosisLines）に載せる注意喚起の note。却下ではなく参考情報。 */
export const PRECEDENCE_MIXING_DIAGNOSIS_NOTE =
  'AND / NOT と OR が括弧なしで同じ階層に混在しています。PubMed は左から評価するため、意図と違う集合になっている可能性があります';
