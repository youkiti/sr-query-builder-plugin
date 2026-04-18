import { BLOCK_ID_PATTERN, type FormulaBlock, type PubmedFormula } from './types';

export class FormulaSerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaSerializeError';
  }
}

export interface SerializeOptions {
  /** セクション見出し。既定は `## PubMed/MEDLINE` */
  heading?: string;
}

/**
 * PubmedFormula を search_formula.md 互換のマークダウンに整形する。
 *
 * - セクション見出し → 空行 → コードブロック → 空行 の順
 * - コードブロック内は `#<id> <expression>` の 1 行 1 ブロック
 * - `blocks` の並び順を保持する
 *
 * @throws {FormulaSerializeError} ブロック ID / 式が空の場合、または ID が規約外の場合
 */
export function serializePubmedFormulaMd(
  formula: PubmedFormula,
  options: SerializeOptions = {}
): string {
  const heading = options.heading ?? '## PubMed/MEDLINE';
  const body = formula.blocks.map(formatLine).join('\n');
  return `${heading}\n\n\`\`\`\n${body}\n\`\`\`\n`;
}

function formatLine(block: FormulaBlock): string {
  if (block.id === '') {
    throw new FormulaSerializeError('ブロック ID が空です');
  }
  if (!BLOCK_ID_PATTERN.test(block.id)) {
    throw new FormulaSerializeError(`ブロック ID が規約外です（英数字のみ許可）: ${block.id}`);
  }
  if (block.expression.trim() === '') {
    throw new FormulaSerializeError(`ブロック #${block.id} の式が空です`);
  }
  return `#${block.id} ${block.expression}`;
}
