import type { CurrentProjectEntry } from '@/features/project';
import type { ExcessFilterCandidate } from '@/features/formula/skills';
import type {
  AnalyzeMissedSeedsResult,
  ValidationProgress,
  ValidationSummary,
} from './services/validationService';
import type { DraftBlockHit, DraftProgress } from './services/draftService';
import type { BoundaryCasesResult, ExpandFetchStep } from './services/expandService';
import { DEFAULT_ROUTE, type RouteName } from './router';

/**
 * メインビューの中央ストア。
 * 自作の最小実装（≒ Redux mini）。後で signals / zustand に差し替えても
 * インターフェースは互換のまま使えるよう保つ。
 */

/**
 * ブロック承認画面（#/blocks）で編集中のドラフト。
 * extract-protocol skill の結果を初期値としてここに入れ、
 * ユーザーの編集を反映してから ProtocolBlocks タブへ保存する。
 */
export interface BlockDraft {
  blockLabel: string;
  description: string;
  /** AI が生成したまま未編集なら true、ユーザーが触ったら false */
  aiGenerated: boolean;
  note: string;
}

export interface BlocksDraft {
  blocks: BlockDraft[];
  combinationExpression: string;
  /** 選択済みフィルター ID のリスト（例: ['RCTfilter']）。undefined は未設定（studyDesign から自動推論） */
  selectedFilterIds?: string[];
}

/**
 * プロトコル本文（手入力 / md / docx）のメタ情報。
 * extract-protocol skill 出力のうちブロック以外（framework_type / RQ /
 * inclusion / exclusion / study_design）と、Sheets `Protocol` 行に必要な
 * source_type / source_filename / raw_text_* を保持する。
 */
export interface ProtocolDraft {
  frameworkType: 'pico' | 'peco' | 'pcc' | 'spider' | 'custom';
  researchQuestion: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  studyDesign: string;
  sourceType: 'manual' | 'markdown' | 'docx';
  sourceFilename: string | null;
  /** 元テキストの Drive 退避先 URL。manual 時 / Drive 退避前は null */
  rawTextRef: string | null;
  /** Sheets セル用プレビュー（先頭 500 文字） */
  rawTextPreview: string;
  /** manual 時のフォーム入力本文。md/docx は null（Drive 側が正本のため） */
  rawTextInline: string | null;
}

/**
 * 検証画面（#/validate）の検証結果。
 * LLM コスト集計（cumulativeCostUsd）等の setState による全ビュー再描画でも
 * 結果表示を失わないよう、ローカル DOM ではなく store に保持する。
 * formulaVersionId が currentFormulaVersionId と一致するときだけ有効
 * （別バージョンの stale な結果を表示しないため）。
 */
export interface ValidationResultEntry {
  formulaVersionId: string;
  summary: ValidationSummary;
}

/** 未捕捉 PMID の AI 原因分析結果（requirements.md §4.6）。stale 判定は ValidationResultEntry と同じ */
export interface MissedAnalysisEntry {
  formulaVersionId: string;
  result: AnalyzeMissedSeedsResult;
}

/**
 * 過大ヒット（> HIT_THRESHOLD 件）時の絞り込みフィルタ候補（requirements.md §4.4 / fix-plan 2-1）。
 * 検証完了時に総ヒット数が閾値を超えていたら proposeExcessFilters（LLM）で候補を取得し、
 * ここへ保存する。draft view はユーザー承認 UI として表示し、承認された候補だけ式へ追記する
 * （承認なしでは絶対に追加しない）。stale 判定は ValidationResultEntry と同じで、
 * formulaVersionId が currentFormulaVersionId と一致するときだけ有効。
 */
export interface ExcessFilterProposalEntry {
  formulaVersionId: string;
  /** 提案時点の最終検索式の総ヒット数 */
  totalHits: number;
  /** LLM が提案した候補フィルタ。error 時は空配列 */
  candidates: ExcessFilterCandidate[];
  /** 候補取得（LLM）に失敗したときのメッセージ。成功時は null */
  error: string | null;
}

/**
 * 検索式ドラフト「生成 → 検証」パイプライン（#/draft）の実行状態。
 * LLM コスト集計（cumulativeCostUsd）の setState による全ビュー再描画でも
 * 進捗・エラー表示を失わないよう、ローカル DOM ではなく store に保持する
 * （validationResult と同じ理由）。実行中は生成ボタンの二重クリック防止も兼ねる。
 *
 * phase は生成（generating）と、生成完了後に自動で続く検証（validating）の 2 段階。
 * blockHits は「ブロックが出来上がるごと」に計測したヒット数をライブ表示するためのもの。
 */

/**
 * 構造化進捗の 1 イベント。phase で生成／検証を判別し、それぞれの step 列挙を持つ。
 * 生成 = DraftProgress、検証 = ValidationProgress をそのまま内包する。
 */
export type DraftRunProgressDetail =
  | ({ phase: 'generating' } & DraftProgress)
  | ({ phase: 'validating' } & ValidationProgress);

export interface DraftRunState {
  status: 'running' | 'error';
  /** 実行中の段階。error 時は失敗した段階を保持する */
  phase: 'generating' | 'validating';
  /** 現在処理中ステップの表示用ラベル（例: 「MeSH を提案中（ブロック 1/2）」） */
  progressLabel: string;
  /**
   * 構造化進捗。progressLabel が「今やっていること」の 1 行表示なのに対し、
   * こちらは「パイプライン全体のどのステップにいるか」を view（進捗トラッカー /
   * プログレスバー）が算出するための生データ。未設定なら従来の 1 行表示のみ。
   */
  progress?: DraftRunProgressDetail | null;
  /** 経過時間表示用の開始時刻（epoch ms）。view が 1 秒ごとに再計算する */
  startedAtMs: number;
  /** status='error' のときのメッセージ。running 中は null */
  error: string | null;
  /** 生成途中に計測したブロックごとのヒット数（ライブ表示用） */
  blockHits: DraftBlockHit[];
}

/**
 * 対話的 seed 拡張（#/expand）の「境界事例を取得」実行状態。
 *
 * fetchBoundaryCandidates は最後に LLM（pick-boundary）を呼ぶため、その完了時に
 * LLM コスト集計（cumulativeCostUsd）の setState が走り、expand ビューも含めた全ビューが
 * 再描画される。進捗・取得結果をローカル DOM に書くとこの再描画で消えてしまうため、
 * draftRun / validationResult と同じく store に保持して再描画に耐えるようにする。
 *
 * - status='running': fetch 実行中。step が現在の段階（進捗トラッカー表示用）
 * - status='ready':   取得完了。result の候補を判定できる段階
 * - status='error':   いずれかの段階で失敗
 *
 * 候補の判定（recordDecision）とラウンド完了の再検証（runValidation）は LLM を呼ばず
 * setState を起こさない（= 再描画されない）ため、判定 UI 自体はビュー側のローカル状態で扱う。
 */
export interface ExpandRunState {
  status: 'running' | 'ready' | 'error';
  /** running 中は現在処理中の段階。ready は 'done' 相当、error は失敗した段階 */
  step: ExpandFetchStep | 'done';
  /** 経過時間表示用の開始時刻（epoch ms）。view が 1 秒ごとに再計算する */
  startedAtMs: number;
  /** status='error' のときのメッセージ。それ以外は null */
  error: string | null;
  /** status='ready' のときの取得結果（候補・ヒット数）。それ以外は null */
  result: BoundaryCasesResult | null;
}

/**
 * #/edit の動的保存（上書き）状態。編集のたびに走る overwriteCurrentFormula の進捗・結果を
 * draftRun などと同じく store に持たせ、保存完了時の setState（再描画）でも表示を失わないようにする。
 */
export interface EditAutoSaveState {
  status: 'saving' | 'saved' | 'error';
  /** 状態表示用メッセージ（例: 「✓ 上書き保存しました」「自動保存に失敗しました: …」） */
  message: string;
}

export interface AppState {
  /** 現在のハッシュルート */
  route: RouteName;
  /** 現在開いているプロジェクト。未選択なら null */
  project: CurrentProjectEntry | null;
  /** トップバー右側の累積コスト表示用（USD）。未集計なら null */
  cumulativeCostUsd: number | null;
  /** ブロック承認画面の編集中ドラフト。未開始なら null */
  blocksDraft: BlocksDraft | null;
  /** プロトコル本文のメタ情報。未開始なら null */
  protocolDraft: ProtocolDraft | null;
  /**
   * protocolDraft が Sheets の Protocol タブへ保存（承認）済みなら true。
   * submitProtocol で false に戻り、approveBlocks / 起動時 hydrate で true になる。
   * protocolView はこれを見て「読み取り専用表示」と「編集フォーム」を切り替える（§4.2）。
   */
  protocolDraftPersisted: boolean;
  /** blocksService.approveBlocks が採番した Protocol.version */
  currentProtocolVersion: number | null;
  /** draftService.generateDraft が採番した FormulaVersions.version_id */
  currentFormulaVersionId: string | null;
  /** 直近に生成 / 読み込んだ検索式の markdown */
  currentFormulaMarkdown: string | null;
  /** 検索式ドラフト生成の実行状態。未実行（完了済み含む）なら null */
  draftRun: DraftRunState | null;
  /** 境界事例取得（#/expand）の実行状態。未実行なら null */
  expandRun: ExpandRunState | null;
  /** 直近の検証結果。未実行なら null */
  validationResult: ValidationResultEntry | null;
  /** 未捕捉 PMID の AI 原因分析結果。未実行なら null */
  missedAnalysis: MissedAnalysisEntry | null;
  /** 過大ヒット時の絞り込みフィルタ候補（承認待ち）。未提案・承認/見送り済みなら null */
  excessFilterProposal: ExcessFilterProposalEntry | null;
  /** #/edit の動的保存（上書き）状態。未保存・別画面なら null */
  editAutoSave: EditAutoSaveState | null;
  /**
   * ブロック下書きバックアップ（chrome.storage.local）の保存時刻（ISO 8601）。
   * non-null なら「承認前の下書きが保存されている」= blocksView が未承認バナーを出す。
   * 保存（onSaveDraft）/ 起動時 hydrate の復元でセットし、承認・プロトコル再解析でクリアする。
   */
  blocksDraftSavedAt: string | null;
  /**
   * 起動時 hydrate（Sheets からの状態復元）の失敗メッセージ。
   * non-null のとき home / protocol にエラーバナー（再試行付き）を表示する。
   * Sheets の一時障害が「空プロジェクト」に見える事故を防ぐ（fix-plan 1-3）。
   */
  hydrateError: string | null;
}

export const INITIAL_STATE: AppState = {
  route: DEFAULT_ROUTE,
  project: null,
  cumulativeCostUsd: null,
  blocksDraft: null,
  protocolDraft: null,
  protocolDraftPersisted: false,
  currentProtocolVersion: null,
  currentFormulaVersionId: null,
  currentFormulaMarkdown: null,
  draftRun: null,
  expandRun: null,
  validationResult: null,
  missedAnalysis: null,
  excessFilterProposal: null,
  editAutoSave: null,
  blocksDraftSavedAt: null,
  hydrateError: null,
};

export type Updater = (prev: AppState) => AppState;

export interface AppStore {
  getState(): AppState;
  setState(updater: Updater): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState = INITIAL_STATE): AppStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state);
      if (next === state) {
        return;
      }
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
