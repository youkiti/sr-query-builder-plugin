import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

/**
 * `pick-boundary-cases` skill — 検索式のヒット集合から
 * 「組入判定が迷いやすい（境界事例）」論文を数件選ぶ。
 *
 * requirements.md §4.3 の対話的 seed 拡張（interactive）で使う。
 * ユーザーは返ってきた候補に include / exclude / maybe を付け、
 * include は `SeedPapers` に source=interactive として追加される。
 */

export interface BoundaryCandidate {
  pmid: string;
  title: string | null;
  year: number | null;
  meshHeadings: string[];
}

export interface PickBoundaryCasesInput {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  candidates: BoundaryCandidate[];
  /** 欲しい候補件数（既定 5、上限 10） */
  limit?: number;
}

export interface BoundaryPick {
  pmid: string;
  /** なぜこの PMID が境界事例なのかの日本語説明 */
  reason: string;
}

const SKILL_NAME = 'pick-boundary-cases';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export const PICK_BOUNDARY_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
検索式で取れた論文集合の中から、組入判定が「迷いやすい」＝境界事例の論文だけを抽出します。

ルール:
- 明確に include / exclude と言える論文は選ばない。
- 組入基準の一部だけ満たす、対象集団が一部ずれる、介入が類似だが異なる、など微妙な例を優先。
- 候補は指定件数以内で返す（不足する場合は少なくてよい）。
- 各候補には「なぜ迷うか」を短い日本語で添える。
- 出力は JSON のみ。
`.trim();

export const PICK_BOUNDARY_USER_PROMPT_TEMPLATE = `
RQ: {{RQ}}

組入基準:
{{INCLUSION}}

除外基準:
{{EXCLUSION}}

候補（{{COUNT}} 件）:
{{CANDIDATES}}

スキーマ:
{
  "picks": [
    { "pmid": "<PMID>", "reason": "<境界事例として迷う理由（日本語）>" }
  ]
}
最大 {{LIMIT}} 件まで選んでください。
`.trim();

interface RawPick {
  pmid?: string;
  reason?: string;
}

interface RawResponse {
  picks?: RawPick[];
}

const PICK_BOUNDARY_SCHEMA = objectSchema({
  picks: arraySchema(
    objectSchema({
      pmid: stringSchema('PMID'),
      reason: stringSchema('境界事例として迷う理由（日本語）'),
    })
  ),
});

export async function pickBoundaryCases(
  input: PickBoundaryCasesInput,
  provider: LLMProvider
): Promise<BoundaryPick[]> {
  if (input.candidates.length === 0) {
    return [];
  }
  const limit = clampLimit(input.limit);
  const userPrompt = PICK_BOUNDARY_USER_PROMPT_TEMPLATE.replace(
    '{{RQ}}',
    input.researchQuestion
  )
    .replace('{{INCLUSION}}', input.inclusionCriteria || '(未記載)')
    .replace('{{EXCLUSION}}', input.exclusionCriteria || '(未記載)')
    .replace('{{COUNT}}', String(input.candidates.length))
    .replace('{{CANDIDATES}}', formatCandidates(input.candidates))
    .replace('{{LIMIT}}', String(limit));

  const response = await provider.chat(
    [
      { role: 'system', content: PICK_BOUNDARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: PICK_BOUNDARY_SCHEMA, temperature: 0.3 }
  );
  const raw = parseSkillJson<RawResponse>(response.text, SKILL_NAME);
  const allowedPmids = new Set(input.candidates.map((c) => c.pmid));
  const picks: BoundaryPick[] = [];
  for (const item of raw.picks ?? []) {
    if (!item.pmid || !allowedPmids.has(item.pmid)) {
      continue;
    }
    picks.push({ pmid: item.pmid, reason: item.reason ?? '' });
    if (picks.length >= limit) break;
  }
  return picks;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function formatCandidates(candidates: BoundaryCandidate[]): string {
  return candidates
    .map((c) => {
      const year = c.year === null ? '-' : String(c.year);
      const title = c.title ?? '(no title)';
      const mesh = c.meshHeadings.length === 0 ? '' : ` / MeSH: ${c.meshHeadings.slice(0, 5).join(', ')}`;
      return `- PMID ${c.pmid} (${year}): ${title}${mesh}`;
    })
    .join('\n');
}
