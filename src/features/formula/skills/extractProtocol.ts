import type { JsonSchema, LLMProvider } from '@/lib/llm';
import { parseSkillJson, SkillResponseError } from './parseSkillJson';
import { renderPromptTemplate } from './renderPromptTemplate';
import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema';
import { PREDEFINED_FILTER_DEFS } from './filterDesigner';

/**
 * `extract-protocol` skill — プロトコル本文から RQ・組入除外・1〜5 個の
 * 検索式ブロックドラフトを抽出する。requirements.md §4.2 で参照。
 *
 * ブロック数はフレームワークの要素数（P/I の 2 個など）に固定しない。1 ブロック = 検索式で
 * AND 結合する 1 概念なので、「小児の肺炎」のように P が独立概念の AND で構成されるときは
 * 概念ごとに別ブロックへ分けるよう prompt で指示している（issue #94）。
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
  suggestedFilterIds?: string[];
}

const SKILL_NAME = 'extract-protocol';

export const EXTRACT_PROTOCOL_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書（リサーチ・ライブラリアン）です。
研究プロトコルの本文から、PubMed 検索式作成に必要な構造化メタ情報を抽出してください。

要件:
- フレームワーク（pico / peco / pcc / spider / custom）を本文から推定する。
  介入研究なら pico、観察研究なら peco、スコーピングレビューなら pcc、質的研究なら spider を選ぶ。
- ブロック数は 1〜5 の範囲。**フレームワークの要素数とブロック数は一致しなくてよい**。
  ブロックは「検索式で AND 結合する単位（1 ブロック = 1 概念）」であり、
  P や I が複数の独立した概念の AND 条件で構成されるなら、概念ごとに別ブロックへ分ける。
  例: 「小児の肺炎」という P → "Children" と "Pneumonia" の 2 ブロック（結合式は "#1 AND #2"）。
  介入研究で P が 2 概念なら P1 / P2 / I の 3 ブロック、観察研究なら P / E、
  スコーピングなら P / Concept / Context のように、概念の数で決める。
- 逆に、同義語・下位概念・表記ゆれの列挙（OR で束ねるもの）は 1 ブロックにまとめる。
  Comparison や Outcome は、組入基準として必須で検索語になりうる場合だけブロックにする。
- 各ブロックには short label（英語、例: "Population", "Intervention", 概念で分けたなら "Children", "Pneumonia"）と
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
  suggested_filter_ids?: string[];
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

export const EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT = `
あなたはシステマティックレビューの司書（リサーチ・ライブラリアン）です。
研究プロトコルの本文から、PubMed 検索式作成に必要な構造化メタ情報を抽出してください。

要件:
- フレームワーク（pico / peco / pcc / spider / custom）を本文から推定する。
  介入研究なら pico、観察研究なら peco、スコーピングレビューなら pcc、質的研究なら spider を選ぶ。
- ブロックは「検索式で AND 結合する単位（1 ブロック = 1 概念）」です。**AND を 1 つ足すたびに、その概念の語が題・抄録・MeSH のどこにも無い適格な研究は、すべて落ちます。** 必須にする概念は、できるだけ少なくします。
- 概念ブロックは原則 2 個までにします。選ぶのは、このレビューを他のレビューから区別する中心の概念です（多くは「対象とする状態・集団」と「介入・曝露・検査」）。中心の概念が 1 つしか無ければ 1 個でかまいません。3 個目を足すのは、それが無いと主題がまったく別物になり、かつ適格な研究なら題か抄録に必ず書かれると言える場合だけです。
- 次のものは、適格基準に書かれていても概念ブロックにしません（題や抄録に書かれないことが多く、必須にすると適格な研究を落とします）。
  - アウトカム・評価項目
  - 比較対照
  - 実施場所や設定（国や地域の区分、医療機関の種類、状況）
  - 年齢層・性別などの属性（それ自体がレビューの中心の概念である場合を除く）
  - 研究デザインや研究の種類（下の検索フィルターで扱う）
- 同義語・下位概念・表記ゆれの列挙（OR で束ねるもの）は 1 つのブロックにまとめます。
- 各ブロックには short label（英語、例: "Population", "Intervention"）と
  日本語の自然文 description（このブロックで捉えたい概念を 1-3 文で）を必ず付ける。
- combination_expression は、概念ブロックを AND でつないだ式にする（例: "#1 AND #2"）。検索フィルターは含めない。
- suggested_filter_ids には、付けるべき検索フィルターの ID を入れる。選べるのは次の一覧だけ。どれも当てはまらなければ空の配列にする。
${PREDEFINED_FILTER_DEFS.map((filter) => `  - ${filter.id}: ${filter.description}`).join('\n')}
  - RCTfilter は、プロトコルの研究デザインが無作為化比較試験だけを対象にしているときに限り選ぶ。無作為化比較試験以外（観察研究、準実験など）も対象に含むときは選ばない。
  - ほかのフィルターも、プロトコルがその種類の研究だけを対象にしているときに限り選ぶ。
  - プロトコルに書かれていない言語・動物種・出版形式・年代の制限は足さない。
- 出力は **JSON のみ**。Markdown 装飾やコメントは付けない。
`.trim();

const FILTER_IDS = PREDEFINED_FILTER_DEFS.map((filter) => filter.id);
const EXTRACT_PROTOCOL_AGENT_USER_PROMPT_TEMPLATE = EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE.replace(
  '"combination_expression": "#1 AND #2"',
  `"combination_expression": "#1 AND #2",\n  "suggested_filter_ids": [${FILTER_IDS.map((id) => `"${id}"`).join(' | ')}]`
);
const EXTRACT_PROTOCOL_AGENT_SCHEMA = objectSchema({
  ...(EXTRACT_PROTOCOL_SCHEMA.properties as Record<string, JsonSchema>),
  suggested_filter_ids: arraySchema(enumSchema(FILTER_IDS)),
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
  // renderPromptTemplate を使う理由は improveBlock.ts と同じ（issue #92 C-1。
  // ユーザーが貼り付けたプロトコル本文に $ 系の特殊パターンが含まれてもテンプレートが壊れない）。
  const agent = provider.providerId === 'anthropic';
  const userPrompt = renderPromptTemplate(agent ? EXTRACT_PROTOCOL_AGENT_USER_PROMPT_TEMPLATE : EXTRACT_PROTOCOL_USER_PROMPT_TEMPLATE, {
    PROTOCOL: protocolText,
  });
  const response = await provider.chat(
    [
      { role: 'system', content: agent ? EXTRACT_PROTOCOL_AGENT_SYSTEM_PROMPT : EXTRACT_PROTOCOL_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { responseFormat: 'json', responseSchema: agent ? EXTRACT_PROTOCOL_AGENT_SCHEMA : EXTRACT_PROTOCOL_SCHEMA, temperature: 0.2 }
  );
  const raw = parseSkillJson<RawExtracted>(response.text, SKILL_NAME);
  const draft = validateAndNormalize(raw, response.text);
  if (agent) {
    draft.suggestedFilterIds = [...new Set((raw.suggested_filter_ids ?? []).filter((id) => FILTER_IDS.includes(id)))];
  }
  return draft;
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
