import type { LLMProvider } from '@/lib/llm';
import type {
  BlockRecallAdditions,
  RecallAdditionItem,
  RecallAxis,
} from '../recallExpansion';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

/**
 * `expand-query-for-recall` skill — 現検索式の各概念ブロックを 2 軸で広げる拡張語を提案する。
 *
 * #/expand の margin 探索で使う。目的は precision ではなく **recall を意図的に上げて式の外側
 * （境界事例）を探す** こと。LLM には以下を依頼する:
 * - MeSH 軸: そのブロックの概念より **一段広い MeSH 記述子**（親概念）を `"Descriptor"[Mesh]` で
 * - freeword 軸: MeSH に付かない同義語・略語・表記ゆれを `"phrase"[tiab]` で
 *
 * 研究デザイン/方法論フィルタ（RCT フィルタ等）のブロックは広げない（空で返す）。
 */

export interface RecallBlockInput {
  /** 現検索式の `#N` の N。 */
  id: string;
  /** ブロックの式本体（PubMed クエリ片）。 */
  expression: string;
}

export interface ExpandQueryForRecallInput {
  researchQuestion: string;
  blocks: RecallBlockInput[];
  /** 1 ブロックあたりの拡張語上限（既定 8）。 */
  perBlockLimit?: number;
}

const SKILL_NAME = 'expand-query-for-recall';
const DEFAULT_PER_BLOCK_LIMIT = 8;

export const EXPAND_RECALL_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
与えられた PubMed 検索式の各概念ブロックについて、**recall を一段広げる**ための追加語を設計します。
目的は精度ではなく、現在の式では取りこぼしている「境界事例（ぎりぎり外側）」の論文を拾うことです。

ルール:
- 各ブロックに対し 2 種類の追加語を出す:
  1. MeSH 軸（axis="mesh"）: そのブロックの概念より **一段広い（親）MeSH 記述子** を "Descriptor"[Mesh] 形式で。
     例: "Heart Failure" を含むブロック → "Heart Diseases"[Mesh]。
  2. freeword 軸（axis="freeword"）: MeSH に付与されない同義語・略語・表記ゆれを "phrase"[tiab] 形式で。
- 既に式に含まれている語と同じものは出さない（新規に広がる語だけ）。
- そのブロックが **研究デザイン/方法論フィルタ**（RCT・観察研究フィルタ等）の場合は広げない（additions を空配列に）。
- 1 ブロックあたり追加語は多すぎないように（指定上限以内）。
- 各追加語に rationale（日本語、1 文）を付ける。
- 出力は JSON のみ。
`.trim();

export const EXPAND_RECALL_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

現検索式のブロック:
{{BLOCKS}}

スキーマ:
{
  "blocks": [
    {
      "id": "<ブロック ID>",
      "additions": [
        { "term": "<PubMed クエリ片>", "axis": "mesh" | "freeword", "rationale": "<広げる根拠（日本語）>" }
      ]
    }
  ]
}
各ブロックにつき追加語は最大 {{LIMIT}} 件まで。広げない方がよいブロックは additions を [] にしてください。
`.trim();

interface RawAddition {
  term?: string;
  axis?: string;
  rationale?: string;
}
interface RawBlock {
  id?: string;
  additions?: RawAddition[];
}
interface RawResponse {
  blocks?: RawBlock[];
}

const EXPAND_RECALL_SCHEMA = objectSchema({
  blocks: arraySchema(
    objectSchema({
      id: stringSchema('ブロック ID'),
      additions: arraySchema(
        objectSchema({
          term: stringSchema('PubMed クエリ片'),
          axis: stringSchema('mesh または freeword'),
          rationale: stringSchema('広げる根拠（日本語）'),
        })
      ),
    })
  ),
});

export async function expandQueryForRecall(
  input: ExpandQueryForRecallInput,
  provider: LLMProvider
): Promise<BlockRecallAdditions[]> {
  if (input.blocks.length === 0) {
    return [];
  }
  const limit = clampLimit(input.perBlockLimit);
  const userPrompt = EXPAND_RECALL_USER_PROMPT_TEMPLATE.replace('{{RQ}}', input.researchQuestion)
    .replace('{{BLOCKS}}', formatBlocks(input.blocks))
    .replace('{{LIMIT}}', String(limit));

  const response = await provider.chat(
    [
      { role: 'system', content: EXPAND_RECALL_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: EXPAND_RECALL_SCHEMA, temperature: 0.4 }
  );
  const raw = parseSkillJson<RawResponse>(response.text, SKILL_NAME);
  const allowedIds = new Set(input.blocks.map((b) => b.id));

  const out: BlockRecallAdditions[] = [];
  for (const block of raw.blocks ?? []) {
    if (!block.id || !allowedIds.has(block.id)) continue;
    const additions: RecallAdditionItem[] = [];
    for (const a of block.additions ?? []) {
      const term = (a.term ?? '').trim();
      const axis = normalizeAxis(a.axis);
      if (term === '' || axis === null) continue;
      additions.push({ term, axis, rationale: a.rationale ?? '' });
      if (additions.length >= limit) break;
    }
    if (additions.length > 0) {
      out.push({ blockId: block.id, additions });
    }
  }
  return out;
}

function normalizeAxis(value: string | undefined): RecallAxis | null {
  if (value === 'mesh' || value === 'freeword') return value;
  return null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PER_BLOCK_LIMIT;
  }
  return Math.min(Math.floor(limit), 20);
}

function formatBlocks(blocks: readonly RecallBlockInput[]): string {
  return blocks.map((b) => `#${b.id} ${b.expression}`).join('\n');
}
