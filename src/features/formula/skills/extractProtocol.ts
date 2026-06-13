import type { LLMProvider } from '@/lib/llm';
import { parseSkillJson, SkillResponseError } from './parseSkillJson';
import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema';

/**
 * `extract-protocol` skill — プロトコル本文から RQ・組入除外・1〜5 個の
 * 検索式ブロックドラフトを抽出する。requirements.md §4.2 で参照。
 *
 * 出力された draft は UI（#/blocks）でユーザーが承認 / 編集してから保存する。
 */

export interface ExtractedProtocolDraft {
  frameworkType: 'pico' | 'peco' | 'pcc' | 'spider' | 'custom';
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  studyDesign: string;
  blocks: Array<{ blockLabel: string; description: string }>;
  combinationExpression: string;
}

const SKILL_NAME = 'extract-protocol';

export const EXTRACT_PROTOCOL_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書（リサーチ・ライブラリアン）です。
研究プロトコルの本文から、PubMed 検索式作成に必要な構造化メタ情報を抽出してください。

要件:
- フレームワーク（pico / peco / pcc / spider / custom）を本文から推定する。
  介入研究なら pico、観察研究なら peco、スコーピングレビューなら pcc、質的研究なら spider を選ぶ。
- ブロック数は 1〜5 の範囲で、レビューの種類に応じて最小限にする。
  介入研究 → P/I の 2 ブロック、観察研究 → P/E の 2 ブロック、スコーピング → P/C/Context の 3 ブロックなど。
- 各ブロックには short label（英語、例: "Population", "Intervention"）と
  日本語の自然文 description（このブロックで捉えたい概念を 1-3 文で）を必ず付ける。
- combination_expression は "#1 AND #2 AND #3" 形式の AND 結合を既定とする。
  特別な意図が無い限り全 AND にする。
- 出力は **JSON のみ**。Markdown 装飾やコメントは付けない。
`.trim();

export const EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE = `
以下のプロトコル本文を読み、JSON で出力してください。

スキーマ:
{
  "framework_type": "pico" | "peco" | "pcc" | "spider" | "custom",
  "research_question": "<RQ を 1 文>",
  "inclusion_criteria": "<改行区切りの組入基準>",
  "exclusion_criteria": "<改行区切りの除外基準>",
  "study_design": "<例: RCT / observational / any>",
  "blocks": [
    { "block_label": "<英語ラベル>", "description": "<日本語の概念説明>" }
  ],
  "combination_expression": "#1 AND #2"
}

プロトコル本文:
"""
{{PROTOCOL}}
"""
`.trim();

interface RawExtracted {
  framework_type?: string;
  research_question?: string;
  inclusion_criteria?: string;
  exclusion_criteria?: string;
  study_design?: string;
  blocks?: Array<{ block_label?: string; description?: string }>;
  combination_expression?: string;
}

const EXTRACT_PROTOCOL_SCHEMA = objectSchema({
  framework_type: enumSchema(['pico', 'peco', 'pcc', 'spider', 'custom']),
  research_question: stringSchema('RQ を 1 文'),
  inclusion_criteria: stringSchema('改行区切りの組入基準'),
  exclusion_criteria: stringSchema('改行区切りの除外基準'),
  study_design: stringSchema('例: RCT / observational / any'),
  blocks: arraySchema(
    objectSchema({
      block_label: stringSchema('英語ラベル'),
      description: stringSchema('日本語の概念説明'),
    })
  ),
  combination_expression: stringSchema('例: #1 AND #2'),
});

/**
 * extract-protocol skill を実行する。
 *
 * - protocolText が空文字なら LLM を呼ばず、空ドラフトを返す（手入力ゼロから編集する用途）
 * - 出力は最低限の検証（framework_type が正しい列挙か、ブロック数 1〜5 か）のみ行う
 */
export async function extractProtocol(
  protocolText: string,
  provider: LLMProvider
): Promise<ExtractedProtocolDraft> {
  if (protocolText.trim() === '') {
    return emptyDraft();
  }
  const userPrompt = EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE.replace('{{PROTOCOL}}', protocolText);
  const response = await provider.chat(
    [
      { role: 'system', content: EXTRACT_PROTOCOL_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: EXTRACT_PROTOCOL_SCHEMA, temperature: 0.2 }
  );
  const raw = parseSkillJson<RawExtracted>(response.text, SKILL_NAME);
  return validateAndNormalize(raw, response.text);
}

function emptyDraft(): ExtractedProtocolDraft {
  return {
    frameworkType: 'custom',
    researchQuestion: '',
    inclusionCriteria: '',
    exclusionCriteria: '',
    studyDesign: '',
    blocks: [{ blockLabel: '', description: '' }],
    combinationExpression: '#1',
  };
}

const FRAMEWORKS = new Set(['pico', 'peco', 'pcc', 'spider', 'custom']);

function validateAndNormalize(raw: RawExtracted, rawText: string): ExtractedProtocolDraft {
  const framework = (raw.framework_type ?? 'custom').toLowerCase();
  if (!FRAMEWORKS.has(framework)) {
    throw new SkillResponseError(
      `framework_type が想定外の値です: ${raw.framework_type}`,
      SKILL_NAME,
      rawText
    );
  }
  const blocks = (raw.blocks ?? []).map((b) => ({
    blockLabel: b.block_label ?? '',
    description: b.description ?? '',
  }));
  if (blocks.length < 1 || blocks.length > 5) {
    throw new SkillResponseError(
      `blocks は 1〜5 個でなければなりません: ${blocks.length} 個`,
      SKILL_NAME,
      rawText
    );
  }
  return {
    frameworkType: framework as ExtractedProtocolDraft['frameworkType'],
    researchQuestion: raw.research_question ?? '',
    inclusionCriteria: raw.inclusion_criteria ?? '',
    exclusionCriteria: raw.exclusion_criteria ?? '',
    studyDesign: raw.study_design ?? '',
    blocks,
    combinationExpression: raw.combination_expression ?? defaultCombination(blocks.length),
  };
}

function defaultCombination(count: number): string {
  return Array.from({ length: count }, (_, i) => `#${i + 1}`).join(' AND ');
}
