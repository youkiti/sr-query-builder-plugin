import type { LLMProvider } from '@/lib/llm';
import type { BoundaryCandidate, BoundaryPick } from './pickBoundaryCases';
import { parseSkillJson } from './parseSkillJson';
import { arraySchema, objectSchema, stringSchema } from './schema';

/**
 * `pick-seed-candidates` skill — 検索式の **内側**（現式ヒット集合）から
 * 「組入基準に明確に合致しそうな代表的論文」を数件選ぶ。
 *
 * 用途は #/expand の **初期シードブートストラップ**（有効 seed が 0 件のとき）。
 * 通常の対話的拡張（pick-boundary-cases）は式の *外側* から「判定が迷う境界事例」を
 * 拾って取りこぼしを顕在化させるが、seed が 1 件も無い段階では捕捉率の基準が無く、
 * まず「確度の高い初期シード集合」を作ることが先決になる。そのため境界事例ではなく
 * **核となりそうな代表例**を優先して選ぶ。
 *
 * 返り値は pick-boundary-cases と互換（pmid + reason）。reason は「なぜ該当しそうか」。
 */

export interface PickSeedCandidatesInput {
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  candidates: BoundaryCandidate[];
  /** 欲しい候補件数（既定 5、上限 10） */
  limit?: number;
}

const SKILL_NAME = 'pick-seed-candidates';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export const PICK_SEED_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
検索式で取れた論文集合の中から、組入基準に「明確に合致しそうな」代表的な論文を抽出します。
これはまだシード論文が 1 件も無い段階で、最初の確度の高いシード集合を作るための作業です。

ルール:
- 組入基準に明確に合致しそうな、研究の核となる代表例を優先する（迷う境界事例は選ばない）。
- 対象集団・介入・アウトカムが RQ と素直に一致する論文を選ぶ。
- 多様性も少し意識し、ほぼ同一の論文ばかりを並べない。
- 候補は指定件数以内で返す（不足する場合は少なくてよい）。
- 各候補には「なぜ該当しそうか」を短い日本語で添える。
- 出力は JSON のみ。
`.trim();

export const PICK_SEED_USER_PROMPT_TEMPLATE = `
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
    { "pmid": "<PMID>", "reason": "<なぜ組入基準に該当しそうか（日本語）>" }
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

const PICK_SEED_SCHEMA = objectSchema({
  picks: arraySchema(
    objectSchema({
      pmid: stringSchema('PMID'),
      reason: stringSchema('組入基準に該当しそうな理由（日本語）'),
    })
  ),
});

export async function pickSeedCandidates(
  input: PickSeedCandidatesInput,
  provider: LLMProvider
): Promise<BoundaryPick[]> {
  if (input.candidates.length === 0) {
    return [];
  }
  const limit = clampLimit(input.limit);
  const userPrompt = PICK_SEED_USER_PROMPT_TEMPLATE.replace('{{RQ}}', input.researchQuestion)
    .replace('{{INCLUSION}}', input.inclusionCriteria || '(未記載)')
    .replace('{{EXCLUSION}}', input.exclusionCriteria || '(未記載)')
    .replace('{{COUNT}}', String(input.candidates.length))
    .replace('{{CANDIDATES}}', formatCandidates(input.candidates))
    .replace('{{LIMIT}}', String(limit));

  const response = await provider.chat(
    [
      { role: 'system', content: PICK_SEED_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: PICK_SEED_SCHEMA, temperature: 0.3 }
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
      const mesh =
        c.meshHeadings.length === 0 ? '' : ` / MeSH: ${c.meshHeadings.slice(0, 5).join(', ')}`;
      return `- PMID ${c.pmid} (${year}): ${title}${mesh}`;
    })
    .join('\n');
}
