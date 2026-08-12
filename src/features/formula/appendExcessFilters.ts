import {
  parsePubmedFormulaMd,
  serializePubmedFormulaMd,
  type FormulaBlock,
} from '@/lib/search-formula-md';

/**
 * 過大ヒット時にユーザーが承認した絞り込みフィルタを、既存の検索式 md へ追記する
 * （requirements.md §4.4 / fix-plan 2-1）。
 *
 * - 新しいフィルタブロック（`#Filter1 <expression>` 形式）を結合行の直前へ挿入する
 * - 結合行（最後の isCombination ブロック）の式へ ` AND #Filter1` を追記する
 * - ブロック ID は既存 ID と衝突しない `FilterN` を採番する
 *
 * 呼び出し側（bootstrap）は戻り値の md を saveEditedFormula で新バージョンとして保存する。
 * 承認されていない候補をここへ渡してはならない（承認ゲートは UI 側の責務）。
 */

export interface ApprovedExcessFilter {
  /** UI 表示用の候補名（FormulaVersions の note に使う） */
  label: string;
  /** PubMed クエリ片 */
  expression: string;
}

export class AppendExcessFiltersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppendExcessFiltersError';
  }
}

export function appendExcessFilterBlocks(
  formulaMd: string,
  filters: ApprovedExcessFilter[]
): string {
  if (filters.length === 0) {
    throw new AppendExcessFiltersError('追記するフィルタがありません');
  }
  const formula = parsePubmedFormulaMd(formulaMd);
  const combinationIndex = findLastCombinationIndex(formula.blocks);
  if (combinationIndex < 0) {
    throw new AppendExcessFiltersError(
      '結合行が見つかりません。検索式の最終行（#N AND #M 形式）を確認してください'
    );
  }

  const usedIds = new Set(formula.blocks.map((block) => block.id.toLowerCase()));
  const newBlocks: FormulaBlock[] = [];
  const appendedRefs: string[] = [];
  for (const filter of filters) {
    const expression = filter.expression.trim();
    if (expression === '') {
      throw new AppendExcessFiltersError(`候補「${filter.label}」の式が空です`);
    }
    const id = nextFilterId(usedIds);
    usedIds.add(id.toLowerCase());
    newBlocks.push({ id, expression, isCombination: false });
    appendedRefs.push(`#${id}`);
  }

  const combination = formula.blocks[combinationIndex] as FormulaBlock;
  const newCombinationExpression = `${combination.expression} ${appendedRefs
    .map((ref) => `AND ${ref}`)
    .join(' ')}`;

  const blocks: FormulaBlock[] = [
    ...formula.blocks.slice(0, combinationIndex),
    ...newBlocks,
    { ...combination, expression: newCombinationExpression },
    ...formula.blocks.slice(combinationIndex + 1),
  ];
  return serializePubmedFormulaMd({ blocks, combinationExpression: newCombinationExpression });
}

function findLastCombinationIndex(blocks: FormulaBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.isCombination) {
      return i;
    }
  }
  return -1;
}

/** 既存 ID と衝突しない `FilterN` を返す（大文字小文字を区別せず判定） */
function nextFilterId(usedIds: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `Filter${n}`;
    if (!usedIds.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
