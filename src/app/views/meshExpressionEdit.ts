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

import {
  extractMeshTerm,
  normalizeOperand,
  tokenizeExpression,
  tokenizeOperands,
  type DiffToken,
} from './formulaDisplay';

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
 * ブロック式の MeSH 句 origin を newLabel の MeSH 句（explode）へ「その場で」差し替える。
 * MeSH ブラウザの「置換」（上位＝広げる / 下位＝絞る）に使う。
 *
 * - newLabel が空、または origin == newLabel なら原文のまま。
 * - newLabel が式中に既にあれば、二重化を避けて origin を取り除くだけにする。
 * - origin が式に無ければ（保険）OR で追加する。
 */
export function replaceMeshDescriptor(
  expression: string,
  origin: string,
  newLabel: string
): string {
  const next = newLabel.trim();
  if (next === '') {
    return expression;
  }
  const originKey = descriptorKey(origin);
  if (originKey === descriptorKey(next)) {
    return expression;
  }
  if (!hasMeshDescriptor(expression, origin)) {
    return addMeshDescriptor(expression, next);
  }
  // 差し替え先が既にあるなら、置換は origin の除去に帰着する（重複させない）。
  if (hasMeshDescriptor(expression, next)) {
    return removeMeshDescriptor(expression, origin);
  }
  const tokens = tokenizeOperands(expression);
  for (const token of tokens) {
    if (!token.isOperand) {
      continue;
    }
    const d = operandMeshDescriptor(token.text);
    if (d !== null && descriptorKey(d) === originKey) {
      token.text = `"${next}"[Mesh]`;
      break;
    }
  }
  return joinTokens(tokens);
}

/**
 * ブロック式（最上位 OR/AND リスト）の重複句を取り除く。前方優先で初出を残し、
 * 2 回目以降の同一句を隣接演算子ごと落とす。MeSH ブラウザ追加・AI 生成・手入力の
 * 経路によらず「同じ語を OR で二重に持つ」状態を正規化する。
 *
 * 同一判定:
 * - MeSH 句は descriptor で判定（explode/noexp・引用符・タグ表記の差を吸収）
 * - それ以外（フリーワード等）は正規化テキスト（大小・連続空白を無視）で判定。
 *   タグ違い（`x[tiab]` と `x[tw]`）は別物として残す。
 *
 * 重複が無ければ原文のまま返す（無駄な再整形をしない）。
 */
export function dedupeOperands(expression: string): string {
  const tokens = tokenizeOperands(expression);
  const seen = new Set<string>();
  const removeIdx = new Set<number>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.isOperand) {
      continue;
    }
    const descriptor = operandMeshDescriptor(token.text);
    const key =
      descriptor !== null
        ? `mesh:${descriptorKey(descriptor)}`
        : `op:${normalizeOperand(token.text)}`;
    if (seen.has(key)) {
      removeIdx.add(i);
    } else {
      seen.add(key);
    }
  }
  if (removeIdx.size === 0) {
    return expression;
  }
  // 後ろから削除してインデックスのずれを避ける（removeMeshDescriptor と同じ glue 始末）。
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (!removeIdx.has(i)) {
      continue;
    }
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
  if (/^\(\s*\)$/.test(result)) {
    return '';
  }
  return result;
}

/**
 * ブロック式の OR リストを「MeSH 句を先・フリーワード等を後」に並べ替える。
 * 各グループ内の元の順序は保つ（安定ソート）。
 *
 * 安全策: 最上位に AND / NOT を含む式は並べ替えると意味が変わるので触らず原文のまま返す
 * （例 `a[tiab] NOT "b"[Mesh]`）。純粋な OR リストのときだけ並べ替える。外側括弧は保つ。
 */
export function sortOperandsMeshFirst(expression: string): string {
  const tokens = tokenizeOperands(expression);
  // 最上位に AND/NOT があれば順序が意味を持つので触らない。
  if (tokens.some((t) => !t.isOperand && /\b(AND|NOT)\b/i.test(t.text))) {
    return expression;
  }
  const operands = tokens.filter((t) => t.isOperand);
  if (operands.length < 2) {
    return expression;
  }
  const rank = (t: DiffToken): number => (operandMeshDescriptor(t.text) !== null ? 0 : 1);
  // Array.prototype.sort は安定なので各グループ内の元順は保たれる。
  const sorted = [...operands].sort((a, b) => rank(a) - rank(b));
  // 既に同順なら原文のまま（無駄な再整形をしない）。
  if (sorted.every((t, i) => t === operands[i])) {
    return expression;
  }
  const hasOuter = tokens[0]?.text === '(' && tokens[tokens.length - 1]?.text === ')';
  const body = sorted.map((t) => t.text).join(' OR ');
  return hasOuter ? `(${body})` : body;
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
