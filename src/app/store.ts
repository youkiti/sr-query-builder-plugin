import type { CurrentProjectEntry } from '@/features/project';
import type {
  AnalyzeMissedSeedsResult,
  ValidationSummary,
} from './services/validationService';
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
  /** blocksService.approveBlocks が採番した Protocol.version */
  currentProtocolVersion: number | null;
  /** draftService.generateDraft が採番した FormulaVersions.version_id */
  currentFormulaVersionId: string | null;
  /** 直近に生成 / 読み込んだ検索式の markdown */
  currentFormulaMarkdown: string | null;
  /** 直近の検証結果。未実行なら null */
  validationResult: ValidationResultEntry | null;
  /** 未捕捉 PMID の AI 原因分析結果。未実行なら null */
  missedAnalysis: MissedAnalysisEntry | null;
}

export const INITIAL_STATE: AppState = {
  route: DEFAULT_ROUTE,
  project: null,
  cumulativeCostUsd: null,
  blocksDraft: null,
  protocolDraft: null,
  currentProtocolVersion: null,
  currentFormulaVersionId: null,
  currentFormulaMarkdown: null,
  validationResult: null,
  missedAnalysis: null,
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
