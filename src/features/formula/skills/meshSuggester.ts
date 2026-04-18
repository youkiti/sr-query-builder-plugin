import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson } from './parseSkillJson';

/**
 * `mesh-suggester` skill — ブロック概念に対応する MeSH 記述子を提案する。
 * seed 論文の MeSH（aggregateMeshFrequency の出力）を渡すと、
 * 既存付与傾向を踏まえた提案になる。
 */

export interface MeshSuggesterInput {
  conceptSummary: string;
  meshRequirements: string[];
  /** seed 論文の MeSH 出現頻度。空配列でも可 */
  seedMeshFrequency: Array<{ descriptor: string; count: number }>;
}

export interface MeshSuggestion {
  descriptor: string;
  /** [Mesh] 形式での想定タグ（例: `"Diabetes Mellitus"[Mesh]`） */
  tagSyntax: string;
  /** 採用根拠の自然文メモ（UI 表示用） */
  rationale: string;
}

const SKILL_NAME = 'mesh-suggester';

export const MESH_SUGGESTER_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書です。
ブロックの概念に対し、PubMed の MeSH 記述子を提案します。

ルール:
- seed 論文に頻出する MeSH を優先するが、ブロック概念を捉えていなければ採用しない。
- 上位語と下位語のどちらを採用するかは、感度・特異度のバランスで判断する。
  既定は上位語 + Explode（PubMed 既定動作）。NoExp 指定が必要な場合だけ tagSyntax に [Mesh:NoExp] を入れる。
- 各候補に rationale（日本語、1-2 文）を必ず付ける。
- 出力は JSON のみ。
`.trim();

export const MESH_SUGGESTER_USER_PROMPT_TEMPLATE = `
ブロック概念: {{CONCEPT}}

ブロック側の MeSH 要件（方向性）:
{{REQUIREMENTS}}

seed 論文の MeSH 出現頻度（多い順）:
{{SEED_MESH}}

スキーマ:
{
  "suggestions": [
    {
      "descriptor": "<英語の MeSH 記述子>",
      "tag_syntax": "<descriptor>[Mesh]",
      "rationale": "<採用根拠（日本語）>"
    }
  ]
}
`.trim();

interface RawMesh {
  suggestions?: Array<{ descriptor?: string; tag_syntax?: string; rationale?: string }>;
}

export async function suggestMesh(
  input: MeshSuggesterInput,
  provider: LLMProvider
): Promise<MeshSuggestion[]> {
  const requirementsBlock = formatList(input.meshRequirements);
  const seedBlock = input.seedMeshFrequency.length === 0
    ? '(seed 論文の MeSH なし)'
    : input.seedMeshFrequency.map((r) => `- ${r.descriptor} (×${r.count})`).join('\n');

  const userPrompt = MESH_SUGGESTER_USER_PROMPT_TEMPLATE.replace('{{CONCEPT}}', input.conceptSummary)
    .replace('{{REQUIREMENTS}}', requirementsBlock)
    .replace('{{SEED_MESH}}', seedBlock);

  const response = await provider.chat(
    [
      { role: 'system', content: MESH_SUGGESTER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', temperature: 0.3 }
  );
  const raw = parseSkillJson<RawMesh>(response.text, SKILL_NAME);
  return (raw.suggestions ?? []).map((s) => ({
    descriptor: s.descriptor ?? '',
    tagSyntax: s.tag_syntax ?? '',
    rationale: s.rationale ?? '',
  }));
}

function formatList(items: readonly string[]): string {
  return items.length === 0 ? '(なし)' : items.map((s) => `- ${s}`).join('\n');
}
