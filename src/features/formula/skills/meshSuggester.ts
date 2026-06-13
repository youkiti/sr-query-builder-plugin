import type { LLMProvider } from '@/lib/llm';
import type { SeedMeshSummary } from '@/features/validation';
import { parseSkillJson } from './parseSkillJson';

/**
 * `mesh-suggester` skill — ブロック概念に対応する MeSH 記述子を提案する。
 * seed 論文の MeSH 要約（summarizeSeedMesh の出力）を渡すと、
 * カバレッジ・MajorTopic・qualifier を踏まえた提案になる。
 */

export interface MeshSuggesterInput {
  conceptSummary: string;
  meshRequirements: string[];
  /** seed 論文の MeSH 要約。seedCount=0 / concepts 空でも可 */
  seedMesh: SeedMeshSummary;
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
- カバレッジ（例 7/9）はその MeSH を必須にしたときの最大感度の目安。低カバレッジの記述子を
  AND 必須にすると seed を取りこぼすので、フリーワードと OR で束ねる前提で扱う。
- "*"（MajorTopic 付与あり）はブロック概念の中核である可能性が高い。
- qualifier（subheading）は採用根拠の参考に留め、原則 descriptor 単体（subheading なし）で提案する。
- seed はあくまで「捕捉すべき既知の正例」であり母集団ではない。seed の語彙に過剰適合して
  検索を狭めない。ブロック概念上もっともらしい記述子は seed に無くても提案してよい。
- チェックタグ（Humans / 年齢層 / 性別など）は概念ブロックに採用しない。
- 上位語と下位語のどちらを採用するかは、感度・特異度のバランスで判断する。
  既定は上位語 + Explode（PubMed 既定動作）。NoExp 指定が必要な場合だけ tagSyntax に [Mesh:NoExp] を入れる。
- 各候補に rationale（日本語、1-2 文）を必ず付ける。
- 出力は JSON のみ。
`.trim();

export const MESH_SUGGESTER_USER_PROMPT_TEMPLATE = `
ブロック概念: {{CONCEPT}}

ブロック側の MeSH 要件（方向性）:
{{REQUIREMENTS}}

seed 論文の MeSH（適格 seed 中の付与数。* = MajorTopic 付与あり）:
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
  const seedBlock = formatSeedMesh(input.seedMesh);

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

/** seed MeSH 要約をプロンプト用テキスト（カバレッジ + MajorTopic + qualifier）に整形する。 */
export function formatSeedMesh(summary: SeedMeshSummary): string {
  if (summary.seedCount === 0 || summary.concepts.length === 0) {
    return '(seed 論文の MeSH なし)';
  }
  const lines = summary.concepts.map((c) => {
    const star = c.majorCount > 0 ? '*' : '';
    const coverage = `(${c.count}/${summary.seedCount})`;
    const qualifiers =
      c.qualifiers.length === 0
        ? ''
        : ` [qualifiers: ${c.qualifiers
            .slice(0, 3)
            .map((q) => `${q.name} ×${q.count}`)
            .join(', ')}]`;
    return `- ${c.descriptor}${star} ${coverage}${qualifiers}`;
  });
  if (summary.checkTags.length > 0) {
    const tags = summary.checkTags
      .map((t) => `${t.descriptor} (${t.count}/${summary.seedCount})`)
      .join(', ');
    lines.push('', `チェックタグ（参考。ブロック概念には使わない）: ${tags}`);
  }
  return lines.join('\n');
}
