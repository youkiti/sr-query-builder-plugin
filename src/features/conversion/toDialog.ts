import type { PubmedFormula } from '@/lib/search-formula-md';
import type { ConversionResult } from './types';
import { appendResidualTagWarning } from './residualPubmedTags';
import { DIALOG_RCT_FILTER, PUBMED_RCT_PT_REGEX } from './dialogRctFilter';
import { replaceProximityOperators } from './proximityOperator';

/** MeSH → Emtree の恒等写像に対する注意喚起。自動マッピングは行わない（スコープ外）。 */
const EMTREE_MAPPING_WARNING =
  'MeSH 記述子を Emtree 語として仮置きしています。Emtree で確認してください';

/**
 * PubMed 検索式を Dialog/Embase 向けに変換する。
 *
 * 主な変換（MVP）:
 * - `"X"[Mesh]` → `EMB.EXACT.EXPLODE("X")`（Emtree に存在するかは未検証。警告を付す）
 * - `X[tiab]` → `(TI("X") OR AB("X"))`
 * - `"X"[Title]` → `TI("X")`
 * - `"X Y"[tiab:~N]` 等の近接演算子 → `TI,AB(X N/N Y)` 等
 *   （移植元: search_converter.py の `convert_line_to_dialog` 158-191 行）
 * - `#N` 行番号 → `SN`。ブロック ID の見た目（`1` `2A` 等）を使わず、
 *   出現順に `S1`, `S2`, ... を採番してから境界安全な regex で参照を書き換える
 *   （移植元: `convert_to_dialog` の `line_mapping` 228-274 行）。
 *   PubMed 側の行番号が連番でなくても、Dialog 上で実際に検索式を投入する順序と
 *   一致した S 番号になる。
 * - `[ad]`（所属） → 削除 + 警告
 */
export function convertToDialog(formula: PubmedFormula): ConversionResult {
  const warnings: string[] = [];

  // 出現順に S1, S2, ... を採番する（line_mapping 相当）。
  // ブロック ID をそのまま `S<id>` にすると、ID が連番でない場合
  // （例: 欠番がある / "2A" のような枝番）に Dialog の実際の集合番号と
  // ずれて誤った集合を参照してしまう。
  const lineMapping = new Map<string, string>();
  formula.blocks.forEach((block, index) => {
    lineMapping.set(block.id, `S${index + 1}`);
  });

  let hadMeshConversion = false;
  const convertedLines = formula.blocks.map((block) => {
    const dialogId = lineMapping.get(block.id) as string;
    const { expression, warnings: w, hadMesh } = convertDialogExpression(block.expression);
    if (hadMesh) {
      hadMeshConversion = true;
    }
    for (const msg of w) {
      warnings.push(`${dialogId}: ${msg}`);
    }
    return `${dialogId} ${expression}`;
  });

  // #N 参照を SN へ書き換える（境界安全。ID が他の ID の接頭辞になるケースに備えて長い順）。
  const finalLines = convertedLines.map((line) => rewriteBlockReferences(line, lineMapping));

  if (hadMeshConversion) {
    warnings.push(EMTREE_MAPPING_WARNING);
  }

  const result: ConversionResult = {
    targetDb: 'dialog',
    convertedFormula: finalLines.join('\n'),
    warnings: dedupe(warnings),
  };
  // MVP では [pt]/[sh]/[mh] 等の PubMed 固有タグは未変換で残るため、残存していれば警告する。
  return appendResidualTagWarning(result, 'Embase (Dialog)');
}

function convertDialogExpression(src: string): {
  expression: string;
  warnings: string[];
  hadMesh: boolean;
} {
  // RCT 出版タイプフィルタを検知した場合は Cochrane Dialog RCT フィルタで代替する。
  // 元の PubMed 式（`"Randomized Controlled Trial"[pt]` 等）はブロックごと置換し、
  // 残存タグ警告も Emtree 警告も出さない（Cochrane Handbook 由来の検証済みフィルタであり、
  // MeSH → Emtree の素朴な仮置きではないため）。
  if (PUBMED_RCT_PT_REGEX.test(src)) {
    return { expression: DIALOG_RCT_FILTER, warnings: [], hadMesh: false };
  }

  const warnings: string[] = [];
  let out = src;

  // 近接演算子 "term1 term2"[field:~N] → TI,AB(term1 N/N term2) 等
  // （後続の Mesh/Title/tiab 変換より先に処理し、二重変換を防ぐ）
  out = replaceProximityOperators(out, ({ terms, field, distance }) => {
    const dialogField = dialogProximityField(field);
    if (terms.length === 2) {
      if (distance === 0) {
        // 隣接（間に単語なし、順序固定で 1 単語以内） → W/1
        return `${dialogField}(${terms[0]} W/1 ${terms[1]})`;
      }
      // N 語以内の近接（順序不同） → N/n
      return `${dialogField}(${terms[0]} N/${distance} ${terms[1]})`;
    }
    // 3 語以上は N/W に対応する構文が無いため AND で結合する
    return `${dialogField}(${terms.join(' AND ')})`;
  });

  // "term"[Mesh] → EMB.EXACT.EXPLODE("term")
  const hadMesh = /"[^"]+"\s*\[Mesh(?::NoExp)?\]/i.test(out);
  out = out.replace(
    /"([^"]+)"\s*\[Mesh(?::NoExp)?\]/gi,
    (_m, term: string) => `EMB.EXACT.EXPLODE("${term}")`
  );

  // "term"[Title] → TI("term")
  out = out.replace(/"([^"]+)"\s*\[Title\]/gi, (_m, term: string) => `TI("${term}")`);

  // "term"[tiab] → (TI("term") OR AB("term"))
  out = out.replace(
    /"([^"]+)"\s*\[tiab\]/gi,
    (_m, term: string) => `(TI("${term}") OR AB("${term}"))`
  );

  // bare term[tiab]
  out = out.replace(
    /([A-Za-z0-9*-]+)\[tiab\]/gi,
    (_m, term: string) => `(TI(${term}) OR AB(${term}))`
  );

  // [ad] は削除 + 警告
  if (/\[ad\]/i.test(out)) {
    warnings.push('所属フィールド [ad] は Dialog Embase の AF に近いが MVP では削除しました');
    out = out.replace(/([^\s]+)\[ad\]/gi, (_m, term: string) => term);
  }

  return { expression: out, warnings, hadMesh };
}

/**
 * 近接演算子のフィールドを Dialog のフィールド関数へ写像する。
 * 移植元: search_converter.py `convert_line_to_dialog` 169-176 行。
 */
function dialogProximityField(field: string): string {
  if (field === 'ti' || field === 'title') {
    return 'TI';
  }
  if (field === 'tiab' || field === 'title/abstract') {
    return 'TI,AB';
  }
  if (field === 'ad' || field === 'affiliation') {
    // 所属機関フィールド
    return 'CS';
  }
  return 'TI,AB';
}

/**
 * `#<pubmedId>` への参照を、出現順に採番した Dialog の `S<N>` へ境界安全に書き換える。
 * 移植元: `convert_to_dialog` 264-273 行（`line_mapping` を長い ID から順に適用する処理）。
 *
 * 直前が英数字・アンダースコア・`#` でなく、直後が英数字・アンダースコアでない
 * 箇所のみを置換対象とする（`#1` が `#12` の一部に誤って一致しないようにする）。
 */
function rewriteBlockReferences(line: string, lineMapping: Map<string, string>): string {
  const sortedEntries = Array.from(lineMapping.entries()).sort(
    (a, b) => b[0].length - a[0].length
  );
  let result = line;
  for (const [pubmedId, dialogId] of sortedEntries) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_#])#${pubmedId}(?![A-Za-z0-9_])`, 'g');
    result = result.replace(pattern, dialogId);
  }
  return result;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
