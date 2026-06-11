import type { AppStore } from '../store';
import {
  assembleFormulaMd,
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
} from '@/features/formula/skills';
import { isSeedEligibleForValidation } from '@/domain/seedPaper';
import { listSeedPapers } from '@/features/seeds';
import { aggregateMeshFrequency, extractMeshForSeeds } from '@/features/validation';
import type { GoogleApiDeps } from '@/lib/google';
import type { EutilsDeps } from '@/lib/ncbi';
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
    | 'filter-designer'
    | 'assemble'
    | 'save'
    | 'done';
  /** 処理中のユーザーブロック index（0〜N-1）。filter-designer / assemble / save / done では未使用 */
  blockIndex?: number;
  /** ユーザーブロックの総数 */
  blockCount: number;
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

  // seed 論文の MeSH 頻度を mesh-suggester へ渡す（requirements.md §4.4）。
  // 取得に失敗しても／seed 0 件でもドラフト生成は止めず、空配列で続行する。
  const seedMeshFrequency = await collectSeedMeshFrequency(project.spreadsheetId, deps);

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
      },
      deps.llmFactory.forPurpose('draft_block')
    );
    skeletons.push(skeleton);

    notifyProgress({ step: 'mesh-suggester', blockIndex: i, blockCount });
    const mesh = await suggestMesh(
      {
        conceptSummary: skeleton.conceptSummary,
        meshRequirements: skeleton.meshRequirements,
        seedMeshFrequency,
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
      },
      deps.llmFactory.forPurpose('expand_freeword')
    );
    freewords.push(fw);
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
    },
    deps.google
  );

  deps.store.setState((s) => ({
    ...s,
    currentFormulaVersionId: versionId,
    currentFormulaMarkdown: assembled.markdown,
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
  };
}

/**
 * 適格 seed 論文（isSeedEligibleForValidation）の PMID 群を NCBI efetch で引き、
 * MeSH 記述子の頻度表を返す。mesh-suggester のプロンプトに渡す（requirements.md §4.4）。
 *
 * seed 0 件や efetch 失敗時はドラフト生成を止めず、空配列で続行する
 * （MeSH 取得失敗は警告ログ程度に留める）。
 */
async function collectSeedMeshFrequency(
  spreadsheetId: string,
  deps: DraftServiceDeps
): Promise<Array<{ descriptor: string; count: number }>> {
  try {
    const seeds = await listSeedPapers(spreadsheetId, deps.google);
    const eligiblePmids = seeds
      .filter((seed) => isSeedEligibleForValidation(seed))
      .map((seed) => seed.pmid)
      .filter((pmid): pmid is string => pmid !== null);
    if (eligiblePmids.length === 0) {
      return [];
    }
    const mesh = await extractMeshForSeeds(eligiblePmids, deps.eutils);
    return aggregateMeshFrequency(mesh);
  } catch (err) {
    // MeSH 取得に失敗してもドラフト生成は継続する（seed なし扱い）。
    console.warn('[draft] seed 論文の MeSH 取得に失敗したため空で続行します', err);
    return [];
  }
}

