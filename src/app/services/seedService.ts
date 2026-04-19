import type { SeedPaper } from '@/domain/seedPaper';
import {
  appendSeedPaper,
  hasValidSeedPmid,
  parseNbib,
  parseRis,
  resolveRisEntry,
  verifyPmids,
  type NbibEntry,
  type RisEntry,
  type ResolvedRisEntry,
} from '@/features/seeds';
import type { EutilsDeps } from '@/lib/ncbi';
import { ensureChildFolder, uploadTextFile, type GoogleApiDeps } from '@/lib/google';
import { newUuid } from '@/utils/uuid';
import type { AppStore } from '../store';

/**
 * シード論文 ingest サービス。
 * requirements.md §4.3 の 3 経路（PMID 直接入力 / NBIB / RIS）を
 * 統一した入口で扱い、結果を SeedPapers タブに追記する。
 *
 * - 全経路で E-utilities の存在確認を必ず走らせ、is_valid フラグで検証対象外を表す
 * - 重複 PMID は is_valid=false, exclusion_reason=duplicate_pmid として追記（上書きしない）
 * - RIS の `ris_no_pmid` も SeedPapers に残し、元 RIS エントリ本体は Drive に退避する
 */

export type IngestInputMode = 'pmid_direct' | 'nbib' | 'ris';

export interface IngestPmidInput {
  mode: 'pmid_direct';
  pmids: string[];
}

export interface IngestNbibInput {
  mode: 'nbib';
  text: string;
}

export interface IngestRisInput {
  mode: 'ris';
  text: string;
}

export type IngestInput = IngestPmidInput | IngestNbibInput | IngestRisInput;

export interface IngestSummary {
  registered: number;
  valid: number;
  invalid: number;
  reasons: Record<'pmid_not_found' | 'duplicate_pmid' | 'no_pmid_resolved' | 'other', number>;
  added: SeedPaper[];
}

export interface SeedServiceDeps {
  google: GoogleApiDeps;
  eutils: EutilsDeps;
  store: AppStore;
  newUuid?: () => string;
  now?: () => string;
}

const INITIAL_SUMMARY = (): IngestSummary => ({
  registered: 0,
  valid: 0,
  invalid: 0,
  reasons: { pmid_not_found: 0, duplicate_pmid: 0, no_pmid_resolved: 0, other: 0 },
  added: [],
});

/**
 * 3 経路すべてを扱う統一 ingest エントリ。
 */
export async function ingestSeeds(
  input: IngestInput,
  deps: SeedServiceDeps
): Promise<IngestSummary> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  const spreadsheetId = state.project.spreadsheetId;
  const summary = INITIAL_SUMMARY();

  if (input.mode === 'pmid_direct') {
    await ingestPmidBatch(spreadsheetId, input.pmids, 'pmid_direct', null, deps, summary);
    return summary;
  }
  if (input.mode === 'nbib') {
    const entries = parseNbib(input.text);
    const pmids = entries
      .map((e) => e.pmid)
      .filter((v): v is string => v !== null && v !== '');
    await ingestPmidBatch(spreadsheetId, pmids, 'nbib', null, deps, summary);
    return summary;
  }
  // ris
  const risEntries = parseRis(input.text);
  for (const entry of risEntries) {
    const resolved = await resolveRisEntry(entry, deps.eutils);
    if (resolved.pmid !== null) {
      await ingestPmidBatch(
        spreadsheetId,
        [resolved.pmid],
        resolved.ingestFormat,
        resolved.originalDb,
        deps,
        summary
      );
    } else {
      const originalPayloadRef = await uploadSkippedRisEntry(
        entry,
        state.project.driveFolderId,
        deps
      );
      const seed = buildNoPmidSeed(resolved, originalPayloadRef, deps);
      await appendSeedPaper(spreadsheetId, seed, deps.google);
      summary.registered += 1;
      summary.invalid += 1;
      summary.reasons.no_pmid_resolved += 1;
      summary.added.push(seed);
    }
  }
  return summary;
}

async function ingestPmidBatch(
  spreadsheetId: string,
  pmids: readonly string[],
  ingestFormat: SeedPaper['ingestFormat'],
  originalDb: string | null,
  deps: SeedServiceDeps,
  summary: IngestSummary
): Promise<void> {
  // `now` は §4.5 の interactive ingest で decided_at を埋めるために予約。
  // 初期登録（source=initial）では decided_at は常に null なので現時点では使わない。
  void deps.now;
  const uniqueInput = dedupePreserveOrder(pmids);
  const existing = new Set<string>();
  // 既に有効 PMID が存在する場合は duplicate_pmid で記録（§4.3）
  for (const pmid of uniqueInput) {
    if (await hasValidSeedPmid(spreadsheetId, pmid, deps.google)) {
      existing.add(pmid);
    }
  }
  const toVerify = uniqueInput.filter((pmid) => !existing.has(pmid));
  const verifications = await verifyPmids(toVerify, deps.eutils);
  const results = new Map(verifications.map((v) => [v.pmid, v]));

  for (const pmid of uniqueInput) {
    if (existing.has(pmid)) {
      const seed: SeedPaper = {
        pmid,
        title: null,
        year: null,
        source: 'initial',
        ingestFormat,
        originalDb,
        isValid: false,
        exclusionReason: 'duplicate_pmid',
        originalPayloadRef: null,
        userDecision: null,
        decidedAt: null,
        decidedBy: null,
        note: null,
      };
      await appendSeedPaper(spreadsheetId, seed, deps.google);
      summary.registered += 1;
      summary.invalid += 1;
      summary.reasons.duplicate_pmid += 1;
      summary.added.push(seed);
      continue;
    }
    const verify = results.get(pmid);
    if (!verify || !verify.isValid) {
      const seed: SeedPaper = {
        pmid,
        title: null,
        year: null,
        source: 'initial',
        ingestFormat,
        originalDb,
        isValid: false,
        exclusionReason: 'pmid_not_found',
        originalPayloadRef: null,
        userDecision: null,
        decidedAt: null,
        decidedBy: null,
        note: null,
      };
      await appendSeedPaper(spreadsheetId, seed, deps.google);
      summary.registered += 1;
      summary.invalid += 1;
      summary.reasons.pmid_not_found += 1;
      summary.added.push(seed);
      continue;
    }
    const article = verify.article;
    const seed: SeedPaper = {
      pmid,
      title: article?.title ?? null,
      year: article?.year ?? null,
      source: 'initial',
      ingestFormat,
      originalDb,
      isValid: true,
      exclusionReason: null,
      originalPayloadRef: null,
      userDecision: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
    await appendSeedPaper(spreadsheetId, seed, deps.google);
    summary.registered += 1;
    summary.valid += 1;
    summary.added.push(seed);
  }
}

function buildNoPmidSeed(
  resolved: ResolvedRisEntry,
  originalPayloadRef: string,
  deps: SeedServiceDeps
): SeedPaper {
  // now は現時点未使用（RIS no_pmid 行は時刻を持たない）。将来の decided_at 用に deps に残す
  void deps;
  return {
    pmid: null,
    title: resolved.title,
    year: resolved.year,
    source: 'initial',
    ingestFormat: 'ris_no_pmid',
    originalDb: resolved.originalDb,
    isValid: false,
    exclusionReason: 'no_pmid_resolved',
    originalPayloadRef,
    userDecision: null,
    decidedAt: null,
    decidedBy: null,
    note: null,
  };
}

async function uploadSkippedRisEntry(
  entry: RisEntry,
  driveFolderId: string,
  deps: SeedServiceDeps
): Promise<string> {
  const rawProtocols = await ensureChildFolder('raw_protocols', driveFolderId, deps.google);
  const skippedSeeds = await ensureChildFolder('skipped_seeds', rawProtocols.id, deps.google);
  const uuidFn = deps.newUuid ?? newUuid;
  const uploaded = await uploadTextFile(
    {
      name: `${uuidFn()}.ris`,
      content: entry.rawText,
      parentId: skippedSeeds.id,
      mimeType: 'application/x-research-info-systems',
    },
    deps.google
  );
  return uploaded.webViewLink;
}

function dedupePreserveOrder(pmids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pmid of pmids) {
    const trimmed = pmid.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** 将来の API 拡張用。NbibEntry を expose したいので domain をまとめて参照できるように型だけ持ち出す */
export type { NbibEntry };
