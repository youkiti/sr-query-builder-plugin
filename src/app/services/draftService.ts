import type { AppStore } from '../store';
import {
  assembleFormulaMd,
  buildBlockExpression,
  appendFormulaVersion,
  type AssembledFormula,
  type BlockOutputs,
} from '@/features/formula';
import {
  designBlock,
  designDefaultFilters,
  designFreewords,
  suggestMesh,
  type BlockSkeleton,
  type FilterDesignerResult,
  type FreewordSuggestion,
  type MeshSuggestion,
  type SeedSample,
} from '@/features/formula/skills';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import { listSeedPapers } from '@/features/seeds';
import { summarizeSeedMesh, type MeshForSeed, type SeedMeshSummary } from '@/features/validation';
import type { GoogleApiDeps } from '@/lib/google';
import { efetchArticles, type EutilsDeps } from '@/lib/ncbi';
import { nowIso } from '@/utils/iso8601';
import { newUuid } from '@/utils/uuid';
import type { LlmProviderFactory } from './llmProviderService';

/**
 * ブロック承認後に走る「検索式ドラフト生成」サービス。
 *
 * 1. ブロックごとに block-designer → mesh-suggester → freeword-designer を逐次実行
 * 2. filter-designer は決定論的（LLM 不要）
 * 3. assembleFormulaMd で markdown を生成
 * 4. FormulaVersions タブに 1 行追記し、store.currentFormulaVersionId を更新
 *
 * 各 LLM 呼び出しは LlmProviderFactory から purpose 付きプロバイダを取り、
 * withLogging が LLMApiLog を別途記録する。各ステップの進捗は onProgress callback で通知する。
 */

export interface DraftProgress {
  /** 現在の処理ステップ（UI 表示用） */
  step:
    | 'block-designer'
    | 'mesh-suggester'
    | 'freeword-designer'
    | 'line-hits'
    | 'filter-designer'
    | 'assemble'
    | 'save'
    | 'done';
  /** 処理中のユーザーブロック index（0〜N-1）。filter-designer / assemble / save / done では未使用 */
  blockIndex?: number;
  /** ユーザーブロックの総数 */
  blockCount: number;
}

/**
 * 生成途中に計測した 1 概念ブロックのヒット数（line_hits の前倒し実行）。
 * 「ブロックが出来上がるごとに検索」を実現するためのもので、view のライブ表示と、
 * 完成後の検証（runValidation）での再 esearch 省略の両方に使う。
 */
export interface DraftBlockHit {
  /** ユーザーブロック index（0〜N-1） */
  blockIndex: number;
  /** 検索式上のブロック id（`#N` の N）。概念ブロックは String(blockIndex + 1) */
  blockId: string;
  /** ブロック名（blocksDraft.blockLabel） */
  blockLabel: string;
  /** 組み立てたブロック式（そのまま esearch に投げた文字列） */
  expression: string;
  /** ヒット数。計測前 / エラー時は null */
  hitCount: number | null;
  /** 計測エラー時のメッセージ。成功時は null */
  error: string | null;
}

export interface DraftServiceDeps {
  google: GoogleApiDeps;
  store: AppStore;
  /** seed 論文の MeSH を NCBI efetch で取得するための E-utilities deps */
  eutils: EutilsDeps;
  /** skill 呼び出しに使う LLM プロバイダファクトリ */
  llmFactory: LlmProviderFactory;
  /** 進捗通知 callback（UI が prog バーを進める用） */
  onProgress?: (progress: DraftProgress) => void;
  /**
   * ブロック式のヒット数を計測する（esearch count）。注入された場合のみ、
   * 各概念ブロックが出来上がった直後に呼んで line_hits を前倒し計測する。
   * draftService 自身は NCBI を直接叩かず、配線側（bootstrap）が esearch を渡す。
   */
  countBlockHits?: (expression: string) => Promise<number>;
  /** 1 ブロックの計測が確定するたびに呼ぶ（view のライブ表示更新用） */
  onBlockCounted?: (hit: DraftBlockHit) => void;
  /** テスト時に差し替え可能な UUID / 時刻 */
  newUuid?: () => string;
  now?: () => string;
}

export interface DraftResult {
  versionId: string;
  formula: AssembledFormula['formula'];
  markdown: string;
  filter: FilterDesignerResult;
  blockSkeletons: BlockSkeleton[];
  meshSuggestions: MeshSuggestion[][];
  freewordSuggestions: FreewordSuggestion[][];
  /** 生成途中に計測した概念ブロックごとのヒット数。countBlockHits 未注入なら空配列 */
  blockHits: DraftBlockHit[];
}

const noopProgress: (p: DraftProgress) => void = () => undefined;

/**
 * 検索式ドラフトを生成して Sheets に保存し、store の currentFormulaVersionId を更新する。
 * @throws 先にプロジェクト選択・プロトコル入力・ブロック承認が済んでいないときは明示的なエラー
 */
export async function generateDraft(deps: DraftServiceDeps): Promise<DraftResult> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (state.protocolDraft === null) {
    throw new Error('protocolDraft が未設定です。プロトコル入力を先に行ってください');
  }
  if (state.blocksDraft === null || state.blocksDraft.blocks.length === 0) {
    throw new Error('blocksDraft が未設定です。ブロック承認を先に行ってください');
  }
  const project = state.project;
  const protocol = state.protocolDraft;
  const blocks = state.blocksDraft;
  const notifyProgress = deps.onProgress ?? noopProgress;

  const blockCount = blocks.blocks.length;
  const skeletons: BlockSkeleton[] = [];
  const meshes: MeshSuggestion[][] = [];
  const freewords: FreewordSuggestion[][] = [];
  const blockHits: DraftBlockHit[] = [];

  // seed 論文のタイトル・抄録・MeSH を各 skill へ渡す（requirements.md §4.4）。
  // 取得に失敗しても／seed 0 件でもドラフト生成は止めず、空のコンテクストで続行する。
  const seedContext = await collectSeedContext(project.spreadsheetId, deps);

  for (let i = 0; i < blockCount; i += 1) {
    const block = blocks.blocks[i];
    /* istanbul ignore if -- index は blockCount 範囲内 */
    if (!block) {
      continue;
    }
    notifyProgress({ step: 'block-designer', blockIndex: i, blockCount });
    const skeleton = await designBlock(
      {
        blockLabel: block.blockLabel,
        description: block.description,
        researchQuestion: protocol.researchQuestion,
        seedTitles: seedContext.titles,
      },
      deps.llmFactory.forPurpose('draft_block')
    );
    skeletons.push(skeleton);

    notifyProgress({ step: 'mesh-suggester', blockIndex: i, blockCount });
    const mesh = await suggestMesh(
      {
        conceptSummary: skeleton.conceptSummary,
        meshRequirements: skeleton.meshRequirements,
        seedMesh: seedContext.meshSummary,
      },
      deps.llmFactory.forPurpose('suggest_mesh')
    );
    meshes.push(mesh);

    notifyProgress({ step: 'freeword-designer', blockIndex: i, blockCount });
    const meshSuggestionsRef: Array<{ descriptor: string }> = [];
    for (const m of mesh) {
      meshSuggestionsRef.push({ descriptor: m.descriptor });
    }
    const fw = await designFreewords(
      {
        conceptSummary: skeleton.conceptSummary,
        freewordRequirements: skeleton.freewordRequirements,
        meshSuggestions: meshSuggestionsRef,
        seedSamples: seedContext.samples,
      },
      deps.llmFactory.forPurpose('expand_freeword')
    );
    freewords.push(fw);

    // ブロックが出来上がった瞬間に単体ヒット数を計測する（line_hits の前倒し）。
    // countBlockHits が注入されていない（テスト等）場合はスキップする。
    if (deps.countBlockHits) {
      const expression = buildBlockExpression({ skeleton, mesh, freewords: fw });
      notifyProgress({ step: 'line-hits', blockIndex: i, blockCount });
      let hit: DraftBlockHit = {
        blockIndex: i,
        blockId: String(i + 1),
        blockLabel: block.blockLabel,
        expression,
        hitCount: null,
        error: null,
      };
      try {
        hit = { ...hit, hitCount: await deps.countBlockHits(expression) };
      } catch (err) {
        hit = { ...hit, error: err instanceof Error ? err.message : String(err) };
      }
      blockHits.push(hit);
      deps.onBlockCounted?.(hit);
    }
  }

  notifyProgress({ step: 'filter-designer', blockCount });
  const filter = designDefaultFilters({ studyDesign: protocol.studyDesign });

  notifyProgress({ step: 'assemble', blockCount });
  // skeletons / meshes / freewords は同ループで同じ順序に push しているので常に同じ長さ
  const blockOutputs: BlockOutputs[] = [];
  for (let i = 0; i < skeletons.length; i += 1) {
    blockOutputs.push({
      skeleton: skeletons[i] as BlockSkeleton,
      mesh: meshes[i] as MeshSuggestion[],
      freewords: freewords[i] as FreewordSuggestion[],
    });
  }
  const assembled = assembleFormulaMd({
    baseCombinationExpression: blocks.combinationExpression,
    blocks: blockOutputs,
    filterResult: filter,
  });

  notifyProgress({ step: 'save', blockCount });
  const versionId = (deps.newUuid ?? newUuid)();
  const createdAt = (deps.now ?? nowIso)();
  // 生成に実際に使ったモデル ID を版に記録する（export 画面の Methods 文案用）
  const model = deps.llmFactory.model;
  await appendFormulaVersion(
    project.spreadsheetId,
    {
      versionId,
      parentVersionId: state.currentFormulaVersionId,
      protocolVersion: state.currentProtocolVersion ?? 0,
      protocolSnapshotRef: protocol.rawTextRef ?? protocol.rawTextInline ?? '',
      formulaMd: assembled.markdown,
      createdBy: 'ai_draft',
      createdAt,
      note: null,
      model,
    },
    deps.google
  );

  deps.store.setState((s) => ({
    ...s,
    currentFormulaVersionId: versionId,
    currentFormulaMarkdown: assembled.markdown,
    currentFormulaModel: model,
  }));

  notifyProgress({ step: 'done', blockCount });
  return {
    versionId,
    formula: assembled.formula,
    markdown: assembled.markdown,
    filter,
    blockSkeletons: skeletons,
    meshSuggestions: meshes,
    freewordSuggestions: freewords,
    blockHits,
  };
}

/** ドラフト生成の各 skill へ渡す seed 論文コンテクスト。 */
export interface SeedContext {
  /** block-designer 用のタイトル一覧（先頭 MAX_SEED_TITLES 件） */
  titles: string[];
  /** freeword-designer 用のタイトル/抄録サンプル（先頭 MAX_SEED_SAMPLES 件） */
  samples: SeedSample[];
  /** mesh-suggester 用の MeSH 要約（カバレッジ・MajorTopic・qualifier） */
  meshSummary: SeedMeshSummary;
}

/** block-designer に渡すタイトル数の上限。 */
const MAX_SEED_TITLES = 30;
/** freeword-designer に渡す抄録付きサンプル数の上限（トークン節約）。 */
const MAX_SEED_SAMPLES = 10;

const EMPTY_SEED_CONTEXT: SeedContext = {
  titles: [],
  samples: [],
  meshSummary: { seedCount: 0, concepts: [], checkTags: [] },
};

/**
 * 適格 seed 論文（isSeedEligibleForValidation）を NCBI efetch で 1 回だけ引き、
 * 各 skill に渡すタイトル・抄録・MeSH 要約をまとめて返す（requirements.md §4.4）。
 *
 * seed 0 件や efetch 失敗時はドラフト生成を止めず、空のコンテクストで続行する
 * （取得失敗は警告ログ程度に留める）。
 */
async function collectSeedContext(
  spreadsheetId: string,
  deps: DraftServiceDeps
): Promise<SeedContext> {
  try {
    const seeds = await listSeedPapers(spreadsheetId, deps.google);
    const eligiblePmids = seeds
      .filter((seed) => isSeedEligibleForValidation(seed))
      .map((seed) => seed.pmid)
      .filter((pmid): pmid is string => pmid !== null);
    if (eligiblePmids.length === 0) {
      return EMPTY_SEED_CONTEXT;
    }
    const articles = await efetchArticles(eligiblePmids, deps.eutils);
    if (articles.length === 0) {
      return EMPTY_SEED_CONTEXT;
    }
    const titles = articles
      .map((a) => a.title?.trim())
      .filter((t): t is string => Boolean(t))
      .slice(0, MAX_SEED_TITLES);
    const samples: SeedSample[] = articles
      .slice(0, MAX_SEED_SAMPLES)
      .map((a) => ({ title: a.title, abstract: a.abstract }));
    const meshRecords: MeshForSeed[] = articles.map((a) => ({
      pmid: a.pmid,
      title: a.title,
      meshHeadings: a.meshHeadings,
      meshDetails: a.meshDetails,
    }));
    const meshSummary = summarizeSeedMesh(meshRecords, articles.length);
    return { titles, samples, meshSummary };
  } catch (err) {
    // seed コンテクスト取得に失敗してもドラフト生成は継続する（seed なし扱い）。
    console.warn('[draft] seed 論文のコンテクスト取得に失敗したため空で続行します', err);
    return EMPTY_SEED_CONTEXT;
  }
}

