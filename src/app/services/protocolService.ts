import {
  parseDocxFile,
  parseManualProtocol,
  parseMarkdownFile,
  type DocxExtractor,
  type DocxFileInput,
  type MarkdownFileInput,
  type ParsedProtocolFile,
} from '@/features/protocol';
import { extractProtocol } from '@/features/formula/skills';
import type { LLMProvider } from '@/lib/llm';
import type { AppStore, BlockDraft, BlocksDraft, ProtocolDraft } from '../store';

/**
 * プロトコル入力フォームの送信を扱うサービス。
 * UI 層（views/protocolView）から 1 関数で叩けるようにする。
 *
 * - 手入力 / .md / .docx の 3 系統を統一して `ParsedProtocolFile` に揃える
 * - extract-protocol skill を呼んで構造化ブロック案を作る
 * - 結果を `app/store` の `blocksDraft` に書き込み、UI 側のナビは callback に渡す
 *
 * 実 LLM への接続（GeminiProvider 等）は呼び出し側で組み立てて渡す。
 */

export interface ProtocolSubmissionInput {
  sourceType: 'manual' | 'markdown' | 'docx';
  /**
   * 手入力時のプロトコル全文。markdown/docx 時は無視される。
   * RQ / 組入/除外基準は `extract-protocol` skill が本文から抽出する。
   */
  inlineText?: string;
  /** markdown ファイル入力。markdown 時必須 */
  markdownFile?: MarkdownFileInput;
  /** docx ファイル入力。docx 時必須 */
  docxFile?: DocxFileInput;
  /** docx パース用の extractor。docx 時必須 */
  docxExtractor?: DocxExtractor;
}

export interface ProtocolServiceDeps {
  store: AppStore;
  provider: LLMProvider;
}

export interface ProtocolSubmissionResult {
  parsed: ParsedProtocolFile;
  blocksDraft: BlocksDraft;
  protocolDraft: ProtocolDraft;
}

/**
 * ファイル種別に応じてパースし、extract-protocol を呼び、blocksDraft +
 * protocolDraft を組み立てて store を上書きする。
 *
 * - blocksDraft はブロック編集 UI が消費
 * - protocolDraft は blocksService が Protocol タブへ書き込む際に消費
 */
export async function submitProtocol(
  input: ProtocolSubmissionInput,
  deps: ProtocolServiceDeps
): Promise<ProtocolSubmissionResult> {
  const parsed = await parseInput(input);
  const draft = await extractProtocol(parsed.plainText, deps.provider);
  const blocksDraft: BlocksDraft = {
    blocks: draft.blocks.map(toBlockDraft),
    combinationExpression: draft.combinationExpression,
  };
  const protocolDraft: ProtocolDraft = {
    frameworkType: draft.frameworkType,
    researchQuestion: draft.researchQuestion,
    inclusionCriteria: draft.inclusionCriteria,
    exclusionCriteria: draft.exclusionCriteria,
    studyDesign: draft.studyDesign,
    sourceType: parsed.sourceType,
    sourceFilename: parsed.sourceFilename === '' ? null : parsed.sourceFilename,
    rawTextRef: null, // Drive 退避は wiring 層で別途実装する
    rawTextPreview: parsed.preview,
    rawTextInline: parsed.sourceType === 'manual' ? parsed.plainText : null,
  };
  // 新しい draft はまだ Sheets に保存されていないので persisted を false に戻す
  // （ブロック承認 = approveBlocks で true になる）
  deps.store.setState((s) => ({
    ...s,
    blocksDraft,
    protocolDraft,
    protocolDraftPersisted: false,
  }));
  return { parsed, blocksDraft, protocolDraft };
}

async function parseInput(input: ProtocolSubmissionInput): Promise<ParsedProtocolFile> {
  switch (input.sourceType) {
    case 'manual':
      return parseManualProtocol(input.inlineText ?? '');
    case 'markdown': {
      if (!input.markdownFile) {
        throw new Error('markdown ファイルが選択されていません');
      }
      return parseMarkdownFile(input.markdownFile);
    }
    case 'docx': {
      if (!input.docxFile) {
        throw new Error('.docx ファイルが選択されていません');
      }
      if (!input.docxExtractor) {
        throw new Error('.docx パーサ（DocxExtractor）が注入されていません');
      }
      return parseDocxFile(input.docxFile, input.docxExtractor);
    }
  }
}

function toBlockDraft(block: { blockLabel: string; description: string }): BlockDraft {
  return {
    blockLabel: block.blockLabel,
    description: block.description,
    aiGenerated: true,
    note: '',
  };
}
