import type { EutilsDeps } from '@/lib/ncbi';
import { resolvePmidByDoi } from '@/lib/ncbi';
import type { RisEntry } from './parseRis';

/**
 * 1 つの RisEntry から PMID を解決し、requirements.md §4.3 の
 * `ingest_format` を確定する。
 *
 * 判定順（最初にヒットしたもの優先）:
 * 1. DB タグが `PubMed` → `ris_pubmed`
 * 2. AN タグに PMID（純粋な数字）が入っている → `ris_pmid_field`
 * 3. DO タグで E-utilities から 1 件に解決できる → `ris_doi_resolved`
 * 4. いずれも失敗 → `ris_no_pmid`（pmid は null）
 */
export type RisIngestFormat =
  | 'ris_pubmed'
  | 'ris_pmid_field'
  | 'ris_doi_resolved'
  | 'ris_no_pmid';

export interface ResolvedRisEntry {
  pmid: string | null;
  ingestFormat: RisIngestFormat;
  originalDb: string | null;
  title: string | null;
  year: number | null;
  doi: string | null;
}

const PMID_PATTERN = /^\d+$/;

export async function resolveRisEntry(
  entry: RisEntry,
  deps: EutilsDeps
): Promise<ResolvedRisEntry> {
  // 1. DB = PubMed かつ AN に PMID
  if (entry.originalDb?.toLowerCase() === 'pubmed') {
    const anValue = entry.tags['AN']?.[0];
    if (anValue && PMID_PATTERN.test(anValue)) {
      return buildResolved(entry, anValue, 'ris_pubmed');
    }
  }

  // 2. AN タグが数字として正しい PMID
  const anValue = entry.tags['AN']?.[0];
  if (anValue && PMID_PATTERN.test(anValue)) {
    return buildResolved(entry, anValue, 'ris_pmid_field');
  }

  // 3. DOI から解決
  if (entry.doi) {
    const resolved = await resolvePmidByDoi(entry.doi, deps);
    if (resolved) {
      return buildResolved(entry, resolved, 'ris_doi_resolved');
    }
  }

  // 4. 解決不能
  return {
    pmid: null,
    ingestFormat: 'ris_no_pmid',
    originalDb: entry.originalDb,
    title: entry.title,
    year: entry.year,
    doi: entry.doi,
  };
}

function buildResolved(
  entry: RisEntry,
  pmid: string,
  ingestFormat: RisIngestFormat
): ResolvedRisEntry {
  return {
    pmid,
    ingestFormat,
    originalDb: entry.originalDb,
    title: entry.title,
    year: entry.year,
    doi: entry.doi,
  };
}
