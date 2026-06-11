import type { PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';
import { appendResidualTagWarning } from './residualPubmedTags';
import { DIALOG_RCT_FILTER, PUBMED_RCT_PT_REGEX } from './dialogRctFilter';

/**
 * PubMed 検索式を Dialog/Embase 向けに変換する。
 *
 * 主な変換（MVP）:
 * - `"X"[Mesh]` → `EMB.EXACT.EXPLODE("X")`
 * - `X[tiab]` → `(TI("X") OR AB("X"))`
 * - `"X"[Title]` → `TI("X")`
 * - `#N` 行番号 → `SN`
 * - `[ad]`（所属） → 削除 + 警告
 *
 * 近接演算子（`[tiab:~N]`）は MVP では近似せず、そのまま残して警告を出す。
 */
export function convertToDialog(formula: PubmedFormula): ConversionResult {
  const warnings: string[] = [];
  const lines = formula.blocks.map((block) => {
    const { expression, warnings: w } = convertDialogExpression(block.expression);
    for (const msg of w) {
      warnings.push(`S${block.id}: ${msg}`);
    }
    return `S${block.id} ${expression}`;
  });
  const result: ConversionResult = {
    targetDb: 'dialog',
    convertedFormula: lines.join('\n'),
    warnings: dedupe(warnings),
  };
  // MVP では [pt]/[sh]/[mh] 等の PubMed 固有タグは未変換で残るため、残存していれば警告する。
  return appendResidualTagWarning(result, 'Embase (Dialog)');
}

function convertDialogExpression(src: string): { expression: string; warnings: string[] } {
  // RCT 出版タイプフィルタを検知した場合は Cochrane Dialog RCT フィルタで代替する。
  // 元の PubMed 式（`"Randomized Controlled Trial"[pt]` 等）はブロックごと置換し、
  // 残存タグ警告は出さない。
  if (PUBMED_RCT_PT_REGEX.test(src)) {
    return { expression: DIALOG_RCT_FILTER, warnings: [] };
  }

  const warnings: string[] = [];
  let out = src;

  // 近接演算子 (tiab:~N) は MVP で未対応
  if (/\[tiab:~\d+\]/i.test(out) || /\[Title:~\d+\]/i.test(out)) {
    warnings.push('近接演算子は Dialog 用の N/W 演算子へは自動変換していません');
  }

  // "term"[Mesh] → EMB.EXACT.EXPLODE("term")
  out = out.replace(
    /"([^"]+)"\s*\[Mesh(?::NoExp)?\]/gi,
    (_m, term: string) => `EMB.EXACT.EXPLODE("${term}")`
  );

  // "term"[Title] → TI("term")
  out = out.replace(/"([^"]+)"\s*\[Title(?::~\d+)?\]/gi, (_m, term: string) => `TI("${term}")`);

  // "term"[tiab] → (TI("term") OR AB("term"))
  out = out.replace(
    /"([^"]+)"\s*\[tiab(?::~\d+)?\]/gi,
    (_m, term: string) => `(TI("${term}") OR AB("${term}"))`
  );

  // bare term[tiab]
  out = out.replace(
    /([A-Za-z0-9*-]+)\[tiab(?::~\d+)?\]/gi,
    (_m, term: string) => `(TI(${term}) OR AB(${term}))`
  );

  // [ad] は削除 + 警告
  if (/\[ad\]/i.test(out)) {
    warnings.push('所属フィールド [ad] は Dialog Embase の AF に近いが MVP では削除しました');
    out = out.replace(/([^\s]+)\[ad\]/gi, (_m, term: string) => term);
  }

  // 行番号参照 #N → SN
  out = out.replace(/#([A-Za-z0-9]+)/g, (_m, id: string) => `S${id}`);

  return { expression: out, warnings };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
