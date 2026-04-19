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
  /** 手入力時の RQ。省略可 */
  researchQuestion?: string;
  /** 手入力時の組入基準（改行区切り） */
  inclusionCriteria?: string;
  /** 手入力時の除外基準（改行区切り） */
  exclusionCriteria?: string;
  /** 手入力時のプロトコル本文。markdown/docx 時は無視される */
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
  const protocolText = composeProtocolText(input, parsed.plainText);
  const draft = await extractProtocol(protocolText, deps.provider);
  const blocksDraft: BlocksDraft = {
    blocks: draft.blocks.map(toBlockDraft),
    combinationExpression: draft.combinationExpression,
  };
  const protocolDraft: ProtocolDraft = {
    frameworkType: draft.frameworkType,
    researchQuestion: draft.researchQuestion || (input.researchQuestion?.trim() ?? ''),
    inclusionCriteria:
      draft.inclusionCriteria || (input.inclusionCriteria?.trim() ?? ''),
    exclusionCriteria:
      draft.exclusionCriteria || (input.exclusionCriteria?.trim() ?? ''),
    studyDesign: draft.studyDesign,
    sourceType: parsed.sourceType,
    sourceFilename: parsed.sourceFilename === '' ? null : parsed.sourceFilename,
    rawTextRef: null, // Drive 退避は wiring 層で別途実装する
    rawTextPreview: parsed.preview,
    rawTextInline: parsed.sourceType === 'manual' ? parsed.plainText : null,
  };
  deps.store.setState((s) => ({ ...s, blocksDraft, protocolDraft }));
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

/**
 * 手入力のフォームフィールド（RQ / inclusion / exclusion）を本文に合体させて
 * extract-protocol へ渡す 1 つのテキストにする。
 * markdown/docx は元テキストをそのまま使う（フォーム側のフィールドは無視）。
 */
function composeProtocolText(input: ProtocolSubmissionInput, plainText: string): string {
  if (input.sourceType !== 'manual') {
    return plainText;
  }
  const parts: string[] = [];
  if (input.researchQuestion?.trim()) {
    parts.push(`# Research Question\n${input.researchQuestion.trim()}`);
  }
  if (input.inclusionCriteria?.trim()) {
    parts.push(`## Inclusion Criteria\n${input.inclusionCriteria.trim()}`);
  }
  if (input.exclusionCriteria?.trim()) {
    parts.push(`## Exclusion Criteria\n${input.exclusionCriteria.trim()}`);
  }
  if (plainText.trim()) {
    parts.push(`## Protocol Body\n${plainText.trim()}`);
  }
  return parts.join('\n\n');
}

function toBlockDraft(block: { blockLabel: string; description: string }): BlockDraft {
  return {
    blockLabel: block.blockLabel,
    description: block.description,
    aiGenerated: true,
    note: '',
  };
}
