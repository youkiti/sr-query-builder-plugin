import {
  MIN_BLOCK_COUNT,
  MAX_BLOCK_COUNT,
  type Protocol,
  type FrameworkType,
  type ProtocolSourceType,
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
 * Protocol タブの最新行（末尾）を返す。1 件も無ければ null。
 */
export async function getLatestProtocol(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<Protocol | null> {
  const rows = await getSheetValues(spreadsheetId, 'Protocol', deps);
  if (rows.length <= 1) {
    return null;
  }
  const dataRows = rows.slice(1);
  const last = dataRows[dataRows.length - 1];
  if (!last) {
    return null;
  }
  return fromProtocolRow(last);
}

/**
 * 指定した version の Protocol 行を返す。存在しなければ null。
 */
export async function getProtocolByVersion(
  spreadsheetId: string,
  version: number,
  deps: GoogleApiDeps
): Promise<Protocol | null> {
  const rows = await getSheetValues(spreadsheetId, 'Protocol', deps);
  if (rows.length <= 1) {
    return null;
  }
  const versionIdx = PROTOCOL_HEADER.indexOf('version');
  /* istanbul ignore if -- HEADER に version は必ず含まれる */
  if (versionIdx < 0) {
    return null;
  }
  for (const row of rows.slice(1)) {
    const cell = row?.[versionIdx] ?? '';
    if (Number.parseInt(cell, 10) === version) {
      return fromProtocolRow(row);
    }
  }
  return null;
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

function fromProtocolRow(row: readonly string[]): Protocol {
  const cell = (key: string): string => {
    const idx = PROTOCOL_HEADER.indexOf(key);
    /* istanbul ignore if -- 呼び出しは固定キーのみ */
    if (idx < 0) return '';
    return row[idx] ?? '';
  };
  const version = Number.parseInt(cell('version'), 10);
  const blockCount = Number.parseInt(cell('block_count'), 10);
  return {
    version: Number.isFinite(version) ? version : 0,
    frameworkType: parseFrameworkType(cell('framework_type')),
    researchQuestion: cell('research_question'),
    inclusionCriteria: emptyToNull(cell('inclusion_criteria')),
    exclusionCriteria: emptyToNull(cell('exclusion_criteria')),
    studyDesign: emptyToNull(cell('study_design')),
    blockCount: Number.isFinite(blockCount) ? blockCount : 0,
    combinationExpression: cell('combination_expression'),
    sourceType: parseSourceType(cell('source_type')),
    sourceFilename: emptyToNull(cell('source_filename')),
    rawTextRef: emptyToNull(cell('raw_text_ref')),
    rawTextPreview: emptyToNull(cell('raw_text_preview')),
    rawTextInline: emptyToNull(cell('raw_text_inline')),
    createdAt: cell('created_at'),
    createdBy: cell('created_by'),
  };
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function parseFrameworkType(value: string): FrameworkType {
  return ['pico', 'peco', 'pcc', 'spider', 'custom'].includes(value)
    ? (value as FrameworkType)
    : null;
}

function parseSourceType(value: string): ProtocolSourceType {
  return value === 'markdown' || value === 'docx' ? value : 'manual';
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
