import type { TargetDatabase } from '@/domain/conversion';
import type { PubmedFormula } from '@/lib/search-formula-md';

/**
 * 各 DB 向け変換器の共通 I/F。
 * 実装は features/conversion/to*.ts。
 */
export interface ConversionResult {
  targetDb: TargetDatabase;
  /** 変換後の検索式（Sheets の `converted_formula` 列に入れる本文） */
  convertedFormula: string;
  /** 変換で取りこぼした要素（例: `[ad]` タグを落とした、近接演算子を AND に退化させた等） */
  warnings: string[];
}

export type Converter = (formula: PubmedFormula) => ConversionResult;
