/**
 * `filter-designer` skill — フィルタ提案。
 * requirements.md §4.4 のホワイトリスト方式を**コードで強制**するため、
 * MVP 既定経路では LLM を呼ばず、決定的に動作する。LLM を呼ぶのは
 * §4.4 の「ヒット数が 10,000 件超のときに候補フィルタを提案する」例外経路のみ。
 */

import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

export interface FilterDesignerInput {
  /** プロトコルから推定された study_design（例: 'RCT', 'observational', 'any'） */
  studyDesign: string;
  /** プロトコルに明示された年代範囲（例: { fromYear: 2015 }）。無指定なら null */
  yearRange?: { fromYear?: number; toYear?: number } | null;
  /** 検索結果ヒット数。10,000 を超えると過大判定。null なら判定しない */
  hitCount?: number | null;
}

export interface DesignedFilter {
  /** ブロック ID（既定生成は `RCTfilter` / `DateFilter`） */
  blockId: string;
  /** PubMed クエリ片 */
  expression: string;
  /** 説明文（コメント行として残す） */
  comment: string;
}

export interface FilterDesignerResult {
  filters: DesignedFilter[];
  /** combination_expression に追記すべき AND 節（例: ` AND #RCTfilter AND #DateFilter`） */
  appendToCombination: string;
  /** ヒット過大時の追加候補（ユーザー承認待ち） */
  excessFilterCandidates: ExcessFilterCandidate[];
}

export interface ExcessFilterCandidate {
  label: string;
  expression: string;
  rationale: string;
}

/** ヒット過大の閾値（requirements.md §4.4 で確定） */
export const HIT_THRESHOLD = 10000;

/**
 * Cochrane Highly Sensitive Search Strategy（PubMed 版・2024 改訂・sensitivity-maximizing）。
 * 出典: Cochrane Handbook 2024 Box 4.b。
 *
 * NOTE: DesignedFilter.expression は `#<id> <expression>` の 1 行に直列化されるため、
 * クエリ本体だけを保持し、説明文は DesignedFilter.comment 側に寄せる。
 */
export const COCHRANE_HSSS_2024_PUBMED =
  '(randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT (humans[mh] AND animals[mh]))';

const RCT_DESIGN_PATTERN = /\b(rct|randomized|randomised)\b/i;

function isRct(studyDesign: string): boolean {
  return RCT_DESIGN_PATTERN.test(studyDesign);
}

function buildDateExpression(range: NonNullable<FilterDesignerInput['yearRange']>): string | null {
  const from = range.fromYear ?? null;
  const to = range.toYear ?? null;
  if (from === null && to === null) {
    return null;
  }
  const fromStr = from !== null ? `${from}/01/01` : '0001/01/01';
  const toStr = to !== null ? `${to}/12/31` : '3000/12/31';
  return `("${fromStr}"[Date - Publication] : "${toStr}"[Date - Publication])`;
}

/**
 * 既定フィルタ（Cochrane RCT + 明示された年代）を決定論的に組み立てる。
 * LLM 呼び出しなし。
 */
export function designDefaultFilters(input: FilterDesignerInput): FilterDesignerResult {
  const filters: DesignedFilter[] = [];
  const combinationParts: string[] = [];

  if (isRct(input.studyDesign)) {
    filters.push({
      blockId: 'RCTfilter',
      expression: COCHRANE_HSSS_2024_PUBMED,
      comment: 'Cochrane HSSS PubMed 2024 (sensitivity-maximizing) を適用',
    });
    combinationParts.push('AND #RCTfilter');
  }

  if (input.yearRange) {
    const dateExpr = buildDateExpression(input.yearRange);
    if (dateExpr) {
      filters.push({
        blockId: 'DateFilter',
        expression: dateExpr,
        comment: 'プロトコルで指定された年代範囲を適用',
      });
      combinationParts.push('AND #DateFilter');
    }
  }

  return {
    filters,
    appendToCombination: combinationParts.length === 0 ? '' : ` ${combinationParts.join(' ')}`,
    excessFilterCandidates: [],
  };
}

/* ----------------------------------------------------------------------- */
/* 事前定義フィルターカタログ — ユーザーが選択できる固定フィルター一覧      */
/* ----------------------------------------------------------------------- */

export interface PredefinedFilterDef {
  id: string;
  label: string;
  description: string;
  expression: string;
  /** 自動選択の判定に使う正規表現パターン文字列（studyDesign に対してテスト） */
  defaultForPattern: string;
  comment: string;
}

export const PREDEFINED_FILTER_DEFS: readonly PredefinedFilterDef[] = [
  {
    id: 'RCTfilter',
    label: 'RCT フィルター（Cochrane HSSS 2024）',
    description:
      'Cochrane Handbook 2024 推奨の感度優先 RCT フィルター（PubMed 版）。RCT を対象とするレビューで適用する。',
    expression: COCHRANE_HSSS_2024_PUBMED,
    defaultForPattern: '\\b(rct|randomized|randomised)\\b',
    comment: 'Cochrane HSSS PubMed 2024 (sensitivity-maximizing) を適用',
  },
  {
    id: 'SRfilter',
    label: '系統的レビュー・メタアナリシス フィルター',
    description:
      'SR / MA のみに絞り込む。Overview of reviews（傘レビュー）を実施する場合に使用する。通常の SR では不要。',
    expression:
      '(systematic review[pt] OR systematic review[ti] OR meta-analysis[pt] OR meta-analysis[ti])',
    defaultForPattern: '\\b(overview.?of.?review|umbrella.?review)\\b',
    comment: '系統的レビュー・メタアナリシス文献に絞り込む',
  },
];

/**
 * studyDesign 文字列から自動選択すべきフィルター ID のリストを返す。
 * 新規ドラフト作成時の初期値に使用する。
 */
export function getDefaultSelectedFilterIds(studyDesign: string): string[] {
  return PREDEFINED_FILTER_DEFS.filter((def) =>
    new RegExp(def.defaultForPattern, 'i').test(studyDesign)
  ).map((def) => def.id);
}

/**
 * ユーザーが選択したフィルター ID から FilterDesignerResult を組み立てる。
 * designDefaultFilters の代替（こちらはユーザー明示的選択ベース）。
 */
export function buildFiltersFromSelection(selectedIds: string[]): FilterDesignerResult {
  const filters: DesignedFilter[] = [];
  const combinationParts: string[] = [];

  for (const def of PREDEFINED_FILTER_DEFS) {
    if (selectedIds.includes(def.id)) {
      filters.push({
        blockId: def.id,
        expression: def.expression,
        comment: def.comment,
      });
      combinationParts.push(`AND #${def.id}`);
    }
  }

  return {
    filters,
    appendToCombination: combinationParts.length === 0 ? '' : ` ${combinationParts.join(' ')}`,
    excessFilterCandidates: [],
  };
}

/* ----------------------------------------------------------------------- */
/* ヒット過大時の追加フィルタ提案 — ここだけ LLM を呼ぶ                    */
/* ----------------------------------------------------------------------- */

const SKILL_NAME = 'filter-designer';

export const EXCESS_FILTER_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
PubMed のヒット数が 10,000 件を超えたため、検索式を絞る候補を提案します。

絶対ルール:
- プロトコルに明記されていない言語制限・被験種制限・publication type 制限を勝手に追加してはいけない。
  これらは感度を下げ、新規論文を取りこぼす重大なリスクです。
- 候補は必ず**ユーザー承認待ち**として提示する（rationale で除外可能性のリスクも併記）。
- 出力は JSON のみ。
`.trim();

export const EXCESS_FILTER_USER_PROMPT_TEMPLATE = `
study_design: {{DESIGN}}
現在のヒット数: {{HITS}}

スキーマ:
{
  "candidates": [
    {
      "label": "<候補名>",
      "expression": "<PubMed クエリ片>",
      "rationale": "<効果と漏れリスクの両方を日本語で>"
    }
  ]
}
`.trim();

interface RawExcess {
  candidates?: Array<{ label?: string; expression?: string; rationale?: string }>;
}

const EXCESS_FILTER_SCHEMA = objectSchema({
  candidates: arraySchema(
    objectSchema({
      label: stringSchema('候補名'),
      expression: stringSchema('PubMed クエリ片'),
      rationale: stringSchema('効果と漏れリスクの両方を日本語で'),
    })
  ),
});

/**
 * ヒット過大時に LLM へ追加フィルタ案を尋ねる。
 * 既定経路（designDefaultFilters）と独立しており、戻り値はあくまで候補。
 * 採用判断はユーザー UI で行う。
 */
export async function proposeExcessFilters(
  input: FilterDesignerInput,
  provider: LLMProvider
): Promise<ExcessFilterCandidate[]> {
  const hits = input.hitCount ?? 0;
  if (hits <= HIT_THRESHOLD) {
    return [];
  }
  const userPrompt = EXCESS_FILTER_USER_PROMPT_TEMPLATE.replace('{{DESIGN}}', input.studyDesign).replace(
    '{{HITS}}',
    String(hits)
  );
  const response = await provider.chat(
    [
      { role: 'system', content: EXCESS_FILTER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: EXCESS_FILTER_SCHEMA, temperature: 0.2 }
  );
  const raw = parseSkillJson<RawExcess>(response.text, SKILL_NAME);
  return (raw.candidates ?? []).map((c) => ({
    label: c.label ?? '',
    expression: c.expression ?? '',
    rationale: c.rationale ?? '',
  }));
}
