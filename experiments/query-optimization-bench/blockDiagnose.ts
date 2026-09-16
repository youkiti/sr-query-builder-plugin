/**
 * 凍結 C0 に対して、LLM を使わずブロック診断（構造診断 diagnoseStructure / 件数診断
 * diagnoseNarrowing）だけを NCBI 通信で実行する評価コマンド（issue #164）。
 *
 * `blockDiagnosis.ts` のコメントどおり、`BLOCK_NARROWING_MIN_REDUCTION`（既定 0.2）は
 * 「凍結 C0 の分布を見て調整する前提の初期値」であり、このコマンドの目的は分布そのものを取ること。
 * `eval:optimize` の full run（LLM を使う自動調整）に依存せず、診断だけを独立して回せるようにする。
 *
 * 既存の full run（`results/default/<caseId>/<c0名>/<split>+<runLabel>/run.json`）から
 * `optimization.blockDiagnosis` を収集する `--harvest` モードも持つ（再実行しない）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { expandFormula } from '../../src/features/validation/expandFormula';
import {
  diagnoseNarrowing, diagnoseStructure, diagnosisTargets, meshOccurrences, queryWithoutBlock,
  MAX_DIAGNOSIS_API_CALLS, type BlockDiagnosis, type BlockNarrowing,
} from '../../src/features/validation/blockDiagnosis';
import { fetchMeshTreeNumbers } from '../../src/lib/ncbi/mesh';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { FIXTURES } from './prepare';
import { CASES, type BenchCase, type RunResult } from './types';
import { canonicalize, c0Dir, loadC0Artifact, type C0Variant } from './c0Artifact';
import { RESULTS, reportError } from './run';
import { createEvalFetch, observeBackoff, observeRateLimiter, redact } from './ncbiEval';
import { getGitCommit, isGitDirty } from './gitInfo';

/** full run の結果ディレクトリは常にこのプロファイルを使う（issue164-current の full run 24 本と同じ）。 */
const HARVEST_PROFILE_ID = 'default';
const DEFAULT_RUN_LABEL = 'issue164-current';

export interface DiagnoseArgs {
  caseId?: string;
  c0Name?: string;
  label: string;
  harvest: boolean;
  resultsDir?: string;
  runLabel: string;
  report: boolean;
  dryRun: boolean;
}

/** blockDiagnosis が実際にどの式（凍結 C0 か、自動調整で採用された最良式か）を診断したものか。 */
export type DiagnosisTarget = 'c0' | 'best';

/** --harvest で split をまたいで収集した診断が一致しなかったときに、代表値と一緒に両方残す。 */
export interface SplitMismatchEntry {
  split: string;
  runId: string;
  finalHits: number | null;
  finalQuery: string | null;
  diagnosisTarget: DiagnosisTarget | null;
  diagnosis: BlockDiagnosis;
}

export interface DiagnosisRecord {
  schemaVersion: 1;
  /** 'diagnosis-only' はこのコマンドが直接測定したもの、'full-run' は --harvest で収集したもの。 */
  source: 'diagnosis-only' | 'full-run';
  caseId: string;
  c0: { name: string; sha256: string; variant: C0Variant; draftIndex: number };
  searchDate: string;
  startedAt: string;
  elapsedMs: number;
  gitCommit: string | null;
  gitDirty: boolean | null;
  /** false は通信の一時的な失敗などで再試行したいことを示す（再開時のスキップ判定に使う）。 */
  complete: boolean;
  error: string | null;
  /**
   * 診断した式（finalHits と対になる）。--harvest で診断対象を C0/C1 のどちらとも件数で
   * 対応づけられなかったときだけ null（誤った対応づけを保存しないため）。
   */
  finalQuery: string | null;
  finalHits: number | null;
  /**
   * finalQuery/finalHits がどちらの式のものか。通常モードは常に凍結 C0 そのものを測るので
   * 'c0' 固定。--harvest は run.json の narrowing[*].finalHits と conditions.C0/C1 の実測件数を
   * 突き合わせて決める（自動調整で候補が採用されていれば blockDiagnosis は採用後の最良式
   * （C1）を診断したものになるため、常に C0 とは限らない）。対応づけられなければ null。
   */
  diagnosisTarget: DiagnosisTarget | null;
  simple: boolean;
  targetBlockIds: string[];
  diagnosis: BlockDiagnosis;
  /** --harvest 収集分は full run 側の通信と混ざるため計上しない（null）。実行コストの記録用の総数。 */
  apiCalls: number | null;
  /**
   * 診断フェーズだけの通信数（最終式の実測を含まない）。queryOptimizationService.ts の
   * `updateDiagnosis` が `MAX_DIAGNOSIS_API_CALLS` と比べる `diagnosisApiCalls` と同じ区切り
   * （ブロックを外した式の esearch と fetchMeshTreeNumbers だけを数え、最終式の実測は
   * `measure()` 側の別カウンタで診断予算に入らない）。--harvest 収集分は計上しない（null）。
   */
  diagnosisApiCalls: number | null;
  /** diagnosisApiCalls が製品の通信上限（MAX_DIAGNOSIS_API_CALLS）を超えたか。--harvest は null。 */
  exceedsProductBudget: boolean | null;
  /** --harvest で複数 split から代表として選んだ split 名（split 名の昇順で先頭）。通常モードは null。 */
  representativeSplit: string | null;
  /** --harvest で収集した run の runId 一覧。通常モードでは付けない。 */
  runIds?: string[];
  /** --harvest で同じ C0 が複数 split に現れ、診断が split 間で一致しなかったときだけ設定する。 */
  splitMismatch?: SplitMismatchEntry[];
}

export interface DiagnoseDeps {
  fetch?: typeof fetch;
  eutils?: Pick<EutilsDeps, 'maxRetries' | 'sleep'>;
  fetchMeshTreeNumbers?: typeof fetchMeshTreeNumbers;
  secrets?: string[];
}

export function parseDiagnoseArgs(args: string[]): DiagnoseArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (values.has(arg) || flags.has(arg)) throw new Error(`引数が重複しています: ${arg}`);
    if (arg === '--harvest' || arg === '--report' || arg === '--dry-run') flags.add(arg);
    else if (['--case', '--c0', '--label', '--results', '--run-label'].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`引数の値がありません: ${arg}`);
      values.set(arg, value);
    } else throw new Error(`未知の引数です: ${arg}`);
  }
  const harvest = flags.has('--harvest');
  const report = flags.has('--report');
  const dryRun = flags.has('--dry-run');
  if ([harvest, report, dryRun].filter(Boolean).length > 1) {
    throw new Error('--harvest / --report / --dry-run は互いに併用できません');
  }
  const caseId = values.get('--case');
  if (caseId !== undefined && !CASES.some((item) => item.id === caseId)) throw new Error('--case が未知のケース ID です');
  const c0Name = values.get('--c0');
  if (c0Name !== undefined && caseId === undefined) throw new Error('--c0 は --case と併用してください');
  const label = values.get('--label') ?? 'default';
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(label) || /^replay-/i.test(label) || label === '.' || label === '..') {
    throw new Error('--label は英数字・.・_・- の1〜40文字です。replay- 接頭辞と . / .. は使用できません');
  }
  const resultsDir = values.get('--results');
  if (resultsDir !== undefined && !harvest) throw new Error('--results は --harvest でのみ使用できます');
  if (values.has('--run-label') && !harvest) throw new Error('--run-label は --harvest でのみ使用できます');
  const runLabel = values.get('--run-label') ?? DEFAULT_RUN_LABEL;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runLabel)) throw new Error('--run-label の形式が不正です');
  return { caseId, c0Name, label, harvest, resultsDir, runLabel, report, dryRun };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function atomicWrite(path: string, value: unknown, secrets: readonly string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, redact(JSON.stringify(value, null, 2), secrets) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}

function toErrorMessage(error: unknown, secrets: readonly string[]): string {
  return redact(error instanceof Error ? error.message : String(error), secrets);
}

function listC0Names(fixturesDir: string, caseId: string): string[] {
  const dir = c0Dir(fixturesDir, caseId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}

function outputPath(root: string, caseId: string, c0Name: string): string {
  return join(root, caseId, `${c0Name}.json`);
}

function dryRunC0(caseId: string, c0Name: string, fixturesDir: string, root: string): void {
  const artifact = loadC0Artifact(fixturesDir, caseId, c0Name);
  const approvedBlocks = artifact.blocks.blocks.map((block, index) =>
    ({ id: String(index + 1), approvedBlockId: String(index + 1), label: block.blockLabel }));
  const { simple, blocks } = diagnosisTargets(artifact.formula, approvedBlocks);
  process.stdout.write(`${caseId}/${c0Name}: dry-run OK (simple=${simple}, 対象ブロック=${blocks.length}) -> ${outputPath(root, caseId, c0Name)}\n`);
}

/** 凍結 C0 1 本を実測して診断する（通常モード）。既に complete: true の出力があれば何もしない。 */
async function diagnoseC0(caseId: string, c0Name: string, fixturesDir: string, root: string,
  deps: DiagnoseDeps, secrets: readonly string[]): Promise<void> {
  const outPath = outputPath(root, caseId, c0Name);
  if (existsSync(outPath)) {
    const previous = readJson<DiagnosisRecord>(outPath);
    if (previous.complete) {
      process.stdout.write(`${caseId}/${c0Name}: 完了済みのためスキップ\n`);
      return;
    }
  }
  const artifact = loadC0Artifact(fixturesDir, caseId, c0Name);
  const fixture = readJson<BenchCase>(join(fixturesDir, caseId, 'case.json'));
  const approvedBlocks = artifact.blocks.blocks.map((block, index) =>
    ({ id: String(index + 1), approvedBlockId: String(index + 1), label: block.blockLabel }));
  const finalQuery = expandFormula(artifact.formula);
  const startedAt = new Date();
  const gitCommit = getGitCommit();
  const gitDirty = isGitDirty();
  let apiCalls = 0;
  const network = createEvalFetch(fixture.searchDate, deps.fetch ?? globalThis.fetch, () => { apiCalls += 1; }, secrets);
  const eutils: EutilsDeps = { fetch: network, apiKey: process.env.NCBI_API_KEY, strictCounts: true,
    maxRetries: deps.eutils?.maxRetries, sleep: observeBackoff(() => undefined, deps.eutils?.sleep) };
  eutils.rateLimiter = observeRateLimiter(eutils, () => undefined);
  const base = { schemaVersion: 1 as const, source: 'diagnosis-only' as const, caseId,
    c0: { name: c0Name, sha256: artifact.sha256, variant: artifact.variant, draftIndex: artifact.draftIndex },
    searchDate: fixture.searchDate, startedAt: startedAt.toISOString(), gitCommit, gitDirty };
  let record: DiagnosisRecord;
  // queryOptimizationService.ts の updateDiagnosis は診断予算 MAX_DIAGNOSIS_API_CALLS を
  // 「ブロックを外した式の esearch と fetchMeshTreeNumbers」だけで数え、最終式の実測
  // （measure() 側）は含めない（budgetNote() が見るのは diagnosisApiCalls のみ）。ここでも
  // 最終式測定より後の増分だけを診断フェーズの通信として切り出す。
  let diagnosisStartApiCalls = 0;
  try {
    // 最終式（結合式まで展開）を 1 回測る。ここで失敗したら通信の一時的な問題として C0 全体を
    // 再試行対象にする（複数ブロックの部分測定を積み上げた後に土台の finalHits が欠けると
    // narrowing の解釈が難しくなるため、finalHits だけは握りつぶさない）。
    const finalHits = (await esearch(finalQuery, eutils, { retmax: 0 })).count;
    diagnosisStartApiCalls = apiCalls;
    const { simple, refs, blocks } = diagnosisTargets(artifact.formula, approvedBlocks);
    const narrowing: BlockNarrowing[] = [];
    if (simple) {
      for (const block of blocks) {
        const query = queryWithoutBlock(artifact.formula, refs, block.id);
        let hits: number | null = null;
        let note = '';
        if (query === null) {
          note = '未判定: 対象ブロックを外すと参照が残らない';
        } else {
          // ここは 1 ブロックの測定失敗で他ブロック・構造診断まで巻き込まないよう、個別に捕まえる。
          try { hits = (await esearch(query, eutils, { retmax: 0 })).count; }
          catch (err) { note = `未判定: ${toErrorMessage(err, secrets)}`; }
        }
        narrowing.push(diagnoseNarrowing(block, finalHits, hits, note));
      }
    }
    const descriptors = [...new Set(blocks.flatMap((block) => meshOccurrences(block.expression))
      .filter((term) => !term.negative).map((term) => term.descriptor))];
    let trees = new Map<string, string[]>();
    const reasons = new Map<string, string>();
    if (descriptors.length) {
      try {
        const resolved = await (deps.fetchMeshTreeNumbers ?? fetchMeshTreeNumbers)(descriptors, eutils);
        // trees / reasons は要求した descriptor の表記をキーにするため、
        // diagnoseStructure が参照する小文字キーに揃える。
        // 通信が成功しても解決できなかった語の理由を渡し、診断の note に残す。
        trees = new Map([...resolved.trees].map(([descriptor, numbers]) => [descriptor.toLowerCase(), numbers]));
        for (const [descriptor, reason] of resolved.reasons) reasons.set(descriptor.toLowerCase(), reason);
      } catch (err) {
        // 通信失敗では trees / reasons が返らず全体が例外になるため、
        // 成功時の語ごとの未解決理由とは別に、要求した全 descriptor に同じ通信失敗理由を割り当てる。
        const message = `未判定: 階層を取得できなかった: ${toErrorMessage(err, secrets)}`;
        for (const descriptor of descriptors) reasons.set(descriptor.toLowerCase(), message);
      }
    }
    const structure = diagnoseStructure(artifact.formula, approvedBlocks, trees, reasons);
    // fingerprint は queryEvaluationService.formulaFingerprint（ブラウザの crypto.subtle に依存する非同期
    // ハッシュ）で計算する値で、採用候補の同一性判定に使う。診断専用コマンドはこの値を再現しない
    // （ブリーフの指示どおり）。測った式そのものは finalQuery に残るので、突き合わせはそちらで行う。
    const diagnosis: BlockDiagnosis = { fingerprint: '', overlaps: structure.overlaps, narrowing, note: structure.note };
    const diagnosisApiCalls = apiCalls - diagnosisStartApiCalls;
    record = { ...base, elapsedMs: Date.now() - startedAt.getTime(), complete: true, error: null,
      finalQuery, finalHits, diagnosisTarget: 'c0', simple, targetBlockIds: blocks.map((block) => block.id), diagnosis,
      apiCalls, diagnosisApiCalls, exceedsProductBudget: diagnosisApiCalls > MAX_DIAGNOSIS_API_CALLS, representativeSplit: null };
  } catch (err) {
    const diagnosisApiCalls = apiCalls - diagnosisStartApiCalls;
    // 通常モードは常に凍結 C0 そのものを診断対象にしている（採用・不採用の分岐が起きるのは
    // --harvest が読む full run 側だけ）ので、測定に失敗していても diagnosisTarget は 'c0' で確定する。
    record = { ...base, elapsedMs: Date.now() - startedAt.getTime(), complete: false, error: toErrorMessage(err, secrets),
      finalQuery, finalHits: null, diagnosisTarget: 'c0', simple: false, targetBlockIds: [],
      diagnosis: { fingerprint: '', overlaps: [], narrowing: [], note: '' },
      apiCalls, diagnosisApiCalls, exceedsProductBudget: diagnosisApiCalls > MAX_DIAGNOSIS_API_CALLS, representativeSplit: null };
  }
  atomicWrite(outPath, record, secrets);
  const kinds = record.diagnosis.overlaps.map((row) => row.kind);
  const judged = record.diagnosis.narrowing.filter((row) => row.ineffective !== null);
  const ineffective = judged.filter((row) => row.ineffective).length;
  process.stdout.write(`${caseId}/${c0Name}: overlaps=${record.diagnosis.overlaps.length}`
    + `(same=${kinds.filter((k) => k === 'same').length},ancestor=${kinds.filter((k) => k === 'ancestor').length},unknown=${kinds.filter((k) => k === 'unknown').length}) `
    + `narrowing=${ineffective}/${judged.length}(全${record.diagnosis.narrowing.length}) `
    + `apiCalls=${apiCalls}(診断分=${record.diagnosisApiCalls})`
    + `${record.complete ? '' : ` error=${record.error}`}\n`);
}

interface HarvestedSplit {
  split: string;
  runId: string;
  finalHits: number | null;
  finalQuery: string | null;
  diagnosisTarget: DiagnosisTarget | null;
  diagnosis: BlockDiagnosis;
  gitCommit: string | null;
  startedAt: string;
}

/** diagnoseStructure は「結合式が単純な AND ではない」ときだけこの note を返す。full run の
 * run.json には simple 自体は残っていないため、note の内容からその判定を逆算する。 */
const NOT_SIMPLE_NOTE = '未判定: 結合式が単純な AND ではない';

/**
 * blockDiagnosis が実際にどの式を診断したものかを、narrowing の finalHits と
 * conditions.C0/C1 の実測件数を突き合わせて特定する。
 *
 * queryOptimizationService.ts の updateDiagnosis は候補（採用済みなら最良式、未採用ならまだ
 * C0）を測るたびに呼ばれ、そのときの measurement.totalHits を diagnosis.narrowing[*].finalHits
 * として保存する。したがって run.json の conditions.C0（常に凍結 C0 の実測）と conditions.C1
 * （自動調整の最良式。採用が無ければ C0 と同じ式になりうる）のうち、diagnosis の finalHits と
 * 件数が一致する側が実際に診断された式である。narrowing が空、finalHits がすべて null、
 * またはどちらの条件とも件数が一致しない場合は対応づけられないため null にする
 * （誤った式・件数を finalQuery/finalHits に保存しない）。
 */
function resolveHarvestTarget(run: RunResult, diagnosis: BlockDiagnosis):
  { target: DiagnosisTarget | null; finalQuery: string | null; finalHits: number | null } {
  const diagnosedHits = diagnosis.narrowing.find((row) => row.finalHits !== null)?.finalHits ?? null;
  if (diagnosedHits === null) return { target: null, finalQuery: null, finalHits: null };
  const c0 = run.conditions.C0;
  const c1 = run.conditions.C1;
  const c0Hits = c0?.measurement.status === 'success' ? c0.measurement.hits : null;
  const c1Hits = c1?.measurement.status === 'success' ? c1.measurement.hits : null;
  // 両方の件数が偶然一致する場合は C0（不採用）を優先する。診断は C0→C1 の順で進むため、
  // 件数が変わらない採用（起こりうるがまれ）ではどちらの式を指しても実害が小さい単純な tie-break。
  if (c0Hits !== null && c0Hits === diagnosedHits) return { target: 'c0', finalQuery: c0!.query, finalHits: c0Hits };
  if (c1Hits !== null && c1Hits === diagnosedHits) return { target: 'best', finalQuery: c1!.query, finalHits: c1Hits };
  return { target: null, finalQuery: null, finalHits: null };
}

async function harvestC0(caseId: string, c0Name: string, c0ResultDir: string, runLabel: string,
  root: string, fixturesDir: string, secrets: readonly string[]): Promise<void> {
  const suffix = `+${runLabel}`;
  const splits: HarvestedSplit[] = [];
  for (const entry of readdirSync(c0ResultDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue;
    const split = entry.name.slice(0, entry.name.length - suffix.length);
    const runPath = join(c0ResultDir, entry.name, 'run.json');
    if (!existsSync(runPath)) continue;
    const run = readJson<RunResult>(runPath);
    const diagnosis = run.optimization?.blockDiagnosis;
    if (!diagnosis) {
      process.stdout.write(`${caseId}/${c0Name}/${split}: optimization.blockDiagnosis がありません（スキップ）\n`);
      continue;
    }
    const resolved = resolveHarvestTarget(run, diagnosis);
    if (resolved.target === null) {
      process.stdout.write(`${caseId}/${c0Name}/${split}: 診断対象の式を C0/C1 の実測件数から特定できませんでした（finalQuery/finalHits は null で保存）\n`);
    }
    splits.push({ split, runId: run.runId, gitCommit: run.gitCommit ?? null, startedAt: run.startedAt,
      finalHits: resolved.finalHits, finalQuery: resolved.finalQuery, diagnosisTarget: resolved.target, diagnosis });
  }
  if (!splits.length) return;
  let artifact;
  let fixture;
  try {
    artifact = loadC0Artifact(fixturesDir, caseId, c0Name);
    fixture = readJson<BenchCase>(join(fixturesDir, caseId, 'case.json'));
  } catch (err) {
    process.stdout.write(`${caseId}/${c0Name}: 凍結 C0 の読み込みに失敗しました（スキップ）: ${toErrorMessage(err, secrets)}\n`);
    return;
  }
  // readdirSync の列挙順はファイルシステム依存で、同じ入力でも実行のたびに変わりうる。
  // 代表 split（不一致時にどちらを diagnosis に採るか）が列挙順に依存すると --report の
  // 集計値がファイルシステムの順に依存してしまうため、split 名の昇順に整列してから決める。
  const sortedSplits = [...splits].sort((a, b) => a.split.localeCompare(b.split));
  const [representative, ...rest] = sortedSplits;
  const mismatched = rest.some((item) => JSON.stringify(canonicalize(item.diagnosis)) !== JSON.stringify(canonicalize(representative!.diagnosis)));
  const record: DiagnosisRecord = {
    schemaVersion: 1, source: 'full-run', caseId,
    c0: { name: c0Name, sha256: artifact.sha256, variant: artifact.variant, draftIndex: artifact.draftIndex },
    searchDate: fixture.searchDate, startedAt: representative!.startedAt,
    // harvest は既存の run.json を読むだけで自分では何も測定しないため、処理時間として意味のある
    // elapsedMs を持たない（0 固定）。
    elapsedMs: 0, gitCommit: representative!.gitCommit, gitDirty: null, complete: true, error: null,
    finalQuery: representative!.finalQuery, finalHits: representative!.finalHits, diagnosisTarget: representative!.diagnosisTarget,
    simple: representative!.diagnosis.note !== NOT_SIMPLE_NOTE,
    targetBlockIds: representative!.diagnosis.narrowing.map((row) => row.blockId),
    diagnosis: representative!.diagnosis, apiCalls: null, diagnosisApiCalls: null, exceedsProductBudget: null,
    representativeSplit: representative!.split,
    runIds: sortedSplits.map((item) => item.runId),
    ...(mismatched ? { splitMismatch: sortedSplits.map((item): SplitMismatchEntry => ({ split: item.split, runId: item.runId,
      finalHits: item.finalHits, finalQuery: item.finalQuery, diagnosisTarget: item.diagnosisTarget, diagnosis: item.diagnosis })) } : {}),
  };
  atomicWrite(outputPath(root, caseId, c0Name), record, secrets);
  const judged = record.diagnosis.narrowing.filter((row) => row.ineffective !== null);
  process.stdout.write(`${caseId}/${c0Name}: overlaps=${record.diagnosis.overlaps.length} `
    + `narrowing判定=${judged.filter((row) => row.ineffective).length}/${judged.length}(全${record.diagnosis.narrowing.length}) `
    + `splits=${sortedSplits.length}(代表=${representative!.split}, target=${representative!.diagnosisTarget ?? '不明'})${mismatched ? ' splitMismatch' : ''}\n`);
}

async function harvestCase(caseId: string, resultsRoot: string, runLabel: string, root: string,
  fixturesDir: string, secrets: readonly string[], c0Name?: string): Promise<void> {
  const caseDir = join(resultsRoot, HARVEST_PROFILE_ID, caseId);
  if (!existsSync(caseDir)) {
    process.stdout.write(`${caseId}: full run の結果ディレクトリが見つかりません（スキップ） -> ${caseDir}\n`);
    return;
  }
  for (const entry of readdirSync(caseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // --c0 は通常モード・dry-run と同じ「対象を 1 本に絞る」意味にする。指定外の C0 に触れない
    // （既存の収集結果を上書きしない）。
    if (c0Name !== undefined && entry.name !== c0Name) continue;
    await harvestC0(caseId, entry.name, join(caseDir, entry.name), runLabel, root, fixturesDir, secrets);
  }
}

/**
 * 分位点は線形補間（R の type=7 / numpy の既定 'linear' と同じ）で計算する。
 * ソート済み配列で index = p * (n-1) を取り、前後の値を weight = index - floor(index) で補間する。
 */
export function quantile(sortedValues: readonly number[], p: number): number | null {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower]!;
  const weight = index - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}

interface GroupSummary {
  name: string;
  total: number;
  diagnosed: number;
  failed: number;
  overlapSame: number;
  overlapAncestor: number;
  overlapUnknown: number;
  overlapNone: number;
  /** 結合式が単純な AND でなく diagnoseStructure が判定できなかった C0 数（重なりなしとは区別する）。 */
  structureUndetermined: number;
  ineffectiveC0: number;
  ineffectiveBlocks: number;
  judgedBlocks: number;
  undeterminedBlocks: number;
  undeterminedNotes: [string, number][];
  quantiles: { min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null };
  diagnosisOnly: number;
  fullRun: number;
  splitMismatch: number;
}

function summarizeGroup(name: string, records: readonly DiagnosisRecord[]): GroupSummary {
  const diagnosed = records.filter((r) => r.complete && !r.error);
  const allNarrowing = diagnosed.flatMap((r) => r.diagnosis.narrowing);
  const judged = allNarrowing.filter((row) => row.ineffective !== null);
  const undetermined = allNarrowing.filter((row) => row.ineffective === null);
  const noteCounts = new Map<string, number>();
  for (const row of undetermined) noteCounts.set(row.note, (noteCounts.get(row.note) ?? 0) + 1);
  const reductions = judged.map((row) => row.reduction!).sort((a, b) => a - b);
  return {
    name, total: records.length, diagnosed: diagnosed.length, failed: records.length - diagnosed.length,
    overlapSame: diagnosed.filter((r) => r.diagnosis.overlaps.some((o) => o.kind === 'same')).length,
    overlapAncestor: diagnosed.filter((r) => r.diagnosis.overlaps.some((o) => o.kind === 'ancestor')).length,
    overlapUnknown: diagnosed.filter((r) => r.diagnosis.overlaps.some((o) => o.kind === 'unknown')).length,
    // 結合式が単純な AND でない C0 は diagnoseStructure が空の overlaps を返す（未判定であって
    // 「重なりが無いと確認できた」わけではない）。structureUndetermined 側に数え、ここには含めない。
    overlapNone: diagnosed.filter((r) => r.simple && r.diagnosis.overlaps.length === 0).length,
    structureUndetermined: diagnosed.filter((r) => !r.simple).length,
    ineffectiveC0: diagnosed.filter((r) => r.diagnosis.narrowing.some((row) => row.ineffective === true)).length,
    ineffectiveBlocks: judged.filter((row) => row.ineffective).length,
    judgedBlocks: judged.length,
    undeterminedBlocks: undetermined.length,
    undeterminedNotes: [...noteCounts.entries()].sort((a, b) => b[1] - a[1]),
    quantiles: { min: quantile(reductions, 0), p25: quantile(reductions, 0.25), median: quantile(reductions, 0.5),
      p75: quantile(reductions, 0.75), max: quantile(reductions, 1) },
    diagnosisOnly: diagnosed.filter((r) => r.source === 'diagnosis-only').length,
    fullRun: diagnosed.filter((r) => r.source === 'full-run').length,
    splitMismatch: records.filter((r) => r.splitMismatch).length,
  };
}

function formatRate(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

const SUMMARY_HEADERS = ['ケース', 'C0数', '診断できた数', '失敗数', 'same重なりC0', 'ancestor重なりC0', 'unknown重なりC0', '重なりなしC0',
  '構造未判定C0', '効いてないブロックを含むC0', '効いてないブロック/判定済み', '未判定ブロック', '未判定内訳(note別)',
  '削減率min', '削減率p25', '削減率中央値', '削減率p75', '削減率max', 'diagnosis-only件数', 'full-run件数', 'split不一致件数'];

function summaryRow(summary: GroupSummary): (string | number)[] {
  return [summary.name, summary.total, summary.diagnosed, summary.failed,
    summary.overlapSame, summary.overlapAncestor, summary.overlapUnknown, summary.overlapNone, summary.structureUndetermined,
    summary.ineffectiveC0, `${summary.ineffectiveBlocks}/${summary.judgedBlocks}`, summary.undeterminedBlocks,
    summary.undeterminedNotes.map(([note, count]) => `${note}: ${count}`).join('; ') || '-',
    formatRate(summary.quantiles.min), formatRate(summary.quantiles.p25), formatRate(summary.quantiles.median),
    formatRate(summary.quantiles.p75), formatRate(summary.quantiles.max),
    summary.diagnosisOnly, summary.fullRun, summary.splitMismatch];
}

function loadDiagnosisRecords(root: string): DiagnosisRecord[] {
  if (!existsSync(root)) return [];
  const records: DiagnosisRecord[] = [];
  for (const caseEntry of readdirSync(root, { withFileTypes: true })) {
    if (!caseEntry.isDirectory()) continue;
    const dir = join(root, caseEntry.name);
    for (const fileEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.json')) continue;
      records.push(readJson<DiagnosisRecord>(join(dir, fileEntry.name)));
    }
  }
  return records;
}

export function reportDiagnosis(root: string, label: string): string {
  const records = loadDiagnosisRecords(root);
  const byCase = new Map<string, DiagnosisRecord[]>();
  for (const record of records) byCase.set(record.caseId, [...(byCase.get(record.caseId) ?? []), record]);
  const caseIds = [...byCase.keys()].sort();
  const rows = caseIds.map((caseId) => summaryRow(summarizeGroup(caseId, byCase.get(caseId)!)));
  rows.push(summaryRow(summarizeGroup(records.length === 0 ? '全体（0 件）' : '全体', records)));
  const summaryTable = [SUMMARY_HEADERS, SUMMARY_HEADERS.map(() => '---'), ...rows]
    .map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';

  const detailHeaders = ['ケース', 'C0', '由来', '完了', 'エラー', '構造', 'same/ancestor/unknown', '効いてない/判定済み(全ブロック)', 'split不一致'];
  const detailRows = [...records].sort((a, b) => a.caseId === b.caseId
    ? a.c0.name.localeCompare(b.c0.name) : a.caseId.localeCompare(b.caseId)).map((r) => {
    const kinds = r.diagnosis.overlaps.map((o) => o.kind);
    const judged = r.diagnosis.narrowing.filter((row) => row.ineffective !== null);
    const ineffective = judged.filter((row) => row.ineffective).length;
    return [r.caseId, r.c0.name, r.source, r.complete ? '○' : '×', r.error ?? '-', r.simple ? '単純' : '未判定',
      `${kinds.filter((k) => k === 'same').length}/${kinds.filter((k) => k === 'ancestor').length}/${kinds.filter((k) => k === 'unknown').length}`,
      `${ineffective}/${judged.length}(${r.diagnosis.narrowing.length})`, r.splitMismatch ? '○' : '-'];
  });
  const detailTable = [detailHeaders, detailHeaders.map(() => '---'), ...detailRows]
    .map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';

  const markdown = `# ブロック診断の集計（label=${label}）\n\n## ケース別・全体\n\n${summaryTable}\n## C0 ごとの明細\n\n${detailTable}`;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'summary.md'), markdown, 'utf8');
  const csvRows = [SUMMARY_HEADERS, ...rows];
  writeFileSync(join(root, 'summary.csv'),
    csvRows.map((cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n', 'utf8');
  process.stdout.write(markdown);
  return markdown;
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS,
  deps: DiagnoseDeps = {}): Promise<void> {
  const options = parseDiagnoseArgs(args);
  const root = join(resultsDir, 'block-diagnosis', options.label);
  if (options.report) { reportDiagnosis(root, options.label); return; }
  const caseIds = options.caseId ? [options.caseId] : CASES.map((item) => item.id);
  if (options.dryRun) {
    for (const caseId of caseIds) {
      for (const c0Name of options.c0Name ? [options.c0Name] : listC0Names(fixturesDir, caseId)) {
        dryRunC0(caseId, c0Name, fixturesDir, root);
      }
    }
    return;
  }
  if (options.harvest) {
    const harvestResultsRoot = options.resultsDir ?? resultsDir;
    const secrets = [...(deps.secrets ?? []), process.env.NCBI_API_KEY ?? ''];
    for (const caseId of caseIds) await harvestCase(caseId, harvestResultsRoot, options.runLabel, root, fixturesDir, secrets, options.c0Name);
    return;
  }
  if (!deps.fetch) config();
  const secrets = [...(deps.secrets ?? []), process.env.NCBI_API_KEY ?? ''];
  for (const caseId of caseIds) {
    for (const c0Name of options.c0Name ? [options.c0Name] : listC0Names(fixturesDir, caseId)) {
      await diagnoseC0(caseId, c0Name, fixturesDir, root, deps, secrets);
    }
  }
}

if (require.main === module) void main().catch(reportError);
