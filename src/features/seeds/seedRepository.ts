import type { SeedPaper } from '@/domain/seedPaper';
import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { appendRow, getSheetValues, updateRow, type GoogleApiDeps } from '@/lib/google';

/**
 * SeedPapers の 1 行に、シート上の行番号（1 始まり。ヘッダが 1 行目）を添えたもの。
 * 論理削除（user_removed への書き換え）で行番号を指定するために使う。§4.3。
 */
export interface SeedPaperWithRow {
  seed: SeedPaper;
  /** シート上の行番号（1 始まり）。ヘッダ行が 1 なので、データ 1 件目は 2 */
  rowIndex: number;
}

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
 * 既存 SeedPapers を、シート上の行番号付きで全件読み出す（ヘッダ除く）。
 * §4.3 の無効化（user_removed）で行番号を指定して書き換えるために使う。
 *
 * 行番号はヘッダ（1 行目）を含めた 1 始まりで、データ 1 件目は 2 になる。
 * `fromRow` で SeedPaper に変換できなかった行（空行など）はスキップする。
 */
export async function listSeedPapersWithRows(
  spreadsheetId: string,
  deps: GoogleApiDeps
): Promise<SeedPaperWithRow[]> {
  const rows = await getSheetValues(spreadsheetId, 'SeedPapers', deps);
  if (rows.length <= 1) {
    return [];
  }
  const out: SeedPaperWithRow[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const seed = fromRow(rows[i] ?? []);
    if (seed !== null) {
      // rows のインデックス i は 0 始まり。シート行番号は 1 始まりなので i + 1。
      out.push({ seed, rowIndex: i + 1 });
    }
  }
  return out;
}

/**
 * 指定行番号の seed を `is_valid=false, exclusion_reason=user_removed` に書き換える（論理削除）。
 * §4.3「押下時の挙動は当該行を書き換えるだけで、行自体は残す」。
 *
 * 行追加ではなく既存行の上書きなので、呼び出し側は `listSeedPapersWithRows` の
 * rowIndex を渡すこと。書き換え後の seed をそのまま返す。
 */
export async function invalidateSeedRow(
  spreadsheetId: string,
  rowIndex: number,
  seed: SeedPaper,
  deps: GoogleApiDeps
): Promise<SeedPaper> {
  const updated: SeedPaper = {
    ...seed,
    isValid: false,
    exclusionReason: 'user_removed',
  };
  await updateRow(spreadsheetId, 'SeedPapers', rowIndex, toRow(updated), deps);
  return updated;
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

/**
 * 同 PMID が「重複扱い」になる行を既に持っているか確認。§4.3 の重複判定。
 *
 * 重複と見なすのは次のいずれかの行が存在する場合：
 * - `is_valid=true` の同 PMID 行（既に有効登録済み）
 * - `exclusion_reason=user_removed` の同 PMID 行（ユーザーが一度無効化した事実を監査ログに残すため）
 *
 * 一方、次の無効行は重複判定に含めない（既存挙動を維持）：
 * - `exclusion_reason=pmid_not_found`: 「再試行」で同 PMID を再 ingest し、見つかれば
 *   新規有効行を作る前提のため。これを重複扱いにすると再試行が常に duplicate_pmid 化してしまう
 * - `exclusion_reason=duplicate_pmid`: 重複行自体を起点に二重カウントしないため
 * - `exclusion_reason=no_pmid_resolved`（pmid=null）: そもそも PMID を持たない
 */
export async function hasDuplicateSeedPmid(
  spreadsheetId: string,
  pmid: string,
  deps: GoogleApiDeps
): Promise<boolean> {
  const seeds = await listSeedPapers(spreadsheetId, deps);
  return seeds.some(
    (seed) =>
      seed.pmid === pmid &&
      (seed.isValid || seed.exclusionReason === 'user_removed')
  );
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
