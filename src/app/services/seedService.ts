import type { SeedPaper } from '@/domain/seedPaper';
import {
  appendSeedPaper,
  hasDuplicateSeedPmid,
  invalidateSeedRow,
  listSeedPapersWithRows,
  setSeedEnabledRow,
  parseNbib,
  parseRis,
  resolveRisEntry,
  verifyPmids,
  type NbibEntry,
  type RisEntry,
  type ResolvedRisEntry,
  type SeedPaperWithRow,
} from '@/features/seeds';
import type { EfetchArticle, EutilsDeps } from '@/lib/ncbi';
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
  /**
   * 有効 PMID として確認できた文献の詳細書誌情報。
   * シード論文画面でタイトル / アブスト / MeSH / リンク等を即時表示するために載せる。
   * SeedPapers タブには保存しない（容量・スキーマの安定性を優先）。
   */
  articles: Record<string, EfetchArticle>;
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
  articles: {},
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
  // バッチ内の出現順を保ったまま、空白を除いた全 PMID を取り出す（重複も保持する）。
  // §4.3「監査用に入力履歴を残すため、上書きや完全スキップはしない」に従い、
  // 同一バッチ内の 2 件目以降も duplicate_pmid 行として追記する。
  const orderedInput = pmids.map((p) => p.trim()).filter((p) => p !== '');
  const uniqueInput = dedupePreserveOrder(pmids);
  const existing = new Set<string>();
  // 既に有効行・user_disabled 行・user_removed 行を持つ PMID は duplicate_pmid で記録（§4.3）。
  // 「ユーザーが一度削除・無効化した事実」を監査ログに残すため、これらの PMID の
  // 再 ingest も新規有効行として復活させず、duplicate_pmid 行を追記する
  // （user_disabled の復帰は一覧のチェックボックスで行う）。
  // pmid_not_found 行のみの PMID は重複扱いにしない（「再試行」で再 ingest する前提）。
  for (const pmid of uniqueInput) {
    if (await hasDuplicateSeedPmid(spreadsheetId, pmid, deps.google)) {
      existing.add(pmid);
    }
  }
  const toVerify = uniqueInput.filter((pmid) => !existing.has(pmid));
  const verifications = await verifyPmids(toVerify, deps.eutils);
  const results = new Map(verifications.map((v) => [v.pmid, v]));

  // バッチ内で 2 回目以降に登場した PMID を duplicate として扱うための既出セット。
  const seenInBatch = new Set<string>();

  for (const pmid of orderedInput) {
    // バッチ内重複（同一バッチで既に 1 件追記済み）は duplicate_pmid 行として残す
    if (seenInBatch.has(pmid)) {
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
    seenInBatch.add(pmid);

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
    if (article) {
      summary.articles[pmid] = article;
    }
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

/**
 * 登録済み SeedPapers を行番号付きで一覧する（§4.3 ingest サマリ UI の一覧表示用）。
 * デフォルトの「有効のみ表示」「無効行も表示」トグルは UI 側で seed.isValid を見て出し分ける。
 */
export async function listSeeds(deps: SeedServiceDeps): Promise<SeedPaperWithRow[]> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  return listSeedPapersWithRows(state.project.spreadsheetId, deps.google);
}

/**
 * シードの有効/無効をチェックボックスで切り替える（§4.3）。
 * 無効化は `is_valid=false, exclusion_reason=user_disabled` で、一覧に表示されたまま
 * いつでも再有効化できる。論理削除（user_removed）とは区別する。
 */
export async function setSeedEnabled(
  rowIndex: number,
  seed: SeedPaper,
  enabled: boolean,
  deps: SeedServiceDeps
): Promise<SeedPaper> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  return setSeedEnabledRow(state.project.spreadsheetId, rowIndex, seed, enabled, deps.google);
}

/**
 * 行を論理削除する（§4.3 の「削除」ボタン）。当該行を `is_valid=false,
 * exclusion_reason=user_removed` へ書き換えるだけで、行自体は SeedPapers に残す
 * （監査性のため物理削除しない）。削除後は一覧のデフォルト表示から消える。
 */
export async function invalidateSeed(
  rowIndex: number,
  seed: SeedPaper,
  deps: SeedServiceDeps
): Promise<SeedPaper> {
  const state = deps.store.getState();
  if (state.project === null) {
    throw new Error('プロジェクトが選択されていません');
  }
  return invalidateSeedRow(state.project.spreadsheetId, rowIndex, seed, deps.google);
}

/**
 * `pmid_not_found` の無効行に対する「再試行」（§4.3）。
 * 当該 PMID で存在確認をやり直し、見つかれば通常 ingest と同じく新規有効行を追記する。
 * 既存の ingestSeeds を 1 PMID で呼び直すだけの薄いラッパ。
 * （今回も見つからなければ pmid_not_found の新規行が増えるのは §4.3 の追記型方針として許容）
 */
export async function retrySeed(pmid: string, deps: SeedServiceDeps): Promise<IngestSummary> {
  return ingestSeeds({ mode: 'pmid_direct', pmids: [pmid] }, deps);
}

/**
 * ris_no_pmid 行への手動 PMID 補完（§4.3）。
 * ユーザーが手入力した PMID を E-utilities で検証し、有効なら新規 pmid_direct 行として追記する。
 * 元の ris_no_pmid 行は is_valid=false のまま残す（監査性のため）。
 */
export async function fillPmidForRisRow(
  pmid: string,
  deps: SeedServiceDeps
): Promise<IngestSummary> {
  return ingestSeeds({ mode: 'pmid_direct', pmids: [pmid.trim()] }, deps);
}

/** 将来の API 拡張用。NbibEntry を expose したいので domain をまとめて参照できるように型だけ持ち出す */
export type { NbibEntry };
