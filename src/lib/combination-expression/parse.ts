/**
 * combination_expression（例: `#1 AND #2`、`(#1 AND #2) OR #3`）の
 * トークナイザと構文 / 参照バリデータ。
 *
 * docs/ui-block-approval.md §3.5 で定義された構文:
 * - 許可トークン: `#<id>`（id は英数字 1+）, `AND` / `OR` / `NOT`,
 *   `(`, `)`
 * - 大文字小文字は区別しない（演算子のみ）
 */

export type CombinationToken =
  | { kind: 'ref'; id: string; raw: string; position: number }
  | { kind: 'op'; op: 'AND' | 'OR' | 'NOT'; raw: string; position: number }
  | { kind: 'lparen'; raw: '('; position: number }
  | { kind: 'rparen'; raw: ')'; position: number };

export interface ParseError {
  message: string;
  position: number;
}

export interface CombinationParseResult {
  tokens: CombinationToken[];
  errors: ParseError[];
}

const TOKEN_PATTERN = /\s+|#([A-Za-z0-9]+)|\(|\)|[A-Za-z]+/g;

export function tokenizeCombination(input: string): CombinationParseResult {
  const tokens: CombinationToken[] = [];
  const errors: ParseError[] = [];
  let cursor = 0;
  TOKEN_PATTERN.lastIndex = 0;
  while (cursor < input.length) {
    TOKEN_PATTERN.lastIndex = cursor;
    const match = TOKEN_PATTERN.exec(input);
    if (!match || match.index !== cursor) {
      errors.push({
        message: `不正な文字: "${input[cursor]}"`,
        position: cursor,
      });
      cursor += 1;
      continue;
    }
    const raw = match[0];
    if (raw.trim() === '') {
      cursor += raw.length;
      continue;
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: 'ref', id: match[1], raw, position: cursor });
    } else if (raw === '(') {
      tokens.push({ kind: 'lparen', raw: '(', position: cursor });
    } else if (raw === ')') {
      tokens.push({ kind: 'rparen', raw: ')', position: cursor });
    } else {
      const upper = raw.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        tokens.push({ kind: 'op', op: upper, raw, position: cursor });
      } else {
        errors.push({
          message: `予期しないキーワード: "${raw}"（許可: AND / OR / NOT）`,
          position: cursor,
        });
      }
    }
    cursor += raw.length;
  }
  return { tokens, errors };
}

/**
 * 括弧の対応関係を検証し、エラーを追加する。
 */
export function validateParens(tokens: readonly CombinationToken[]): ParseError[] {
  const errors: ParseError[] = [];
  const stack: CombinationToken[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'lparen') {
      stack.push(tok);
    } else if (tok.kind === 'rparen') {
      const opener = stack.pop();
      if (opener === undefined) {
        errors.push({ message: '対応する `(` が無い `)`', position: tok.position });
      }
    }
  }
  for (const opener of stack) {
    errors.push({ message: '閉じ括弧 `)` が不足している `(`', position: opener.position });
  }
  return errors;
}

/**
 * 既知の id 集合に対して、未定義参照を検出する。
 */
export function validateReferences(
  tokens: readonly CombinationToken[],
  knownIds: ReadonlySet<string>
): ParseError[] {
  const errors: ParseError[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'ref' && !knownIds.has(tok.id)) {
      errors.push({ message: `未定義のブロック ID: #${tok.id}`, position: tok.position });
    }
  }
  return errors;
}

/**
 * 演算子と被演算子の並びがおかしい（例: `AND AND`、先頭・末尾の演算子）箇所を検出する。
 * 二項演算子は左右に被演算子（ref / `(...)` / `NOT ref` など）が必要。
 */
export function validateGrammar(tokens: readonly CombinationToken[]): ParseError[] {
  const errors: ParseError[] = [];
  if (tokens.length === 0) {
    return errors;
  }
  let prev: CombinationToken | null = null;
  for (const tok of tokens) {
    if (prev === null) {
      if (tok.kind === 'op' && tok.op !== 'NOT') {
        errors.push({
          message: `先頭に二項演算子 ${tok.op} は置けません`,
          position: tok.position,
        });
      }
    } else if (endsOperand(prev) && startsOperand(tok)) {
      errors.push({
        message: `被演算子が連続しています（演算子 AND/OR が必要）`,
        position: tok.position,
      });
    } else if (prev.kind === 'op' && prev.op !== 'NOT' && tok.kind === 'op' && tok.op !== 'NOT') {
      errors.push({
        message: `二項演算子が連続しています: ${prev.op} ${tok.op}`,
        position: tok.position,
      });
    }
    prev = tok;
  }
  if (prev !== null && prev.kind === 'op') {
    errors.push({ message: `末尾が演算子 ${prev.op} で終わっています`, position: prev.position });
  }
  return errors;
}

/** 被演算子の終端と扱えるトークン（次に二項演算子が来ても良い） */
function endsOperand(tok: CombinationToken): boolean {
  return tok.kind === 'ref' || tok.kind === 'rparen';
}

/** 新しい被演算子の開始と扱えるトークン */
function startsOperand(tok: CombinationToken): boolean {
  return tok.kind === 'ref' || tok.kind === 'lparen';
}

/**
 * 全検証を一括で行う公開 API。
 */
export function validateCombinationExpression(
  input: string,
  knownIds: ReadonlySet<string>
): CombinationParseResult {
  const tokenized = tokenizeCombination(input);
  const errors: ParseError[] = [
    ...tokenized.errors,
    ...validateParens(tokenized.tokens),
    ...validateGrammar(tokenized.tokens),
    ...validateReferences(tokenized.tokens, knownIds),
  ];
  return { tokens: tokenized.tokens, errors };
}

/**
 * combination_expression を最低限の正規化（連続空白を 1 つに）したもの。
 * UI で表示するときに使う。
 */
export function normalizeCombinationExpression(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
