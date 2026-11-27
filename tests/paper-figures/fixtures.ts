/**
 * 論文の図（英語の画面）を撮るための種データ。
 *
 * ストア掲載用の tests/shots/fixtures.ts（日本語・ARDS/ECMO）とは別に、英語の架空の例を置く。
 * 題材は「人工膝関節全置換術後の成人に対する遠隔リハビリテーション」。検索式・件数・シード・
 * 文献の題と PMID はすべて架空で、実在のレビューの式や実在の PMID を写していない
 * （PMID は 9000 万番台。2026 年時点で PubMed が採番していない範囲）。
 *
 * アプリの文言と挙動には手を入れない。ここにあるのは、利用者や AI・PubMed から入ってくる
 * データ（プロトコル、ブロック、式、件数、文献の書誌、AI が付けた理由）だけ。
 */

import type { AppState, BlocksDraft, ProtocolDraft, QueryOptimizationRunState } from '../../src/app/store';
import type { CurrentProjectEntry } from '../../src/features/project';
import type { ValidationSummary } from '../../src/app/services';
import type { OptimizationMeasurement } from '../../src/features/formula/skills/optimizeQuery';
import { parsePubmedFormulaMd } from '../../src/lib/search-formula-md';
import type { AppScenario } from '../e2e/fixtures/appStub';

export const PAPER_PROJECT: CurrentProjectEntry = {
  projectId: 'pid-paper-figure-0001',
  spreadsheetId: 'sheet-paper-figure-0001',
  driveFolderId: 'folder-paper-figure-0001',
  title: 'Telerehabilitation after total knee arthroplasty: a systematic review (fictional example)',
};

const PROTOCOL: ProtocolDraft = {
  frameworkType: 'pico',
  researchQuestion:
    'In adults who have had total knee arthroplasty, does telerehabilitation improve physical function compared with in-person physiotherapy?',
  inclusionCriteria:
    'Randomized controlled trials in adults after primary total knee arthroplasty that compare telerehabilitation with in-person physiotherapy',
  exclusionCriteria: 'Revision surgery, paediatric populations, case reports, protocols without results',
  studyDesign: 'RCT',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: '',
  rawTextInline: null,
};

const BLOCKS: BlocksDraft = {
  blocks: [
    {
      blockLabel: 'Total knee arthroplasty',
      description: 'Adults who have had primary total knee arthroplasty',
      aiGenerated: true,
      note: '',
    },
    {
      blockLabel: 'Telerehabilitation',
      description: 'Rehabilitation delivered remotely by video, telephone, or app',
      aiGenerated: true,
      note: '',
    },
  ],
  combinationExpression: '#1 AND #2',
};

const BLOCK1 =
  '"Arthroplasty, Replacement, Knee"[Mesh] OR "knee arthroplasty"[tiab] OR "knee replacement"[tiab] OR TKA[tiab]';
const BLOCK2_INITIAL =
  '"Telerehabilitation"[Mesh] OR "Telemedicine"[Mesh] OR telerehabilitation[tiab] OR "tele-rehabilitation"[tiab] OR "remote rehabilitation"[tiab] OR telehealth[tiab]';
const BLOCK2_FINAL =
  '"Telerehabilitation"[Mesh] OR telerehabilitation[tiab] OR "tele-rehabilitation"[tiab] OR "remote rehabilitation"[tiab] OR "virtual physiotherapy"[tiab]';

function formulaMd(block2: string): string {
  return `## PubMed/MEDLINE\n\n\`\`\`\n#1 ${BLOCK1}\n#2 ${block2}\n#3 #1 AND #2\n\`\`\`\n`;
}

const INITIAL_FORMULA_MD = formulaMd(BLOCK2_INITIAL);
export const PAPER_FINAL_FORMULA_MD = formulaMd(BLOCK2_FINAL);

/** 既知のシード 8 件（架空の PMID） */
const SEEDS = ['90000101', '90000102', '90000103', '90000104', '90000105', '90000106', '90000107', '90000108'];

const MAX_HITS = 2000;
const HITS_BLOCK1 = 41208;
const HITS_BLOCK2_INITIAL = 58914;
const HITS_BLOCK2_FINAL = 9736;
const HITS_INITIAL = 3154;
const HITS_FINAL = 1286;
const MEASURED_AT = '2026-11-20T09:14:00.000Z';

const initialMeasurement: OptimizationMeasurement = {
  id: 'm-initial',
  fingerprint: 'fp-initial',
  measuredAt: MEASURED_AT,
  totalHits: HITS_INITIAL,
  capturedPmids: SEEDS,
  missedPmids: [],
  blocks: [
    { id: '1', hits: HITS_BLOCK1, error: null },
    { id: '2', hits: HITS_BLOCK2_INITIAL, error: null },
  ],
};

const finalMeasurement: OptimizationMeasurement = {
  id: 'm-final',
  fingerprint: 'fp-final',
  measuredAt: MEASURED_AT,
  totalHits: HITS_FINAL,
  capturedPmids: SEEDS,
  missedPmids: [],
  blocks: [
    { id: '1', hits: HITS_BLOCK1, error: null },
    { id: '2', hits: HITS_BLOCK2_FINAL, error: null },
  ],
};

const FINAL_QUERY = `(${BLOCK1}) AND (${BLOCK2_FINAL})`;

/** 式の外側から AI が選んだ判定候補（架空の文献） */
const OUTSIDE_CANDIDATES: NonNullable<QueryOptimizationRunState['outsideCheck']>['candidates'] = [
  {
    pmid: '90000214',
    title: 'Video-guided home exercise after knee replacement: a randomized trial',
    year: 2021,
    abstract:
      'Adults were randomized after primary knee replacement to a video-guided home exercise programme or to outpatient physiotherapy. Function at 12 weeks was the primary outcome.',
    source: 'outside',
    reason:
      'Randomized trial of remotely supervised exercise after knee replacement. The abstract says "video-guided home exercise" and uses none of the terms in block #2.',
  },
  {
    pmid: '90000231',
    title: 'Telephone follow-up by nurses after hip or knee arthroplasty',
    year: 2018,
    abstract:
      'Patients received scheduled telephone calls from a nurse after discharge. The calls covered wound care and pain medication. Readmission within 30 days was the primary outcome.',
    source: 'outside',
    reason:
      'Remote contact after arthroplasty, but the calls cover wound care and medication and do not deliver rehabilitation.',
  },
  {
    pmid: '90000247',
    title: 'App-based rehabilitation after total knee arthroplasty: a feasibility study',
    year: 2023,
    abstract:
      'A smartphone app delivered a daily exercise programme with remote monitoring by a physiotherapist. Thirty participants were enrolled. The study design is described as a pilot.',
    source: 'outside',
    reason:
      'App-delivered rehabilitation after knee arthroplasty. The abstract does not say whether participants were randomized.',
  },
];

function optimizationRun(decisions: NonNullable<QueryOptimizationRunState['outsideCheck']>['decisions']): QueryOptimizationRunState {
  const initial = parsePubmedFormulaMd(INITIAL_FORMULA_MD);
  const final = parsePubmedFormulaMd(PAPER_FINAL_FORMULA_MD);
  const trials: QueryOptimizationRunState['trials'] = [
    {
      kind: 'initial',
      candidateId: 'initial',
      formula: initial,
      accepted: true,
      before: null,
      after: initialMeasurement,
      reason: 'Initial measurement',
      rationale: '',
      apiEvents: [],
    },
    {
      kind: 'proposal',
      candidateId: 'c1',
      formula: final,
      accepted: true,
      before: initialMeasurement,
      after: finalMeasurement,
      reason: 'Hit count fell to the target and all known seeds are still captured',
      rationale:
        'The broad heading "Telemedicine"[Mesh] and telehealth[tiab] retrieve remote consultations unrelated to rehabilitation.',
      apiEvents: [],
    },
  ];
  return {
    status: 'ready',
    runId: 'run-paper-figure-0001',
    projectId: PAPER_PROJECT.projectId,
    maxHits: MAX_HITS,
    maxIterations: 5,
    seedCount: SEEDS.length,
    startedAtMs: Date.parse(MEASURED_AT) - 95_000,
    finishedAtMs: Date.parse(MEASURED_AT),
    stopRequested: false,
    error: null,
    meshContext: [],
    progress: {
      step: 'review',
      iterations: 1,
      bestTotalHits: HITS_FINAL,
      bestCapturedSeedCount: SEEDS.length,
      trial: null,
    },
    trials,
    result: {
      status: 'achieved',
      stopReason: 'conditions_met',
      unmetReasons: [],
      unmetReasonMessages: [],
      seedDiagnoses: [],
      trials,
      iterations: 1,
      apiCalls: 24,
      elapsedMs: 95_000,
      best: {
        formula: final,
        measurement: finalMeasurement,
        evaluation: {
          status: 'success',
          fingerprint: 'fp-final',
          measuredAt: MEASURED_AT,
          lineHits: [],
          seedPmids: SEEDS,
          finalQuery: {
            status: 'success',
            error: null,
            finalQuery: FINAL_QUERY,
            totalHits: HITS_FINAL,
            captureRate: 1,
            capturedPmids: SEEDS,
            missedPmids: [],
          },
        },
      },
    },
    outsideCheck: {
      status: 'ready',
      reason: null,
      originalHits: HITS_FINAL,
      marginHits: 412,
      evaluatedCount: 40,
      candidates: OUTSIDE_CANDIDATES,
      decisions,
    },
  };
}

const VALIDATION_SUMMARY: ValidationSummary = {
  lineHits: [
    { blockId: '1', expression: BLOCK1, expandedQuery: BLOCK1, hitCount: HITS_BLOCK1, error: null },
    { blockId: '2', expression: BLOCK2_FINAL, expandedQuery: BLOCK2_FINAL, hitCount: HITS_BLOCK2_FINAL, error: null },
    { blockId: '3', expression: '#1 AND #2', expandedQuery: FINAL_QUERY, hitCount: HITS_FINAL, error: null },
  ],
  finalQuery: {
    finalQuery: FINAL_QUERY,
    totalHits: HITS_FINAL,
    captureRate: 1,
    capturedPmids: SEEDS,
    missedPmids: [],
  },
  finalQueryError: null,
  mesh: [],
  meshFrequency: [
    { descriptor: 'Arthroplasty, Replacement, Knee', count: 8 },
    { descriptor: 'Telerehabilitation', count: 6 },
    { descriptor: 'Exercise Therapy', count: 5 },
    { descriptor: 'Recovery of Function', count: 4 },
  ],
  meshError: null,
  meshHierarchy: [],
  meshMermaid: '',
  meshHierarchyError: null,
  eligibleSeedCount: SEEDS.length,
  totalSeedCount: SEEDS.length,
  loggedValidationIds: ['vlog-paper-0001'],
};

const BASE: Partial<AppState> = {
  project: PAPER_PROJECT,
  cumulativeCostUsd: 0.31,
  protocolDraft: PROTOCOL,
  protocolDraftPersisted: true,
  currentProtocolVersion: 1,
  blocksDraft: BLOCKS,
  queryOptimizationSetup: {
    projectId: PAPER_PROJECT.projectId,
    status: 'ready',
    maxHits: String(MAX_HITS),
    maxIterations: '5',
    seedCount: SEEDS.length,
    seedPmids: SEEDS,
    error: null,
  },
};

/**
 * 最終レビュー（採用して保存する前）。式の外側の 3 件は、exclude で保存、maybe で保存、未判定。
 */
export function reviewState(): Partial<AppState> {
  return {
    ...BASE,
    queryOptimizationRun: optimizationRun({
      '90000231': { decision: 'exclude', status: 'saved', error: null },
      '90000247': { decision: 'maybe', status: 'saved', error: null },
    }),
  };
}

/** 採用して保存した後。保存した式に対する検証結果（行ごとの件数とシードの捕捉率）が出る。 */
export function validatedState(): Partial<AppState> {
  return {
    ...BASE,
    currentFormulaVersionId: 'fv-paper-0001',
    currentFormulaMarkdown: PAPER_FINAL_FORMULA_MD,
    currentFormulaModel: 'gemini-3.5-flash',
    draftRun: null,
    validationResult: { formulaVersionId: 'fv-paper-0001', summary: VALIDATION_SUMMARY },
  };
}

/** 画面の言語を英語にして、PAPER_PROJECT をシードしたシナリオ */
export function paperScenario(preloadedState: Partial<AppState>): AppScenario {
  return {
    authed: true,
    email: 'reviewer@example.com',
    currentProject: PAPER_PROJECT,
    extraStorage: { uiLanguage: 'en' },
    preloadedState,
  };
}
