import {
  MIN_BLOCK_COUNT,
  MAX_BLOCK_COUNT,
  type Protocol,
  type ProtocolBlock,
} from '@/domain/protocol';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, getSheetValues, type GoogleApiDeps } from '@/lib/google';

/**
 * Protocol / ProtocolBlocks タブの読み書き。
 * features/project の Meta タブと同じ方針で、列順は domain/sheetsSchema に従う。
 */

const PROTOCOL_HEADER = SHEET_HEADERS.Protocol;
const BLOCKS_HEADER = SHEET_HEADERS.ProtocolBlocks;

/**
 * 既存 Protocol タブから次に書き込むべき version 番号（既存最大 + 1、無ければ 1）を返す。
 */
export async function getNextProtocolVersion(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<number> {
  const rows = await getSheetValues(spreadsheetId, 'Protocol', deps);
  if (rows.length <= 1) {
    return 1;
  }
  const versionIdx = PROTOCOL_HEADER.indexOf('version');
  let max = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const cell = rows[i]?.[versionIdx];
    const n = Number.parseInt(cell ?? '', 10);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  return max + 1;
}

/**
 * Protocol タブに 1 行追記する。列順は SHEET_HEADERS.Protocol に固定。
 */
export async function appendProtocol(
  spreadsheetId: string,
  protocol: Protocol,
  deps: GoogleApiDeps
): Promise<void> {
  await appendRow(spreadsheetId, 'Protocol', toProtocolRow(protocol), deps);
}

/**
 * ProtocolBlocks タブに blocks の行数分まとめて追記する。
 * `version` は呼び出し側が一致させる責任を持つ（Protocol 側の version と同じ値）。
 */
export async function appendProtocolBlocks(
  spreadsheetId: string,
  version: number,
  blocks: readonly Omit<ProtocolBlock, 'version'>[],
  deps: GoogleApiDeps
): Promise<void> {
  if (blocks.length < MIN_BLOCK_COUNT || blocks.length > MAX_BLOCK_COUNT) {
    throw new Error(
      `ProtocolBlocks の件数が不正です: ${blocks.length}（許可: ${MIN_BLOCK_COUNT}〜${MAX_BLOCK_COUNT}）`
    );
  }
  for (const block of blocks) {
    await appendRow(
      spreadsheetId,
      'ProtocolBlocks',
      toProtocolBlockRow({ ...block, version }),
      deps
    );
  }
}

function toProtocolRow(protocol: Protocol): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    version: protocol.version,
    framework_type: protocol.frameworkType,
    research_question: protocol.researchQuestion,
    inclusion_criteria: protocol.inclusionCriteria,
    exclusion_criteria: protocol.exclusionCriteria,
    study_design: protocol.studyDesign,
    block_count: protocol.blockCount,
    combination_expression: protocol.combinationExpression,
    source_type: protocol.sourceType,
    source_filename: protocol.sourceFilename,
    raw_text_ref: protocol.rawTextRef,
    raw_text_preview: protocol.rawTextPreview,
    raw_text_inline: protocol.rawTextInline,
    created_at: protocol.createdAt,
    created_by: protocol.createdBy,
  };
  return PROTOCOL_HEADER.map((key) => map[key] ?? null);
}

function toProtocolBlockRow(block: ProtocolBlock): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    version: block.version,
    block_index: block.blockIndex,
    block_label: block.blockLabel,
    description: block.description,
    ai_generated: block.aiGenerated,
    note: block.note,
  };
  return BLOCKS_HEADER.map((key) => map[key] ?? null);
}
