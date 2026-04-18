import type { PubmedFormula } from '@/lib/search-formula-md';
import { convertToCentral } from './toCentral';
import { convertToClinicalTrials } from './toClinicalTrials';
import { convertToDialog } from './toDialog';
import { convertToIctrp } from './toIctrp';
import type { ConversionResult } from './types';

/**
 * 4 DB 向けに一括変換する。結果は `ConversionResult[]` で返し、
 * 呼び出し側は各行を `Conversions` タブに 1 行ずつ保存する。
 */
export function convertToAllDatabases(formula: PubmedFormula): ConversionResult[] {
  return [
    convertToCentral(formula),
    convertToDialog(formula),
    convertToClinicalTrials(formula),
    convertToIctrp(formula),
  ];
}
