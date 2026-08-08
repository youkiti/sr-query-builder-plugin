/**
 * デモの筋書き（video/REQUIREMENTS.md §6-3）を 1 か所にまとめた正典モジュール。
 *
 * RQ:「成人 ARDS に対する ECMO は生存率を改善するか」。ブロック #1=ARDS / #2=ECMO /
 * #3=RCT フィルタの 3 ブロック構成。
 *
 * このファイルが持つ「ブロックごとの MeSH・フリーワード提案」は、`llmFixtures.ts`
 * （生成時に返す固定応答）と本ファイル自身（章ごとの Sheets シードで使う検索式 v1/v2 の
 * 組み立て）の両方から参照される唯一の情報源。組み立てには本番コードの
 * `assembleFormulaMd` / `buildBlockExpression`（`@/features/formula`）をそのまま使い、
 * 実際に「生成して検証する」を押したときと同じロジックで markdown を導出することで、
 * ライブ生成時とシード時の検索式が構造的にずれないようにしている。
 */

import {
  assembleFormulaMd,
  buildBlockExpression,
  type AssembledFormula,
  type BlockOutputs,
} from '@/features/formula';
import {
  designDefaultFilters,
  type FreewordSuggestion,
  type MeshSuggestion,
} from '@/features/formula/skills';
import {
  aggregateMeshFrequency,
  buildMeshHierarchy,
  expandFormula,
  toMermaidFlowchart,
  type MeshForSeed,
} from '@/features/validation';
import { parsePubmedFormulaMd } from '@/lib/search-formula-md';
import type { ValidationSummary } from '@/app/services';
import { evaluateQuery } from './queryEngine';
import {
  DEMO_CORPUS,
  DEMO_CORPUS_BY_PMID,
  DEMO_MESH_TREE,
  RECOMMENDED_BOUNDARY_INCLUDE_PMID,
  SEED_PMIDS,
  type DemoPaper,
} from './corpus';

export type ScenarioBlockKey = 'ards' | 'ecmo' | 'rct';

/** 拡張語 1 件（`expand-query-for-recall` skill の出力形状）。 */
export interface RecallAdditionFixture {
  term: string;
  axis: 'mesh' | 'freeword';
  rationale: string;
}

export interface ScenarioBlockDef {
  key: ScenarioBlockKey;
  /** #/blocks で承認するブロックのラベル・説明（extract_protocol フィクスチャの出力と一致させる） */
  blockLabel: string;
  blockDescription: string;
  /** このブロックだと判定するためのキーワード（小文字）。3 ブロックで互いに排他的にしてある */
  keywords: readonly string[];
  /** block-designer フィクスチャの出力 */
  conceptSummary: string;
  meshRequirements: readonly string[];
  freewordRequirements: readonly string[];
  designerRationale: string;
  /** mesh-suggester / freeword-designer フィクスチャの出力（v1 = 初回生成時） */
  meshV1: readonly MeshSuggestion[];
  freewords: readonly FreewordSuggestion[];
  /** expand-query-for-recall フィクスチャの出力（研究デザインフィルタは空配列） */
  recallAdditions: readonly RecallAdditionFixture[];
}

/** ブロック #2（ECMO）に v2 で追加する MeSH 提案。interpret-result の提案語とも一致させる。 */
export const ECMO_MESH_ADDITION: MeshSuggestion = {
  descriptor: 'Extracorporeal Membrane Oxygenation',
  tagSyntax: '"Extracorporeal Membrane Oxygenation"[Mesh]',
  rationale:
    '本文表記が "extracorporeal life support" 等ゆれても、MeSH には一貫して付与されているため取りこぼしを防げる',
};

export const BLOCK_DEFS: readonly ScenarioBlockDef[] = [
  {
    key: 'ards',
    blockLabel: 'ARDS',
    blockDescription: '成人 ARDS（急性呼吸窮迫症候群）と診断された患者集団',
    keywords: ['ards', 'acute respiratory distress'],
    conceptSummary: 'Adult patients diagnosed with acute respiratory distress syndrome (ARDS)',
    meshRequirements: ['ARDS を中心とした MeSH 記述子'],
    freewordRequirements: ['ARDS の略語表記', '正式名称の表記ゆれ'],
    designerRationale: 'MeSH 記述子と tiab の略語・正式名称を OR で束ねて感度を確保する',
    meshV1: [
      {
        descriptor: 'Respiratory Distress Syndrome',
        tagSyntax: '"Respiratory Distress Syndrome"[Mesh]',
        rationale: 'ARDS の中核となる MeSH 記述子',
      },
    ],
    freewords: [
      { query: '"ARDS"[tiab]', rationale: '略語表記を回収する' },
      { query: '"acute respiratory distress syndrome"[tiab]', rationale: '正式名称の表記ゆれを回収する' },
    ],
    recallAdditions: [
      {
        term: '"Respiratory Insufficiency"[Mesh]',
        axis: 'mesh',
        rationale: 'ARDS を含む、より広い呼吸不全の上位概念',
      },
      {
        term: '"respiratory failure"[tiab]',
        axis: 'freeword',
        rationale: 'ARDS を "respiratory failure" と表記する論文を回収する',
      },
    ],
  },
  {
    key: 'ecmo',
    blockLabel: 'ECMO',
    blockDescription: '体外式膜型人工肺（ECMO）による治療介入',
    keywords: ['ecmo', 'extracorporeal'],
    conceptSummary: 'Extracorporeal membrane oxygenation (ECMO) as a treatment intervention',
    // 意図的に MeSH 要件を薄くし、mesh-suggester フィクスチャが v1 で提案 0 件になるようにしている
    // （§6-3: 08 章で MeSH タグの追加を後から提案する筋書きのため）。
    meshRequirements: [],
    freewordRequirements: ['ECMO の略語表記', '正式名称の表記ゆれ'],
    designerRationale: '現時点では tiab のみで構成し、MeSH 記述子は検証結果を見てから検討する',
    meshV1: [],
    freewords: [
      { query: '"ECMO"[tiab]', rationale: '略語表記を回収する' },
      { query: '"extracorporeal membrane oxygenation"[tiab]', rationale: '正式名称の表記ゆれを回収する' },
    ],
    recallAdditions: [
      {
        term: ECMO_MESH_ADDITION.tagSyntax,
        axis: 'mesh',
        rationale: 'tiab に現れない表記でも MeSH 索引で拾えるようにする',
      },
      {
        term: '"extracorporeal life support"[tiab]',
        axis: 'freeword',
        rationale: 'ECMO を "extracorporeal life support" と表記する論文を回収する',
      },
    ],
  },
  {
    key: 'rct',
    blockLabel: 'RCT フィルタ',
    blockDescription: 'ランダム化比較試験（RCT）に限定するデザインフィルタ',
    keywords: ['rct', 'randomiz', 'randomis'],
    conceptSummary: 'Randomized controlled trial (RCT) study design restriction',
    meshRequirements: [],
    freewordRequirements: ['randomized/randomised の表記ゆれ', 'RCT/trial の略記'],
    designerRationale: '研究デザインフィルタなので tiab の表記ゆれのみで構成する',
    meshV1: [],
    freewords: [
      { query: '"randomized"[tiab]', rationale: '米国表記を回収する' },
      { query: '"randomised"[tiab]', rationale: '英国表記を回収する' },
      { query: '"RCT"[tiab]', rationale: '略記を回収する' },
      { query: '"trial"[tiab]', rationale: '一般的な trial 表記を回収する' },
    ],
    // 研究デザイン/方法論フィルタのブロックは expand-query-for-recall skill の
    // ルールにより広げない（additions は常に空配列）。
    recallAdditions: [],
  },
];

const BLOCK_DEF_BY_KEY: ReadonlyMap<ScenarioBlockKey, ScenarioBlockDef> = new Map(
  BLOCK_DEFS.map((d) => [d.key, d])
);

export function getBlockDef(key: ScenarioBlockKey): ScenarioBlockDef {
  const def = BLOCK_DEF_BY_KEY.get(key);
  /* istanbul ignore if -- key は ScenarioBlockKey 型で閉じているので必ず見つかる */
  if (!def) {
    throw new Error(`未知のシナリオブロック key です: ${key}`);
  }
  return def;
}

/**
 * 任意のテキストから、どのシナリオブロックについての言及かを判定する。
 * 3 ブロックの keywords は互いに排他的（ARDS/ECMO/RCT のいずれの語彙も重複しない）。
 * 見つからなければ null（呼び出し側は「デモ未対応」として目立つエラーを投げること）。
 */
export function detectBlockKey(text: string): ScenarioBlockKey | null {
  const lower = text.toLowerCase();
  for (const def of BLOCK_DEFS) {
    if (def.keywords.some((k) => lower.includes(k))) {
      return def.key;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* プロトコル（#/protocol, #/blocks）                                        */
/* ------------------------------------------------------------------------ */

export const RESEARCH_QUESTION = '成人 ARDS に対する ECMO は生存率を改善するか';
export const INCLUSION_CRITERIA = '成人, ARDS 診断, ECMO 導入, ランダム化比較試験';
export const EXCLUSION_CRITERIA = '小児, 症例報告, 観察研究';
// RCT_DESIGN_PATTERN（filterDesigner: /\b(rct|randomized|randomised)\b/i）に
// 一致させない表現をあえて選ぶ。自動 Cochrane RCT フィルタを発火させず、
// ブロック #3（RCT フィルタ）だけでデザイン制限を表現するため
// （§6-3 の 3 ブロック構成と対応させる。"RCT" の文字列を含めると誤発火するので注意）。
export const STUDY_DESIGN = '介入研究（ランダム割付あり）';
export const COMBINATION_EXPRESSION = '#1 AND #2 AND #3';

export const PROTOCOL_INLINE_TEXT = `研究プロトコル（デモ・架空データ）

RQ: ${RESEARCH_QUESTION}

PICO:
- Population: 成人 ARDS（急性呼吸窮迫症候群）患者
- Intervention: ECMO（体外式膜型人工肺）
- Comparison: 従来の人工呼吸管理
- Outcome: 生存率

組入基準: ${INCLUSION_CRITERIA}
除外基準: ${EXCLUSION_CRITERIA}
研究デザイン: ${STUDY_DESIGN}
`;

/* ------------------------------------------------------------------------ */
/* 検索式 v1 / v2 の組み立て（本番の assembleFormulaMd をそのまま使う）        */
/* ------------------------------------------------------------------------ */

function toBlockOutputs(meshOverride?: Partial<Record<ScenarioBlockKey, readonly MeshSuggestion[]>>): BlockOutputs[] {
  return BLOCK_DEFS.map((def) => ({
    skeleton: {
      conceptSummary: def.conceptSummary,
      meshRequirements: [...def.meshRequirements],
      freewordRequirements: [...def.freewordRequirements],
      rationale: def.designerRationale,
    },
    mesh: [...(meshOverride?.[def.key] ?? def.meshV1)],
    freewords: [...def.freewords],
  }));
}

// RCT_DESIGN_PATTERN に一致しない studyDesign なので、既定フィルタは常に空。
const FILTER_RESULT = designDefaultFilters({ studyDesign: STUDY_DESIGN });

/** v1: 07 章でライブ生成した直後の検索式（ブロック #2 に MeSH タグなし）。 */
export function buildFormulaV1(): AssembledFormula {
  return assembleFormulaMd({
    baseCombinationExpression: COMBINATION_EXPRESSION,
    blocks: toBlockOutputs(),
    filterResult: FILTER_RESULT,
  });
}

/** v2: 10 章でブロック #2 に MeSH タグを追加したあとの検索式。 */
export function buildFormulaV2(): AssembledFormula {
  return assembleFormulaMd({
    baseCombinationExpression: COMBINATION_EXPRESSION,
    blocks: toBlockOutputs({ ecmo: [ECMO_MESH_ADDITION] }),
    filterResult: FILTER_RESULT,
  });
}

/** ブロック単体（#1〜#3）の式だけを取り出す（line_hits のライブ表示・テスト用）。 */
export function buildBlockExpressions(
  meshOverride?: Partial<Record<ScenarioBlockKey, readonly MeshSuggestion[]>>
): Record<ScenarioBlockKey, string> {
  const outputs = toBlockOutputs(meshOverride);
  const record = {} as Record<ScenarioBlockKey, string>;
  BLOCK_DEFS.forEach((def, i) => {
    record[def.key] = buildBlockExpression(outputs[i] as BlockOutputs);
  });
  return record;
}

/* ------------------------------------------------------------------------ */
/* コーパスから導出する数値（jest テストと seeds.ts の両方から参照する）        */
/* ------------------------------------------------------------------------ */

export interface ScenarioFacts {
  /** ブロック単体（#1〜#3）のヒット数 */
  blockHits: Record<ScenarioBlockKey, number>;
  /** v1 最終式のヒット数（= マッチした論文の PMID 一覧） */
  finalV1Pmids: string[];
  /** v1 最終式でのシード捕捉状況 */
  capturedV1: string[];
  missedV1: string[];
  /** margin（拡張式 NOT 現式）にマッチする論文の PMID（重複除去前） */
  marginPmids: string[];
  /** 既存シードを除いた境界事例候補（09 章で提示される 3 本） */
  boundaryCandidatePmids: string[];
  /** v2 最終式のヒット数（= マッチした論文の PMID 一覧） */
  finalV2Pmids: string[];
}

function expandedBlockExpression(def: ScenarioBlockDef, expr: string): string {
  if (def.recallAdditions.length === 0) {
    return expr;
  }
  const terms = def.recallAdditions.map((a) => a.term);
  return `(${expr}) OR ${terms.join(' OR ')}`;
}

/**
 * §6-2 の不変条件をコードで確認できるようにする関数。
 * esearch のヒット数・捕捉率はすべてここでコーパスを実際に評価して求める
 * （ハードコードした数字は持たない）。
 */
export function computeScenarioFacts(corpus: readonly DemoPaper[] = DEMO_CORPUS): ScenarioFacts {
  const v1 = buildBlockExpressions();
  const blockHits = {} as Record<ScenarioBlockKey, number>;
  for (const def of BLOCK_DEFS) {
    blockHits[def.key] = evaluateQuery(v1[def.key], corpus).length;
  }

  const finalV1Query = BLOCK_DEFS.map((d) => `(${v1[d.key]})`).join(' AND ');
  const finalV1Pmids = evaluateQuery(finalV1Query, corpus).map((p) => p.pmid);
  const seedSet = new Set<string>(SEED_PMIDS);
  const finalV1Set = new Set(finalV1Pmids);
  const capturedV1 = Array.from(seedSet).filter((p) => finalV1Set.has(p));
  const missedV1 = Array.from(seedSet).filter((p) => !finalV1Set.has(p));

  const broadenedQuery = BLOCK_DEFS.map((d) => `(${expandedBlockExpression(d, v1[d.key])})`).join(
    ' AND '
  );
  const broadenedPmids = new Set(evaluateQuery(broadenedQuery, corpus).map((p) => p.pmid));
  const marginPmids = Array.from(broadenedPmids).filter((p) => !finalV1Set.has(p));
  const boundaryCandidatePmids = marginPmids.filter((p) => !seedSet.has(p));

  const v2 = buildBlockExpressions({ ecmo: [ECMO_MESH_ADDITION] });
  const finalV2Query = BLOCK_DEFS.map((d) => `(${v2[d.key]})`).join(' AND ');
  const finalV2Pmids = evaluateQuery(finalV2Query, corpus).map((p) => p.pmid);

  return {
    blockHits,
    finalV1Pmids,
    capturedV1,
    missedV1,
    marginPmids,
    boundaryCandidatePmids,
    finalV2Pmids,
  };
}

export { RECOMMENDED_BOUNDARY_INCLUDE_PMID, SEED_PMIDS };

/* ------------------------------------------------------------------------ */
/* ValidationSummary の組み立て（seeds.ts が章ごとの検証結果を事前投入するのに使う） */
/* ------------------------------------------------------------------------ */

/**
 * 指定した formula_md と有効シード集合から、`runValidation`（本番の検証サービス）が
 * 生成するのと同じ形の `ValidationSummary` を組み立てる。
 *
 * `#/draft` の検証結果パネルは store の `validationResult` を直接描画するだけで
 * Sheets の ValidationLog を読み直さないため（`hydrateCurrentProject` は
 * currentFormulaVersionId/markdown/model しか復元しない）、章ごとの初期状態を
 * デモエントリから store の初期 state として投入するにはこの形が必要になる。
 *
 * ヒット数・捕捉率はすべて `evaluateQuery` でコーパスを実際に評価して求める
 * （§6-2 の不変条件を、検証結果パネルの表示についても保つ）。
 */
export function buildValidationSummary(
  formulaMarkdown: string,
  eligibleSeedPmids: readonly string[],
  corpus: readonly DemoPaper[] = DEMO_CORPUS
): ValidationSummary {
  const formula = parsePubmedFormulaMd(formulaMarkdown);
  const lineHits = formula.blocks.map((block) => {
    const expandedQuery = expandFormula(formula, block.id);
    return {
      blockId: block.id,
      expression: block.expression,
      expandedQuery,
      hitCount: evaluateQuery(expandedQuery, corpus).length,
      error: null,
    };
  });

  const finalQuery = expandFormula(formula);
  const matchedSet = new Set(evaluateQuery(finalQuery, corpus).map((p) => p.pmid));
  const capturedPmids = eligibleSeedPmids.filter((p) => matchedSet.has(p));
  const missedPmids = eligibleSeedPmids.filter((p) => !matchedSet.has(p));
  const captureRate = eligibleSeedPmids.length === 0 ? 0 : capturedPmids.length / eligibleSeedPmids.length;

  const mesh: MeshForSeed[] = eligibleSeedPmids.map((pmid) => {
    const paper = DEMO_CORPUS_BY_PMID.get(pmid);
    const meshHeadings = paper?.meshHeadings ?? [];
    return {
      pmid,
      title: paper?.title ?? null,
      meshHeadings,
      meshDetails: meshHeadings.map((descriptor) => ({ descriptor, majorTopic: true, qualifiers: [] })),
    };
  });
  const meshFrequency = aggregateMeshFrequency(mesh);
  const treeMap = new Map<string, string[]>();
  for (const entry of meshFrequency) {
    const meshEntry = DEMO_MESH_TREE.get(entry.descriptor);
    if (meshEntry) {
      treeMap.set(entry.descriptor, meshEntry.treeNumbers);
    }
  }
  const meshHierarchy = buildMeshHierarchy(treeMap);

  return {
    lineHits,
    finalQuery: {
      finalQuery,
      totalHits: evaluateQuery(finalQuery, corpus).length,
      captureRate,
      capturedPmids,
      missedPmids,
    },
    finalQueryError: null,
    mesh,
    meshFrequency,
    meshError: null,
    meshHierarchy,
    meshMermaid: toMermaidFlowchart(meshHierarchy),
    meshHierarchyError: null,
    eligibleSeedCount: eligibleSeedPmids.length,
    totalSeedCount: eligibleSeedPmids.length,
    loggedValidationIds: [],
  };
}
