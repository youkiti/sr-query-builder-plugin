/**
 * Gemini API（`https://generativelanguage.googleapis.com/v1beta/models/*`）のモック。
 *
 * どの skill が呼ばれたかは system prompt の完全一致で判定する（各 skill が
 * `@/features/formula/skills` からエクスポートしている `*_SYSTEM_PROMPT` 定数と
 * そのまま突き合わせる）。判定できないプロンプトは黙って空を返さず、
 * 目立つエラーを投げる（video/REQUIREMENTS.md ブリーフ「判定に外れたときは
 * 目立つエラーを投げる」）。
 *
 * ブロック抽出（extract-protocol）・ドラフト生成（block-designer /
 * mesh-suggester / freeword-designer）・MeSH 提案・ブロック改善案
 * （interpret-result の suggested_terms）・境界事例選定（pick-boundary-cases）の
 * 5 用途に加え、edit 画面の improve-block と #/expand の expand-query-for-recall
 * にも対応する（scenario.ts の `BLOCK_DEFS` を単一の情報源として使う）。
 */

import {
  BLOCK_DESIGNER_SYSTEM_PROMPT,
  EXPAND_RECALL_SYSTEM_PROMPT,
  EXTRACT_PROTOCOL_SYSTEM_PROMPT,
  FREEWORD_DESIGNER_SYSTEM_PROMPT,
  IMPROVE_BLOCK_SYSTEM_PROMPT,
  INTERPRET_RESULT_SYSTEM_PROMPT,
  MESH_SUGGESTER_SYSTEM_PROMPT,
  PICK_BOUNDARY_SYSTEM_PROMPT,
} from '@/features/formula/skills';
import {
  BLOCK_DEFS,
  COMBINATION_EXPRESSION,
  ECMO_MESH_ADDITION,
  EXCLUSION_CRITERIA,
  INCLUSION_CRITERIA,
  RESEARCH_QUESTION,
  STUDY_DESIGN,
  detectBlockKey,
  getBlockDef,
  type ScenarioBlockKey,
} from './scenario';
import { jsonResponse } from './fakeResponse';

type SkillId =
  | 'extract_protocol'
  | 'draft_block'
  | 'suggest_mesh'
  | 'expand_freeword'
  | 'expand_recall'
  | 'pick_boundary'
  | 'improve_block'
  | 'interpret_result';

const SKILL_SYSTEM_PROMPTS: ReadonlyArray<readonly [string, SkillId]> = [
  [EXTRACT_PROTOCOL_SYSTEM_PROMPT, 'extract_protocol'],
  [BLOCK_DESIGNER_SYSTEM_PROMPT, 'draft_block'],
  [MESH_SUGGESTER_SYSTEM_PROMPT, 'suggest_mesh'],
  [FREEWORD_DESIGNER_SYSTEM_PROMPT, 'expand_freeword'],
  [EXPAND_RECALL_SYSTEM_PROMPT, 'expand_recall'],
  [PICK_BOUNDARY_SYSTEM_PROMPT, 'pick_boundary'],
  [IMPROVE_BLOCK_SYSTEM_PROMPT, 'improve_block'],
  [INTERPRET_RESULT_SYSTEM_PROMPT, 'interpret_result'],
];

function detectSkill(systemText: string): SkillId {
  const trimmed = systemText.trim();
  const found = SKILL_SYSTEM_PROMPTS.find(([prompt]) => prompt === trimmed);
  if (!found) {
    throw new Error(
      `[demo] llmFixtures: 未対応の system prompt です（skill を判定できません）。先頭 120 文字: ${trimmed.slice(
        0,
        120
      )}`
    );
  }
  return found[1];
}

/** `- label: X` / `- description: Y` を含むプロンプトから抽出する（RQ 行の誤検出を避けるため範囲を絞る）。 */
function extractLabelAndDescription(text: string): { label: string; description: string } {
  const match = /-\s*label:\s*([^\n]*)\n-\s*description:\s*([^\n]*)/.exec(text);
  if (!match) {
    throw new Error('[demo] llmFixtures: プロンプトから label/description を抽出できません');
  }
  return { label: match[1] ?? '', description: match[2] ?? '' };
}

/**
 * `ブロック概念:` から `seed 論文` の直前までを切り出す。
 *
 * mesh-suggester / freeword-designer のユーザープロンプトは、末尾に seed 論文の
 * MeSH 一覧や ti/ab コーパスを丸ごと含む（`MESH_SUGGESTER_USER_PROMPT_TEMPLATE` /
 * `FREEWORD_DESIGNER_USER_PROMPT_TEMPLATE`）。テキスト全体に `detectBlockKey` を
 * 掛けると seed 側に出てくる語を拾ってしまい、`BLOCK_DEFS` の先頭にある ards の
 * フィクスチャがどのブロックにも返る。デモの seed は ARDS/ECMO の論文なので、
 * ECMO ブロックにも RCT ブロックにも "ARDS" が引っかかった。
 *
 * 実害として、第 7 章の生成結果が #2 ECMO・#3 RCT フィルタとも ARDS の
 * フリーワードになる（＝ 3 ブロックがほぼ同じ式になる）不具合を出している。
 * 判定はブロック自身の記述（概念・要件・提案済み MeSH）だけに絞る。
 */
function extractBlockScope(text: string): string {
  const start = text.indexOf('ブロック概念:');
  if (start === -1) return text;
  const end = text.indexOf('seed 論文', start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function requireBlockKey(text: string, context: string): ScenarioBlockKey {
  const key = detectBlockKey(text);
  if (key === null) {
    throw new Error(
      `[demo] llmFixtures: ${context} — このブロックに対応するフィクスチャがありません: ${text.slice(0, 120)}`
    );
  }
  return key;
}

/* ------------------------------------------------------------------------ */
/* extract-protocol（ブロック抽出）                                          */
/* ------------------------------------------------------------------------ */

function buildExtractProtocolResponse(): unknown {
  return {
    framework_type: 'pico',
    research_question: RESEARCH_QUESTION,
    inclusion_criteria: INCLUSION_CRITERIA,
    exclusion_criteria: EXCLUSION_CRITERIA,
    study_design: STUDY_DESIGN,
    blocks: BLOCK_DEFS.map((d) => ({ block_label: d.blockLabel, description: d.blockDescription })),
    combination_expression: COMBINATION_EXPRESSION,
  };
}

/* ------------------------------------------------------------------------ */
/* block-designer / mesh-suggester / freeword-designer（ドラフト生成）        */
/* ------------------------------------------------------------------------ */

function buildBlockDesignerResponse(userText: string): unknown {
  const { label, description } = extractLabelAndDescription(userText);
  const key = requireBlockKey(`${label} ${description}`, 'block-designer');
  const def = getBlockDef(key);
  return {
    concept_summary: def.conceptSummary,
    mesh_requirements: [...def.meshRequirements],
    freeword_requirements: [...def.freewordRequirements],
    rationale: def.designerRationale,
  };
}

function buildMeshSuggesterResponse(userText: string): unknown {
  const key = requireBlockKey(extractBlockScope(userText), 'mesh-suggester');
  const def = getBlockDef(key);
  return {
    suggestions: def.meshV1.map((m) => ({
      descriptor: m.descriptor,
      tag_syntax: m.tagSyntax,
      rationale: m.rationale,
    })),
  };
}

function buildFreewordDesignerResponse(userText: string): unknown {
  const key = requireBlockKey(extractBlockScope(userText), 'freeword-designer');
  const def = getBlockDef(key);
  return { freewords: def.freewords.map((f) => ({ query: f.query, rationale: f.rationale })) };
}

/* ------------------------------------------------------------------------ */
/* expand-query-for-recall（#/expand の拡張語提案）                           */
/* ------------------------------------------------------------------------ */

function buildExpandRecallResponse(userText: string): unknown {
  const section = /現検索式のブロック:\n([\s\S]*?)\n\nスキーマ:/.exec(userText)?.[1] ?? userText;
  const lineRe = /^#(\S+)\s+(.*)$/gm;
  const blocks: Array<{ id: string; additions: Array<{ term: string; axis: string; rationale: string }> }> = [];
  for (const m of section.matchAll(lineRe)) {
    const id = m[1] ?? '';
    const expression = m[2] ?? '';
    const key = requireBlockKey(expression, `expand-query-for-recall（ブロック #${id}）`);
    const def = getBlockDef(key);
    blocks.push({
      id,
      additions: def.recallAdditions.map((a) => ({ term: a.term, axis: a.axis, rationale: a.rationale })),
    });
  }
  return { blocks };
}

/* ------------------------------------------------------------------------ */
/* pick-boundary-cases（境界事例選定）                                        */
/* ------------------------------------------------------------------------ */

function buildPickBoundaryResponse(userText: string): unknown {
  const section = /候補（\d+\s*件）:\n([\s\S]*?)\n\nスキーマ:/.exec(userText)?.[1] ?? userText;
  const candidateRe = /^-\s*PMID\s+(\S+)\s*\(([^)]*)\):\s*(.*)$/gm;
  const picks: Array<{ pmid: string; reason: string }> = [];
  for (const m of section.matchAll(candidateRe)) {
    const pmid = m[1] ?? '';
    picks.push({
      pmid,
      reason:
        '研究デザイン（RCT）は検索式と一致しますが、対象集団や介入の呼称が式の語彙と異なる表現になっており、境界事例として提示します。',
    });
  }
  return { picks };
}

/* ------------------------------------------------------------------------ */
/* improve-block（/edit の AI 改善。既定フローでは未使用だが安全側で対応する）  */
/* ------------------------------------------------------------------------ */

function buildImproveBlockResponse(userText: string): unknown {
  const { label, description } = extractLabelAndDescription(userText);
  const currentMatch = /現在の expression:\n([\s\S]*?)\n\nシード論文/.exec(userText);
  const current = (currentMatch?.[1] ?? '').trim();
  const key = detectBlockKey(`${label} ${description} ${current}`);
  if (key === 'ecmo' && !current.toLowerCase().includes('[mesh]')) {
    return {
      proposed_expression: `(${current}) OR ${ECMO_MESH_ADDITION.tagSyntax}`,
      rationale:
        '本文表記が "extracorporeal life support" 等にゆれても取りこぼさないよう、MeSH タグを追加しました。',
    };
  }
  return {
    proposed_expression: current,
    rationale: '現在の式で十分と判断し、変更しませんでした。',
  };
}

/* ------------------------------------------------------------------------ */
/* interpret-result（漏れ PMID の原因分析・改善候補語の提案）                  */
/* ------------------------------------------------------------------------ */

interface FormulaLine {
  id: string;
  expression: string;
}

interface MissedArticle {
  pmid: string;
  meshHeadings: string[];
}

function parseFormulaLines(userText: string): FormulaLine[] {
  const section = /検索式の行:\n([\s\S]*?)\n\n漏れ PMID/.exec(userText)?.[1] ?? '';
  const lines: FormulaLine[] = [];
  for (const m of section.matchAll(/^-\s*#(\S+):\s*(.*)$/gm)) {
    lines.push({ id: m[1] ?? '', expression: m[2] ?? '' });
  }
  return lines;
}

function parseMissedArticles(userText: string): MissedArticle[] {
  const section = /漏れ PMID（\d+\s*件）:\n([\s\S]*?)\n\nスキーマ:/.exec(userText)?.[1] ?? '';
  const articles: MissedArticle[] = [];
  const articleRe = /PMID (\S+)\n\s*title:[^\n]*\n\s*abstract:[^\n]*\n\s*MeSH:\s*([^\n]*)/g;
  for (const m of section.matchAll(articleRe)) {
    const pmid = m[1] ?? '';
    const meshRaw = (m[2] ?? '').trim();
    const meshHeadings = meshRaw === '' || meshRaw === '(none)' ? [] : meshRaw.split(',').map((s) => s.trim());
    articles.push({ pmid, meshHeadings });
  }
  return articles;
}

/** `"<heading>"[Mesh]`（NoExp 等の派生含む）が既にどこかの行に入っているか。 */
function hasMeshTag(lines: readonly FormulaLine[], heading: string): boolean {
  const needle = `"${heading.toLowerCase()}"[mesh`;
  return lines.some((line) => line.expression.toLowerCase().includes(needle));
}

/** heading の実質的な単語（5 文字以上）が、ある行の tiab 語彙と重なるか。 */
function findRelatedLine(lines: readonly FormulaLine[], heading: string): FormulaLine | null {
  const tokens = heading
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 5);
  return lines.find((line) => tokens.some((t) => line.expression.toLowerCase().includes(t))) ?? null;
}

function buildInterpretResultResponse(userText: string): unknown {
  const lines = parseFormulaLines(userText);
  const articles = parseMissedArticles(userText);
  const analyses = articles.map((article) => {
    for (const heading of article.meshHeadings) {
      if (hasMeshTag(lines, heading)) {
        continue;
      }
      const related = findRelatedLine(lines, heading);
      if (related) {
        return {
          pmid: article.pmid,
          cause: `この論文の本文表現はブロック #${related.id} の tiab 語彙と一致しませんが、MeSH には "${heading}" が付与されています。`,
          suggested_terms: [`"${heading}"[Mesh]`],
          related_block: related.id,
        };
      }
    }
    return {
      pmid: article.pmid,
      cause: '式のどの行にも対応しそうな MeSH 記述子が見当たりませんでした。',
      suggested_terms: [],
      related_block: null,
    };
  });
  return { analyses };
}

/* ------------------------------------------------------------------------ */
/* Gemini API 全体のディスパッチ                                             */
/* ------------------------------------------------------------------------ */

interface GeminiRequestBody {
  contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
  systemInstruction?: { parts?: Array<{ text?: string }> };
  generationConfig?: { maxOutputTokens?: number };
}

function buildResponseObject(skill: SkillId, userText: string): unknown {
  switch (skill) {
    case 'extract_protocol':
      return buildExtractProtocolResponse();
    case 'draft_block':
      return buildBlockDesignerResponse(userText);
    case 'suggest_mesh':
      return buildMeshSuggesterResponse(userText);
    case 'expand_freeword':
      return buildFreewordDesignerResponse(userText);
    case 'expand_recall':
      return buildExpandRecallResponse(userText);
    case 'pick_boundary':
      return buildPickBoundaryResponse(userText);
    case 'improve_block':
      return buildImproveBlockResponse(userText);
    case 'interpret_result':
      return buildInterpretResultResponse(userText);
  }
}

/** テキスト長からトークン数を粗く見積もる（英数字 4 文字 ≒ 1 トークンの経験則）。 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * `geminiTierDetector.probeOnce()` のプラン判定リクエストかどうかを判定する。
 *
 * プローブは `systemInstruction` を持たず `generationConfig.maxOutputTokens: 1` で
 * 有料モデルへ最小プロンプトを投げる（src/lib/llm/geminiTierDetector.ts）。
 * スキル用のプロンプトは必ず `systemInstruction` を伴うので、その有無で切り分ける。
 */
function isTierProbe(body: GeminiRequestBody): boolean {
  const hasSystemInstruction = (body.systemInstruction?.parts ?? []).some(
    (p) => (p.text ?? '').trim() !== ''
  );
  return !hasSystemInstruction && body.generationConfig?.maxOutputTokens === 1;
}

/**
 * `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` を処理する。
 * `init.body` は `GeminiProvider.buildRequestBody` が組み立てた JSON 文字列。
 */
export function handleGeminiGenerateContent(init: RequestInit): Response {
  const rawBody = typeof init.body === 'string' ? init.body : '';
  let body: GeminiRequestBody;
  try {
    body = JSON.parse(rawBody) as GeminiRequestBody;
  } catch {
    throw new Error('[demo] llmFixtures: Gemini リクエストボディが JSON として解釈できません');
  }
  // プラン判定プローブは skill を持たないので、スキル判定より先に返す。
  // ここで弾かないと detectSkill('') が throw し、probeOnce の catch に握り潰されて
  // 'unknown' が返り、第 2 章の tier バッジが「確認中...」→ 空欄で終わってしまう。
  // 200 OK は 'paid'（= 有料プラン）と解釈される。'free' を返すとモデル選択が
  // gemini-2.0-flash へ強制的に切り替わって永続化され、他章の gemini-3.5-flash と
  // 食い違うため、必ず 200 側に倒すこと（src/options/bootstrap.ts の tier 判定）。
  if (isTierProbe(body)) {
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
  }

  const systemText = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n');
  const userText = (body.contents ?? [])
    .map((c) => (c.parts ?? []).map((p) => p.text ?? '').join(''))
    .join('\n');
  const skill = detectSkill(systemText);
  const responseObj = buildResponseObject(skill, userText);
  const responseText = JSON.stringify(responseObj);
  const envelope = {
    candidates: [
      { content: { parts: [{ text: responseText }], role: 'model' }, finishReason: 'STOP' },
    ],
    usageMetadata: {
      promptTokenCount: estimateTokens(systemText + userText),
      candidatesTokenCount: estimateTokens(responseText),
      totalTokenCount: estimateTokens(systemText + userText) + estimateTokens(responseText),
    },
  };
  return jsonResponse(envelope);
}
