import type { SeedPaper } from '@/domain/seedPaper';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, getSheetValues, type GoogleApiDeps } from '@/lib/google';

/**
 * SeedPapers タブの読み書き。requirements.md §3.1 / §4.3 に準拠。
 * 列順は SHEET_HEADERS.SeedPapers に固定。
 */

const HEADER = SHEET_HEADERS.SeedPapers;

/**
 * SeedPapers タブに 1 行追記する。
 */
export async function appendSeedPaper(
  spreadsheetId: string,
  seed: SeedPaper,
  deps: GoogleApiDeps
): Promise<void> {
  await appendRow(spreadsheetId, 'SeedPapers', toRow(seed), deps);
}

/**
 * 既存 SeedPapers を全件読み出す（ヘッダ除く）。
 * §4.3 の duplicate_pmid 判定や §4.6 の検証で使う。
 */
export async function listSeedPapers(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<SeedPaper[]> {
  const rows = await getSheetValues(spreadsheetId, 'SeedPapers', deps);
  if (rows.length <= 1) {
    return [];
  }
  return rows.slice(1).map(fromRow).filter((seed): seed is SeedPaper => seed !== null);
}

/**
 * 同 PMID の有効行が既に存在するか確認。
 * §4.3 の重複判定で呼ぶ。
 */
export async function hasValidSeedPmid(
  spreadsheetId: string,
  pmid: string,
  deps: GoogleApiDeps
): Promise<boolean> {
  const seeds = await listSeedPapers(spreadsheetId, deps);
  return seeds.some((seed) => seed.isValid && seed.pmid === pmid);
}

function toRow(seed: SeedPaper): (string | number | boolean | null)[] {
  const map: Record<string, string | number | boolean | null> = {
    pmid: seed.pmid,
    title: seed.title,
    year: seed.year,
    source: seed.source,
    ingest_format: seed.ingestFormat,
    original_db: seed.originalDb,
    is_valid: seed.isValid,
    exclusion_reason: seed.exclusionReason,
    original_payload_ref: seed.originalPayloadRef,
    user_decision: seed.userDecision,
    decided_at: seed.decidedAt,
    decided_by: seed.decidedBy,
    note: seed.note,
  };
  return HEADER.map((key) => map[key] ?? null);
}

function fromRow(row: readonly string[]): SeedPaper | null {
  const cell = (key: string): string => {
    const idx = HEADER.indexOf(key);
    /* istanbul ignore if -- 呼び出しは HEADER 内の固定キーしか渡さない */
    if (idx < 0) return '';
    return row[idx] ?? '';
  };
  const source = cell('source') === 'interactive' ? 'interactive' : 'initial';
  const ingest = cell('ingest_format');
  const ingestFormat: SeedPaper['ingestFormat'] = isIngestFormat(ingest) ? ingest : 'pmid_direct';
  const isValid = cell('is_valid').toLowerCase() === 'true';
  const exclusion = cell('exclusion_reason');
  const exclusionReason: SeedPaper['exclusionReason'] = isExclusionReason(exclusion)
    ? exclusion
    : null;
  const decisionRaw = cell('user_decision');
  const userDecision: SeedPaper['userDecision'] = isUserDecision(decisionRaw)
    ? decisionRaw
    : null;
  const yearStr = cell('year');
  const yearNum = yearStr === '' ? null : Number.parseInt(yearStr, 10);
  return {
    pmid: cell('pmid') === '' ? null : cell('pmid'),
    title: cell('title') === '' ? null : cell('title'),
    year: yearNum === null || !Number.isFinite(yearNum) ? null : yearNum,
    source,
    ingestFormat,
    originalDb: cell('original_db') === '' ? null : cell('original_db'),
    isValid,
    exclusionReason,
    originalPayloadRef:
      cell('original_payload_ref') === '' ? null : cell('original_payload_ref'),
    userDecision,
    decidedAt: cell('decided_at') === '' ? null : cell('decided_at'),
    decidedBy: cell('decided_by') === '' ? null : cell('decided_by'),
    note: cell('note') === '' ? null : cell('note'),
  };
}

function isIngestFormat(value: string): value is SeedPaper['ingestFormat'] {
  return [
    'pmid_direct',
    'nbib',
    'ris_pubmed',
    'ris_doi_resolved',
    'ris_pmid_field',
    'ris_no_pmid',
    'interactive',
  ].includes(value);
}

function isExclusionReason(
  value: string
): value is NonNullable<SeedPaper['exclusionReason']> {
  return ['pmid_not_found', 'duplicate_pmid', 'user_removed', 'no_pmid_resolved'].includes(value);
}

function isUserDecision(value: string): value is NonNullable<SeedPaper['userDecision']> {
  return value === 'include' || value === 'exclude' || value === 'maybe';
}
