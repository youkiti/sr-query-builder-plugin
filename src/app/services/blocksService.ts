import type { Protocol, ProtocolBlock } from '@/domain/protocol';
import {
  appendProtocol,
  appendProtocolBlocks,
  getNextProtocolVersion,
} from '@/features/protocol';
import { getCurrentUserEmail, type GoogleApiDeps, type ProfileDeps } from '@/lib/google';
import { nowIso } from '@/utils/iso8601';
import type { AppStore, BlocksDraft, ProtocolDraft } from '../store';

/**
 * ブロック承認画面の「承認してシード論文へ」ボタンが押されたときの処理。
 *
 * 1. store の protocolDraft + blocksDraft を Sheets `Protocol` / `ProtocolBlocks` に追記
 * 2. version は Protocol タブの既存最大 + 1
 * 3. 完了したら（呼び出し側で）`/seeds` 画面へナビ。本サービスはナビ自体は持たない
 */

export interface BlocksServiceDeps {
  google: GoogleApiDeps;
  profile: ProfileDeps;
  store: AppStore;
  /** テスト時に差し替え可能な現在時刻 */
  now?: () => string;
}

export interface ApprovedProtocol {
  version: number;
  protocol: Protocol;
  blocks: ProtocolBlock[];
}

/**
 * blocksDraft + protocolDraft を Sheets に書き込む。
 * 戻り値は書き込んだ Protocol 行と ProtocolBlock 行（呼び出し側のログ・遷移用）。
 */
export async function approveBlocks(deps: BlocksServiceDeps): Promise<ApprovedProtocol> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  if (state.protocolDraft === null) {
    throw new Error('protocolDraft が未設定です。先にプロトコル入力を済ませてください');
  }
  if (state.blocksDraft === null || state.blocksDraft.blocks.length === 0) {
    throw new Error('blocksDraft が未設定です。ブロックを 1 つ以上作成してください');
  }
  const spreadsheetId = state.project.spreadsheetId;
  const version = await getNextProtocolVersion(spreadsheetId, deps.google);
  const createdAt = (deps.now ?? nowIso)();
  const createdBy = (await getCurrentUserEmail(deps.profile)) ?? '';
  const protocol = buildProtocol({
    version,
    protocolDraft: state.protocolDraft,
    blocksDraft: state.blocksDraft,
    createdAt,
    createdBy,
  });
  const blocks = buildBlocks({
    version,
    blocksDraft: state.blocksDraft,
  });
  await appendProtocol(spreadsheetId, protocol, deps.google);
  await appendProtocolBlocks(spreadsheetId, version, blocks, deps.google);
  // 新しい Protocol.version が確定したので、旧プロトコル由来の検索式系状態は
  // リセットしてブロック以降をやり直させる（requirements.md §4.2）。
  // 旧検索式は FormulaVersions に protocol_version 付きで残るため失われない。
  deps.store.setState((s) => ({
    ...s,
    currentProtocolVersion: version,
    protocolDraftPersisted: true,
    currentFormulaVersionId: null,
    currentFormulaMarkdown: null,
    validationResult: null,
    missedAnalysis: null,
  }));
  return { version, protocol, blocks };
}

function buildProtocol(args: {
  version: number;
  protocolDraft: ProtocolDraft;
  blocksDraft: BlocksDraft;
  createdAt: string;
  createdBy: string;
}): Protocol {
  return {
    version: args.version,
    frameworkType: args.protocolDraft.frameworkType,
    researchQuestion: args.protocolDraft.researchQuestion,
    inclusionCriteria: emptyToNull(args.protocolDraft.inclusionCriteria),
    exclusionCriteria: emptyToNull(args.protocolDraft.exclusionCriteria),
    studyDesign: emptyToNull(args.protocolDraft.studyDesign),
    blockCount: args.blocksDraft.blocks.length,
    combinationExpression: args.blocksDraft.combinationExpression,
    sourceType: args.protocolDraft.sourceType,
    sourceFilename: args.protocolDraft.sourceFilename,
    rawTextRef: args.protocolDraft.rawTextRef,
    rawTextPreview: args.protocolDraft.rawTextPreview === '' ? null : args.protocolDraft.rawTextPreview,
    rawTextInline: args.protocolDraft.rawTextInline,
    createdAt: args.createdAt,
    createdBy: args.createdBy,
  };
}

function buildBlocks(args: { version: number; blocksDraft: BlocksDraft }): ProtocolBlock[] {
  return args.blocksDraft.blocks.map((block, i) => ({
    version: args.version,
    blockIndex: i + 1,
    blockLabel: block.blockLabel,
    description: block.description,
    aiGenerated: block.aiGenerated,
    note: block.note === '' ? null : block.note,
  }));
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
