import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';

/**
 * `interpret-result` skill — シード捕捉率検証で「漏れた（未捕捉）PMID」について、
 * 検索式のどの行（ブロック）が捕捉できなかった原因かを推定し、
 * 具体的な改善候補語（MeSH / tiab 語）を提案する。
 *
 * requirements.md §4.6 の「シード捕捉率の漏れ PMID の原因分析（AI）」に対応する。
 * 自動実行ではなくユーザー操作起点で呼ばれる（validate 画面の「AI で原因を分析する」ボタン）。
 *
 * 入力は最終検索式（展開済みクエリ）と各行の expression、漏れ PMID ごとの書誌
 * （title / abstract / MeSH。NCBI efetch の EfetchArticle から渡す）。
 * 出力は PMID ごとの原因説明・改善候補語・原因と思われるブロック ID。
 */

/** 漏れ PMID 1 件分の書誌情報（efetch の EfetchArticle から必要分を抜き出して渡す） */
export interface MissedArticleInput {
  pmid: string;
  title: string | null;
  abstract: string | null;
  meshHeadings: string[];
}

/** 検索式の 1 行（blockId と PubMed 表現） */
export interface FormulaLineInput {
  blockId: string;
  expression: string;
}

export interface InterpretResultInput {
  /** 最終検索式（formula markdown または展開済みクエリ）。文脈として LLM に渡す */
  finalQuery: string;
  /** 検索式の行一覧（blockId + expression） */
  lines: FormulaLineInput[];
  /** 漏れ PMID ごとの書誌情報 */
  missedArticles: MissedArticleInput[];
}

export interface MissedSeedAnalysis {
  pmid: string;
  /** 原因の日本語説明（1-3 文） */
  cause: string;
  /** 追加候補のクエリ片（MeSH / tiab 語） */
  suggestedTerms: string[];
  /** 原因と思われるブロック ID（例: 1, 2, RCTfilter）。不明なら null */
  relatedBlock: string | null;
}

const SKILL_NAME = 'interpret-result';

export const INTERPRET_RESULT_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
最終検索式がシード論文（組入対象として確定済み）を取りこぼした原因を分析します。

各漏れ PMID について:
- 提示された書誌情報（タイトル / 抄録 / MeSH）と検索式の各行（ブロック）を突き合わせる。
- どの行（ブロック）がこの論文を捕捉できなかった主因かを推定する。
- その行に追加すべき具体的な候補語（MeSH 記述子 / tiab 語）を提案する。

ルール:
- 出力は JSON のみ。
- cause は日本語 1-3 文で、なぜ取りこぼしたか（どの概念が式に無いか等）を具体的に書く。
- suggested_terms は PubMed 検索式にそのまま足せる語句（例: "diabetes mellitus, type 2"[MeSH Terms] / "type 2 diabetes"[tiab]）。
- related_block は原因と思われるブロック ID を 1 つだけ。複数ブロックに跨り特定できない場合や、
  検索式以外（PubMed 未収載など）が原因と思われる場合は null。
- 提示された PMID 以外を勝手に追加しない。
`.trim();

export const INTERPRET_RESULT_USER_PROMPT_TEMPLATE = `
最終検索式（参考）:
{{FINAL_QUERY}}

検索式の行:
{{LINES}}

漏れ PMID（{{COUNT}} 件）:
{{ARTICLES}}

スキーマ:
{
  "analyses": [
    {
      "pmid": "<PMID>",
      "cause": "<原因の日本語説明 1-3 文>",
      "suggested_terms": ["<追加候補のクエリ片>"],
      "related_block": "<原因と思われるブロック ID 例: 1, 2, RCTfilter。不明なら null>"
    }
  ]
}
`.trim();

interface RawAnalysis {
  pmid?: string;
  cause?: string;
  suggested_terms?: unknown;
  related_block?: unknown;
}

interface RawResponse {
  analyses?: RawAnalysis[];
}

export async function interpretResult(
  input: InterpretResultInput,
  provider: LLMProvider
): Promise<MissedSeedAnalysis[]> {
  if (input.missedArticles.length === 0) {
    return [];
  }
  const userPrompt = INTERPRET_RESULT_USER_PROMPT_TEMPLATE.replace(
    '{{FINAL_QUERY}}',
    input.finalQuery.trim() === '' ? '(未提供)' : input.finalQuery.trim()
  )
    .replace('{{LINES}}', formatLines(input.lines))
    .replace('{{COUNT}}', String(input.missedArticles.length))
    .replace('{{ARTICLES}}', formatArticles(input.missedArticles));

  const response = await provider.chat(
    [
      { role: 'system', content: INTERPRET_RESULT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', temperature: 0.3 }
  );
  const raw = parseSkillJson<RawResponse>(response.text, SKILL_NAME);
  const allowedPmids = new Set(input.missedArticles.map((a) => a.pmid));
  const seen = new Set<string>();
  const analyses: MissedSeedAnalysis[] = [];
  for (const item of raw.analyses ?? []) {
    if (!item.pmid || !allowedPmids.has(item.pmid) || seen.has(item.pmid)) {
      continue;
    }
    seen.add(item.pmid);
    analyses.push({
      pmid: item.pmid,
      cause: typeof item.cause === 'string' ? item.cause : '',
      suggestedTerms: normalizeTerms(item.suggested_terms),
      relatedBlock: normalizeRelatedBlock(item.related_block),
    });
  }
  return analyses;
}

function formatLines(lines: FormulaLineInput[]): string {
  if (lines.length === 0) {
    return '(行情報なし)';
  }
  return lines.map((line) => `- #${line.blockId}: ${line.expression}`).join('\n');
}

function formatArticles(articles: MissedArticleInput[]): string {
  return articles
    .map((a) => {
      const title = a.title ?? '(no title)';
      const abstract = a.abstract ?? '(no abstract)';
      const mesh = a.meshHeadings.length === 0 ? '(none)' : a.meshHeadings.join(', ');
      return [
        `PMID ${a.pmid}`,
        `  title: ${title}`,
        `  abstract: ${abstract}`,
        `  MeSH: ${mesh}`,
      ].join('\n');
    })
    .join('\n\n');
}

function normalizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function normalizeRelatedBlock(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  // LLM が文字列 "null" を返すケースも null に正規化する
  if (trimmed === '' || trimmed.toLowerCase() === 'null') {
    return null;
  }
  return trimmed;
}
