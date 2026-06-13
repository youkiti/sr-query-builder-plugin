import type {
  BlockSkeleton,
  FilterDesignerResult,
  FreewordSuggestion,
  MeshSuggestion,
} from '@/features/formula/skills';
import {
  serializePubmedFormulaMd,
  type FormulaBlock,
  type PubmedFormula,
} from '@/lib/search-formula-md';

/**
 * 4 skill の出力と Protocol の combination_expression を束ねて、
 * search_formula.md 派生フォーマット（PubMed セクション）を組み立てる。
 *
 * レイアウト:
 * - `#1 ... #N` : ユーザーブロック（mesh + freeword を OR 結合）
 * - `#RCTfilter` 等 : filter-designer が提案したフィルタブロック（名前付き）
 * - 最終行 : `#<N+1>` = combination_expression + フィルタ AND 追加
 *
 * base combination（Protocol.combination_expression）の `#N` 参照は
 * そのままユーザーブロックを指す。filterResult.appendToCombination は
 * ` AND #RCTfilter ...` の形で末尾に追記される前提。
 */

export interface BlockOutputs {
  skeleton: BlockSkeleton;
  mesh: MeshSuggestion[];
  freewords: FreewordSuggestion[];
}

export interface AssembleInput {
  /** Protocol.combination_expression。例: `#1 AND #2 AND #3` */
  baseCombinationExpression: string;
  /** ユーザーブロック（ProtocolBlocks）に対応する skill 出力。順番が #1..#N と対応 */
  blocks: BlockOutputs[];
  /** filter-designer が提示したフィルタブロック + combination 追記 */
  filterResult: FilterDesignerResult;
}

export interface AssembledFormula {
  /** 構造化した PubmedFormula（parse / validate 用） */
  formula: PubmedFormula;
  /** serializePubmedFormulaMd の結果（Sheets / Drive へ保存する本文） */
  markdown: string;
}

export class AssembleFormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssembleFormulaError';
  }
}

export function assembleFormulaMd(input: AssembleInput): AssembledFormula {
  if (input.blocks.length < 1 || input.blocks.length > 5) {
    throw new AssembleFormulaError(
      `user block は 1〜5 個である必要があります: ${input.blocks.length} 個`
    );
  }
  const userBlocks: FormulaBlock[] = input.blocks.map((block, index) => ({
    id: String(index + 1),
    expression: buildBlockExpression(block),
    isCombination: false,
  }));
  const filterBlocks: FormulaBlock[] = input.filterResult.filters.map((filter) => ({
    id: filter.blockId,
    expression: filter.expression,
    isCombination: false,
  }));
  const finalId = String(userBlocks.length + 1);
  const finalExpression = buildFinalExpression(
    input.baseCombinationExpression,
    input.filterResult.appendToCombination
  );
  if (finalExpression === '') {
    throw new AssembleFormulaError(
      '結合式が空です。Protocol.combination_expression を確認してください'
    );
  }
  const finalBlock: FormulaBlock = {
    id: finalId,
    expression: finalExpression,
    isCombination: true,
  };

  const blocks = [...userBlocks, ...filterBlocks, finalBlock];
  const formula: PubmedFormula = {
    blocks,
    combinationExpression: finalExpression,
  };
  const markdown = serializePubmedFormulaMd(formula);
  return { formula, markdown };
}

/**
 * 1 つの概念ブロック（mesh + freeword）を `(A OR B OR ...)` 形式の式へ組み立てる。
 * assembleFormulaMd と、生成途中のブロック単体ヒット数計測（line_hits）で共有する。
 * 概念ブロックは `#N` 参照を含まない葉なので、戻り値はそのまま esearch に投げられる。
 */
export function buildBlockExpression(block: BlockOutputs): string {
  const terms: string[] = [];
  for (const mesh of block.mesh) {
    const token = (mesh.tagSyntax || mesh.descriptor).trim();
    if (token) terms.push(token);
  }
  for (const freeword of block.freewords) {
    const token = freeword.query.trim();
    if (token) terms.push(token);
  }
  if (terms.length === 0) {
    // skill が候補を全く返さなかった場合のフォールバック。
    // 後続 UI で明示的に編集させるためにプレースホルダを残す。
    return `/* TODO: block concept = ${block.skeleton.conceptSummary || 'unspecified'} */`;
  }
  if (terms.length === 1) {
    return terms[0] as string;
  }
  return `(${terms.join(' OR ')})`;
}

function buildFinalExpression(base: string, append: string): string {
  const trimmedBase = base.trim() === '' ? '' : base.trim();
  const trimmedAppend = append.trim() === '' ? '' : append.trim();
  if (trimmedBase === '' && trimmedAppend === '') {
    return '';
  }
  if (trimmedBase === '') {
    // append は先頭に AND が付く規約なので、それを落とす
    return trimmedAppend.replace(/^AND\s+/i, '');
  }
  if (trimmedAppend === '') {
    return trimmedBase;
  }
  return `${trimmedBase} ${trimmedAppend}`;
}
