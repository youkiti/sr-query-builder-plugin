/**
 * ストア掲載用スクリーンショット撮影（tests/shots/shots.spec.ts）専用のデモフィクスチャ。
 *
 * tests/e2e/fixtures/scenarios/fullState.ts の FULL_APP_STATE は guard 通過を目的とした
 * 最小限のダミーデータ（ブロック 2 個・検索式 3 行）で、公開用スクリーンショットに使うには
 * 薄すぎる。撮影用にブロック 4 個・行数の多い検索式・検証結果（捕捉率・MeSH 頻度・階層）まで
 * 用意した「厚みのある」デモデータをここに切り出す。
 *
 * 題材は既存フィクスチャと同じ「成人 ARDS に対する ECMO」。プロジェクト ID・PMID・
 * スプレッドシート ID を含め、すべて架空のデモ値（実データではない）。
 */

import type { AppState, BlocksDraft, ProtocolDraft } from '../../src/app/store';
import type { CurrentProjectEntry } from '../../src/features/project';
import type { DraftBlockHit, ValidationSummary } from '../../src/app/services';
import { buildMeshHierarchy, toMermaidFlowchart } from '../../src/features/validation';
import type { AppScenario } from '../e2e/fixtures/appStub';

/** 撮影用のデモプロジェクト。実プロジェクトとは無関係の架空データ */
export const SHOTS_PROJECT: CurrentProjectEntry = {
  projectId: 'pid-shots-demo-0001',
  spreadsheetId: 'sheet-shots-demo-0001',
  driveFolderId: 'folder-shots-demo-0001',
  title: '成人ARDSに対するECMOの有効性：系統的レビュー',
};

const SHOTS_PROTOCOL_RAW_TEXT = [
  'リサーチクエスチョン: 成人 ARDS 患者において、ECMO（体外式膜型人工肺）による呼吸循環補助は、',
  '従来の人工呼吸器管理と比較して院内死亡率を改善するか。',
  '',
  'P（対象）: Berlin 定義に基づき中等症〜重症 ARDS と診断された 18 歳以上の成人患者',
  'I（介入）: VV-ECMO（静脈-静脈式体外式膜型人工肺）による呼吸補助',
  'C（対照）: 肺保護換気を含む従来の人工呼吸器管理（ECMO 非導入）',
  'O（アウトカム）: 院内死亡率、28 日死亡率、人工呼吸器離脱までの日数、ICU 在室日数',
  '',
  '研究デザイン: ランダム化比較試験（RCT）を対象とする。観察研究・症例報告・動物実験は除外する。',
].join('\n');

/** s1: 研究プロトコル入力画面（承認済み・読み取り専用表示） */
export const SHOTS_PROTOCOL_DRAFT: ProtocolDraft = {
  frameworkType: 'pico',
  researchQuestion:
    '成人 ARDS 患者において、ECMO による呼吸循環補助は従来の人工呼吸器管理と比較して院内死亡率を改善するか',
  inclusionCriteria:
    '18 歳以上の成人、Berlin 定義に基づく中等症〜重症 ARDS 診断、ICU での人工呼吸管理下にある患者を対象とした RCT',
  exclusionCriteria: '症例報告・症例集積、動物実験、18 歳未満の小児例、プロトコル論文のみのもの',
  studyDesign: 'RCT',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: SHOTS_PROTOCOL_RAW_TEXT.slice(0, 500),
  rawTextInline: SHOTS_PROTOCOL_RAW_TEXT,
};

/**
 * s2（および s2 の上に積む s3〜s5）専用の「短い版」プロトコル。
 *
 * blocksView.ts の `.blocks__protocol-ref-body` は max-height:240px の常時展開ボックス
 * （`<details>` ではないので折りたたみで縮められない）で、SHOTS_PROTOCOL_DRAFT をそのまま
 * 使うとキャップの 240px いっぱいまで埋まり、ブロック一覧の見出しがページ y≈630 まで
 * 押し下げられる。一方サイドバーのナビ総高さは y≈523 までしか無いため、スクロール量 0 では
 * 両立できない（スクロールすると本文がボックス内の文字の途中で水平に切れる）。
 *
 * 元テキスト（rawTextInline）を持たせず、RQ・組入基準・除外基準を 1 行に収まる長さに短縮した
 * だけでは足りなかった（実測: Framework/RQ/Study design/組入基準/除外基準の 5 フィールドは
 * どれも「ラベル行 + 値 1 行」で最低 41px、フィールド間 gap が 12px かかり、5 フィールドだと
 * 253px と 240px キャップをわずかに超える）。studyDesign を空文字にして「Study design」欄
 * 自体を出さない（blocksView.ts の appendRefField は空値のフィールドを描画しない）ことで
 * 4 フィールド・200px まで落とし、キャップの内側（スクロール無し）に収めた。
 *
 * その後、ブロックカード #1 の「ブロック名」欄（P (Population)）が
 * `.blocks__actions`（position:sticky; bottom:0 の下部アクションバー）の下に完全に
 * 隠れてしまうことが分かったため、組入基準・除外基準の 2 フィールドもさらに省いて
 * Framework・RQ の 2 フィールドだけにした（実測で 1 フィールドあたり約 53px 節約
 * → 106px 分ページ全体が上に詰まり、カード #1 の「ブロック名」入力欄がアクションバーの
 * 上に収まるようになる）。プロトコル参照はあくまで「参照」であり、ブロック承認画面の主役は
 * ブロックカードそのものなので、この画面用としては薄くて構わない。
 *
 * studyDesign が空になることで getDefaultSelectedFilterIds による RCT フィルターの自動選択も
 * 効かなくなるが、その UI（結合式エディタのフィルター選択欄）は s2 のスクリーンショットの
 * 範囲より下でそもそも写らないため実害は無い。短縮しても内容は成人 ARDS / ECMO の文脈で
 * 自然に読める文にする。
 */
export const SHOTS_PROTOCOL_DRAFT_SHORT: ProtocolDraft = {
  frameworkType: 'pico',
  researchQuestion: '成人 ARDS 患者への ECMO は院内死亡率を改善するか',
  inclusionCriteria: '',
  exclusionCriteria: '',
  studyDesign: '',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: '',
  rawTextInline: null,
};

/** s2: 検索式ブロック承認画面（PICO の 4 ブロック） */
export const SHOTS_BLOCKS_DRAFT: BlocksDraft = {
  blocks: [
    {
      blockLabel: 'P (Population)',
      description:
        '成人（18 歳以上）で Berlin 定義に基づき ARDS（急性呼吸窮迫症候群）と診断された患者',
      aiGenerated: true,
      note: '',
    },
    {
      blockLabel: 'I (Intervention)',
      description: 'VV-ECMO（体外式膜型人工肺）による呼吸循環補助',
      aiGenerated: true,
      note: '',
    },
    {
      blockLabel: 'C (Comparison)',
      description: '肺保護換気を含む従来の人工呼吸器管理（ECMO 非導入）',
      aiGenerated: true,
      note: '',
    },
    {
      blockLabel: 'O (Outcome)',
      description: '院内死亡率・28 日死亡率・人工呼吸器離脱までの日数',
      aiGenerated: false,
      note: 'アウトカムは PI が手動で修正済み',
    },
  ],
  // selectedFilterIds は未設定のまま（blocksView.ts の自動推論 getDefaultSelectedFilterIds に
  // 委ねる）。ただし blocksShotState() が使う SHOTS_PROTOCOL_DRAFT_SHORT は
  // studyDesign: '' なので、実際には RCTfilter は自動選択されない
  // （s2 のスクリーンショット範囲にはフィルター選択欄自体写らないため実害は無い）。
  combinationExpression: '#1 AND #2 AND #3 AND #4',
};

/** s3/s4 共通で使う検索式ドラフト（4 概念ブロック + RCT フィルター + 結合行） */
export const SHOTS_FORMULA_MARKDOWN = `## PubMed/MEDLINE

\`\`\`
#1 "Respiratory Distress Syndrome, Adult"[Mesh] OR "acute respiratory distress syndrome"[tiab] OR "ARDS"[tiab]
#2 "Extracorporeal Membrane Oxygenation"[Mesh] OR "ECMO"[tiab] OR "extracorporeal life support"[tiab]
#3 "Respiration, Artificial"[Mesh] OR "conventional mechanical ventilation"[tiab] OR "standard ventilatory support"[tiab]
#4 "Hospital Mortality"[Mesh] OR "Survival Rate"[Mesh] OR mortality[tiab] OR survival[tiab]
#RCTfilter randomized controlled trial[pt] OR randomized[tiab] OR "randomised controlled trial"[tiab] OR placebo[tiab]
#5 (#1 AND #2 AND #3 AND #4) AND #RCTfilter
\`\`\`
`;

const HIT_POPULATION: DraftBlockHit = {
  blockIndex: 0,
  blockId: '1',
  blockLabel: 'P (Population)',
  expression:
    '"Respiratory Distress Syndrome, Adult"[Mesh] OR "acute respiratory distress syndrome"[tiab] OR "ARDS"[tiab]',
  hitCount: 15234,
  error: null,
};
const HIT_INTERVENTION: DraftBlockHit = {
  blockIndex: 1,
  blockId: '2',
  blockLabel: 'I (Intervention)',
  expression:
    '"Extracorporeal Membrane Oxygenation"[Mesh] OR "ECMO"[tiab] OR "extracorporeal life support"[tiab]',
  hitCount: 8721,
  error: null,
};
const HIT_COMPARISON: DraftBlockHit = {
  blockIndex: 2,
  blockId: '3',
  blockLabel: 'C (Comparison)',
  expression:
    '"Respiration, Artificial"[Mesh] OR "conventional mechanical ventilation"[tiab] OR "standard ventilatory support"[tiab]',
  hitCount: 452981,
  error: null,
};
const HIT_OUTCOME: DraftBlockHit = {
  blockIndex: 3,
  blockId: '4',
  blockLabel: 'O (Outcome)',
  expression: '"Hospital Mortality"[Mesh] OR "Survival Rate"[Mesh] OR mortality[tiab] OR survival[tiab]',
  hitCount: 812345,
  error: null,
};

/** s3: 生成が「検証中」フェーズまで進み、ブロックごとのヒット数が出揃った状態で使うライブ表示データ */
export const SHOTS_BLOCK_HITS: DraftBlockHit[] = [
  HIT_POPULATION,
  HIT_INTERVENTION,
  HIT_COMPARISON,
  HIT_OUTCOME,
];

const SHOTS_MESH_HIERARCHY = buildMeshHierarchy(
  new Map<string, readonly string[]>([
    ['Respiratory Distress Syndrome, Adult', ['C08.381.540']],
    ['Extracorporeal Membrane Oxygenation', ['E04.292']],
    ['Respiration, Artificial', ['E02.831.810']],
  ])
);

/** s4: 捕捉率・MeSH 検証の結果 */
export const SHOTS_VALIDATION_SUMMARY: ValidationSummary = {
  lineHits: [
    {
      blockId: '1',
      expression: HIT_POPULATION.expression,
      expandedQuery: HIT_POPULATION.expression,
      hitCount: HIT_POPULATION.hitCount ?? 0,
      error: null,
    },
    {
      blockId: '2',
      expression: HIT_INTERVENTION.expression,
      expandedQuery: HIT_INTERVENTION.expression,
      hitCount: HIT_INTERVENTION.hitCount ?? 0,
      error: null,
    },
    {
      blockId: '3',
      expression: HIT_COMPARISON.expression,
      expandedQuery: HIT_COMPARISON.expression,
      hitCount: HIT_COMPARISON.hitCount ?? 0,
      error: null,
    },
    {
      blockId: '4',
      expression: HIT_OUTCOME.expression,
      expandedQuery: HIT_OUTCOME.expression,
      hitCount: HIT_OUTCOME.hitCount ?? 0,
      error: null,
    },
    {
      blockId: 'RCTfilter',
      expression:
        'randomized controlled trial[pt] OR randomized[tiab] OR "randomised controlled trial"[tiab] OR placebo[tiab]',
      expandedQuery:
        'randomized controlled trial[pt] OR randomized[tiab] OR "randomised controlled trial"[tiab] OR placebo[tiab]',
      hitCount: 1523876,
      error: null,
    },
    {
      blockId: '5',
      expression: '(#1 AND #2 AND #3 AND #4) AND #RCTfilter',
      expandedQuery: '((("ARDS" concept) AND ("ECMO" concept) AND ("ventilation" concept) AND ("mortality" concept)) AND (RCT filter))',
      hitCount: 342,
      error: null,
    },
  ],
  finalQuery: {
    finalQuery:
      '((("ARDS" concept) AND ("ECMO" concept) AND ("ventilation" concept) AND ("mortality" concept)) AND (RCT filter))',
    totalHits: 342,
    captureRate: 0.9,
    capturedPmids: [
      '20123456',
      '20234567',
      '21345678',
      '22456789',
      '23567890',
      '24678901',
      '25789012',
      '26890123',
      '27901234',
    ],
    missedPmids: ['31234567'],
  },
  finalQueryError: null,
  mesh: [],
  // 撮影用にスクロール量を抑えるため 5 件ではなく 4 件に絞る（コンテンツの縦を詰める）。
  // s4-validation のフレーミング（左サイドバー可視 + Mermaid 生ソース非表示）と合わせて調整。
  meshFrequency: [
    { descriptor: 'Respiratory Distress Syndrome, Adult', count: 8 },
    { descriptor: 'Extracorporeal Membrane Oxygenation', count: 7 },
    { descriptor: 'Respiration, Artificial', count: 5 },
    { descriptor: 'Randomized Controlled Trials as Topic', count: 4 },
  ],
  meshError: null,
  meshHierarchy: SHOTS_MESH_HIERARCHY,
  meshMermaid: toMermaidFlowchart(SHOTS_MESH_HIERARCHY),
  meshHierarchyError: null,
  eligibleSeedCount: 10,
  totalSeedCount: 12,
  loggedValidationIds: ['vlog-shots-0001', 'vlog-shots-0002', 'vlog-shots-0003'],
};

const BASE: Partial<AppState> = {
  project: SHOTS_PROJECT,
  cumulativeCostUsd: 0.42,
};

/** s1 用の preloadedState: 承認済みプロトコル（読み取り専用表示） */
export function protocolShotState(): Partial<AppState> {
  return {
    ...BASE,
    protocolDraft: SHOTS_PROTOCOL_DRAFT,
    protocolDraftPersisted: true,
    currentProtocolVersion: 1,
  };
}

/**
 * s2（および s3〜s5 のベース）用の preloadedState: 承認済みプロトコル + 4 ブロックの承認画面。
 *
 * protocolShotState() を再利用せず、あえて SHOTS_PROTOCOL_DRAFT_SHORT を直接使う
 * （理由は同定数のコメント参照）。s3〜s5 は protocolDraft の内容を画面に出さないため、
 * この差し替えによる見た目への影響は s2 のみ。
 */
export function blocksShotState(): Partial<AppState> {
  return {
    ...BASE,
    protocolDraft: SHOTS_PROTOCOL_DRAFT_SHORT,
    protocolDraftPersisted: true,
    currentProtocolVersion: 1,
    blocksDraft: SHOTS_BLOCKS_DRAFT,
  };
}

/**
 * s3 用の preloadedState: 生成 → 検証パイプラインが「検証中」フェーズまで進み、
 * ブロックごとのヒット数が出揃った状態。
 *
 * draftView.ts の描画ロジック上、生成・検証が完全に完了すると draftRun は null に戻り、
 * ライブヒット数の一覧（.draft__block-hits）は非表示になる（検証結果セクションに引き継がれる
 * ため）。そのためこのスクリーンショットは「ヒット数が出揃い、検証フェーズに入った直後」の
 * running 状態を意図的に保持して撮る（tests/e2e/app-draft.spec.ts の
 * 「draftRun=running 中」テストと同じ preload パターン）。
 *
 * currentFormulaMarkdown はあえて設定しない（= 初回生成中という設定）。draftView.ts は
 * 既存 formula があるとその全文カード表示を info 行の下に挟むため、ヘッダー・サイドバーの
 * ナビゲーションと「ブロックごとのヒット数」を 800px の折返し内に収めるだけの余白が無くなる
 * （実測で 800px を優に超える）。初回生成中はまだ確定した formula が無いのが自然な状態でも
 * あるため、この省略はフレーミング都合であると同時に妥当な状態選択でもある。
 */
export function draftRunningShotState(): Partial<AppState> {
  return {
    ...blocksShotState(),
    draftRun: {
      status: 'running',
      phase: 'validating',
      progressLabel: 'シード捕捉率を確認中',
      progress: { phase: 'validating', step: 'final_query' },
      startedAtMs: Date.now() - 42_000,
      error: null,
      blockHits: SHOTS_BLOCK_HITS,
    },
  };
}

/** s4 用の preloadedState: 生成・検証が完了し、捕捉率・MeSH 検証結果が保存された状態 */
export function draftValidatedShotState(): Partial<AppState> {
  return {
    ...blocksShotState(),
    currentFormulaVersionId: 'fv-shots-0001',
    currentFormulaMarkdown: SHOTS_FORMULA_MARKDOWN,
    currentFormulaModel: 'gemini-3.5-flash',
    draftRun: null,
    validationResult: {
      formulaVersionId: 'fv-shots-0001',
      summary: SHOTS_VALIDATION_SUMMARY,
    },
  };
}

/**
 * s5 用の preloadedState: 検索式は確定済みだが、変換結果はまだ無い状態。
 * exportView.ts は変換結果を store ではなくローカル DOM に持つため（ExportResult は
 * preload できない）、実際に「4 DB へ変換して保存」ボタンをクリックして生成する必要がある。
 */
export function exportShotState(): Partial<AppState> {
  return {
    ...blocksShotState(),
    currentFormulaVersionId: 'fv-shots-0001',
    currentFormulaMarkdown: SHOTS_FORMULA_MARKDOWN,
    currentFormulaModel: 'gemini-3.5-flash',
  };
}

/**
 * SHOTS_PROJECT を chrome.storage.local.currentProject にもシードした AppScenario を返す
 * （tests/e2e/fixtures/appStub.ts の scenarioWithProject と同じ形）。
 */
export function shotsScenario(preloadedState: Partial<AppState>): AppScenario {
  return {
    authed: true,
    email: 'tester@example.com',
    currentProject: SHOTS_PROJECT,
    preloadedState,
  };
}
