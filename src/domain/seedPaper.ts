/**
 * SeedPapers タブに対応する型。
 * requirements.md §3.1 / §4.3 参照。
 */

export type SeedSource = 'initial' | 'interactive';

export type SeedIngestFormat =
  | 'pmid_direct'
  | 'nbib'
  | 'ris_pubmed'
  | 'ris_doi_resolved'
  | 'ris_pmid_field'
  | 'ris_no_pmid'
  | 'interactive';

export type SeedExclusionReason =
  | 'pmid_not_found'
  | 'duplicate_pmid'
  | 'user_removed'
  | 'user_disabled'
  | 'no_pmid_resolved';

export type SeedUserDecision = 'include' | 'exclude' | 'maybe';

export interface SeedPaper {
  pmid: string | null;
  title: string | null;
  year: number | null;
  source: SeedSource;
  ingestFormat: SeedIngestFormat;
  originalDb: string | null;
  isValid: boolean;
  exclusionReason: SeedExclusionReason | null;
  originalPayloadRef: string | null;
  userDecision: SeedUserDecision | null;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

/** 検証ロジックで対象とする seed のフィルタ条件（§4.5 参照） */
export function isSeedEligibleForValidation(seed: SeedPaper): boolean {
  if (!seed.isValid) {
    return false;
  }
  if (seed.pmid === null) {
    return false;
  }
  // interactive で exclude / maybe は対象外。initial では null（未判定）も対象とする
  if (seed.userDecision === 'exclude' || seed.userDecision === 'maybe') {
    return false;
  }
  return true;
}
