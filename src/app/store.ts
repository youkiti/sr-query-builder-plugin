import type { CurrentProjectEntry } from '@/features/project';
import type { FormulaCreatedBy } from '@/domain/formulaVersion';
import type { ExcessFilterCandidate } from '@/features/formula/skills';
import type {
  AnalyzeMissedSeedsResult,
  ValidationProgress,
  ValidationSummary,
} from './services/validationService';
import type { DraftBlockHit, DraftProgress } from './services/draftService';
import type { BoundaryCasesResult, ExpandFetchStep } from './services/expandService';
import type { BlockImprovementResult } from './services/editService';
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
 * 検索式手編集画面（#/edit）で編集中の markdown 全文。
 *
 * editView は textarea を出さず、md 全文をコントローラのローカル変数（旧 `currentMd`）に
 * 持つ構造だった。しかし LLM コスト集計（cumulativeCostUsd）の setState は全ビューを
 * 無条件に再描画し、editView は再描画のたびに `container.innerHTML = ''` で丸ごと作り直す
 * ため、ローカル変数に置いた編集内容は再描画のたびに元の `currentFormulaMarkdown` へ
 * 巻き戻ってしまう（issue #39）。draftRun / validationResult と同じく store に置くことで
 * 再描画に耐えるようにする。
 *
 * formulaVersionId が currentFormulaVersionId と一致するときだけ有効
 * （別バージョンを読み込み直した後に古い draft を表示しないため。ValidationResultEntry と同じ判定）。
 */
export interface FormulaEditDraft {
  formulaVersionId: string;
  markdown: string;
}

/**
 * #/edit のブロック単位 AI 改善（requirements.md §4.7）の実行状態。同時に 1 ブロックのみ。
 *
 * improve-block skill は LLM を呼ぶため、完了時に LLM コスト集計（cumulativeCostUsd）の
 * setState が走り、editView も含めた全ビューが再描画される。提案・進捗・エラーをローカル
 * DOM（旧コードは Promise の `.then()` で受け取ったスロット要素に直接書き込んでいた）に
 * 保持すると、この再描画で該当スロットが DOM ツリーから切り離され、提案が届いても画面に
 * 何も反映されない（issue #39 の本体）。draftRun / expandRun と同じく store に保持して
 * 再描画に耐えるようにする。
 *
 * formulaVersionId が currentFormulaVersionId と一致するときだけ有効
 * （別バージョンの stale な提案を表示しないため。ValidationResultEntry と同じ判定）。
 */
export interface BlockImprovementState {
  formulaVersionId: string;
  blockId: string;
  status: 'running' | 'ready' | 'error';
  /** status='ready' のときの提案。それ以外は null */
  result: BlockImprovementResult | null;
  /** status='error' のときのメッセージ。それ以外は null */
  error: string | null;
}

/**
 * #/edit の「新バージョンとして保存」の実行状態。
 *
 * 保存（saveEditedFormula）は完了時に `currentFormulaVersionId` / `currentFormulaMarkdown` の
 * setState を起こし、それが全ビュー再描画を誘発する（editView は再描画のたびに
 * `container.innerHTML = ''` で丸ごと作り直す）。確認メッセージ・エラーをローカル DOM に
 * 書くとこの再描画で要素ごと消え、「押しても何も起きていない」ように見える（issue #42）。
 * formulaEditDraft / blockImprovement と同じく store に保持して再描画に耐えるようにする。
 *
 * formulaVersionId が currentFormulaVersionId と一致するときだけ有効。
 * 保持する版は status で異なる:
 * - `saving` / `error`: 保存前（＝編集元）の版。保存中もエラー後も current は変わらないので一致する
 * - `saved`: 保存で**採番された新しい版**。保存成功時に current がこの版へ移るので一致する。
 *   `保存しました（version_id: …）` に出す ID もこの値そのもの
 * 別バージョンを履歴から読み込み直すと一致しなくなり、stale として表示されなくなる。
 */
export interface FormulaSaveState {
  formulaVersionId: string;
  status: 'saving' | 'saved' | 'error';
  /** status='error' のときのメッセージ。それ以外は null */
  error: string | null;
}

/**
 * #/edit の編集メモ（`input.edit__note-input`）。
 *
 * 保存ステータスと同じ理由で、ローカル DOM に置くと全ビュー再描画で入力内容が消える。
 * 打鍵のたび（input イベント）に store.setStateSilently で書き込む。silent 更新は購読者へ
 * 通知しない＝再描画を起こさないため、開いている鉛筆編集フォームや AI 指示欄を打鍵ごとに
 * 壊すことなく、かつ他の再描画（保存・AI 改善等）が起きても入力内容が state から復元できる
 * （旧実装は change イベント＝blur/Enter でだけ通常の setState を行っていたが、これだと
 * 「メモを打った直後に隣接ボタンを押す」操作で押下の mousedown が change の再描画に巻き込まれ
 * DOM から切り離され、1 回目のクリックが飲まれる回帰を生んだ。詳細は setStateSilently の
 * doc コメントと issue #42 / その回帰の顛末を参照）。
 *
 * stale 判定は FormulaEditDraft と同じ。保存に成功すると版が変わって stale になるため、
 * メモは自動的に空へ戻る（＝次の編集に前回のメモが残らない）。
 */
export interface FormulaEditNote {
  formulaVersionId: string;
  note: string;
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
  /**
   * 現在の検索式の下書きを支援した LLM モデル ID（FormulaVersions.model 由来）。
   * export 画面の Methods 文案に埋め込む。model 列導入前の旧バージョンでは null
   */
  currentFormulaModel: string | null;
  /**
   * 現在の検索式が AI 生成そのまま（`ai_draft`）か、AI 生成結果に手を加えて保存した版
   * （`user_edit`）かを表す（FormulaVersions.created_by 由来）。`user_edit` になる経路は
   * #/edit の手編集保存だけでなく、過大ヒットフィルタ承認（bootstrap.ts の
   * runApplyExcessFilters が内部で saveEditedFormula を呼ぶ）も含む。issue #40:
   * draftView が「再生成すると手を加えた版が破棄される」ことをこの値で判定し、
   * `user_edit` のときだけ再生成前に破棄確認を挟む（確認文言は経路を特定しない表現に
   * すること）。currentFormulaModel と同様に版の切り替え・リセット箇所すべてで同期して
   * 設定する
   */
  currentFormulaCreatedBy: FormulaCreatedBy | null;
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
  /** #/edit で編集中の検索式 markdown 全文。未編集（未読込含む）なら null */
  formulaEditDraft: FormulaEditDraft | null;
  /** #/edit のブロック単位 AI 改善の実行状態。未実行なら null */
  blockImprovement: BlockImprovementState | null;
  /** #/edit の「新バージョンとして保存」の実行状態。未実行なら null */
  formulaSave: FormulaSaveState | null;
  /** #/edit の編集メモ。未入力なら null */
  formulaEditNote: FormulaEditNote | null;
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
  currentFormulaModel: null,
  currentFormulaCreatedBy: null,
  draftRun: null,
  expandRun: null,
  validationResult: null,
  missedAnalysis: null,
  excessFilterProposal: null,
  formulaEditDraft: null,
  blockImprovement: null,
  formulaSave: null,
  formulaEditNote: null,
  blocksDraftSavedAt: null,
  hydrateError: null,
};

export type Updater = (prev: AppState) => AppState;

export interface AppStore {
  getState(): AppState;
  setState(updater: Updater): void;
  /**
   * setState と同じく `updater(state)` の結果で state を差し替えるが、購読者（render）へは
   * 通知しない＝再描画を起こさない。
   *
   * **使ってよい場面は限定的**: その state を描画に使っているのが単一ビューで、かつ
   * 「次にそのビューが（他の理由で）再描画されたときに state から読み直せば十分」な、
   * 入力途中の値の保持だけに限る。他のビュー・コンポーネントがこの state 変化を見て
   * 何かをしなければならない場合は絶対に使わないこと。通知を飛ばすため、購読側は
   * 明示的に読み直すまで変化に気づけず、「更新したのに画面が反映されない」不具合の
   * 温床になる。
   *
   * 典型例: #/edit の編集メモ（`formulaEditNote`）。打鍵ごとに setState すると全ビュー
   * 再描画（editView は `container.innerHTML = ''` で丸ごと作り直す）が毎回走り、
   * 開いている鉛筆編集フォームや AI 指示欄を壊すだけでなく、押下寸前の別ボタンの
   * mousedown がその再描画に巻き込まれて DOM から切り離され、click が合成されない
   * （＝クリックが 1 回丸ごと無視される）副作用まで生む。メモは editView 自身だけが
   * 表示し、次の再描画時に state から読み直せば足りるため、silent 更新で十分。
   */
  setStateSilently(updater: Updater): void;
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
    setStateSilently: (updater) => {
      const next = updater(state);
      if (next === state) {
        return;
      }
      state = next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
