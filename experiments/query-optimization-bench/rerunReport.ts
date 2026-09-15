import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLlmUsageTracker } from './llmUsage';
import { CASES, type AdoptionAudit, type CaseRole, type Metrics, type RunResult } from './types';
import { buildRunJobs, CONFIG, defaultPaths, makeSlots, mask, readConfig, readJson, readLedger, readSlots,
  type Job, type LedgerRow, type Paths, type RerunConfig, type Slot } from './rerun';

type Cell = string | number | null;
export type Row = Record<string, Cell>;
export interface Entry { job: Job; run: RunResult | null; scored: { source: string; adoptionAudit: AdoptionAudit } | null; ledger?: LedgerRow }
const missing = '欠測で判定不能';
const yes = '満たす';
const no = '満たさない';
const status = (entry: Entry) => entry.run?.status === 'completed' ? '完了'
  : entry.run?.status === 'failed' || entry.ledger && (entry.ledger.exitCode !== 0 || entry.ledger.runStatus === 'failed') ? '失敗' : '欠測';
const metric = (entry: Entry, condition: 'C0' | 'C1'): Metrics | null => status(entry) === '完了' ? entry.run?.conditions[condition]?.metrics ?? null : null;
const hits = (entry: Entry, condition: 'C0' | 'C1'): number | null => {
  const measurement = entry.run?.conditions[condition]?.measurement;
  return status(entry) === '完了' && measurement?.status === 'success' ? measurement.hits : null;
};
const role = (id: string): CaseRole | '欠測' => CASES.find((c) => c.id === id)?.role ?? '欠測';
const names = (list: string[] | null) => list === null ? null : list.join('; ');
const subtract = (a: string[], b: string[]) => a.filter((id) => !b.includes(id));
const intersection = (a: string[], b: string[]) => a.filter((id) => b.includes(id));
export function usageFromLogs(entry: Entry) {
  const run = entry.run;
  if (!run || !run.runId || !Array.isArray(run.llmLogs)) return null;
  const tracker = createLlmUsageTracker();
  const token = (value: unknown): value is number | null => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const path of run.llmLogs) {
    if (typeof path !== 'string' || !path) return null;
    let log: Record<string, unknown> | null;
    try { log = readJson<Record<string, unknown>>(join(dirname(entry.job.expected), run.runId, path)); }
    catch { return null; }
    if (!log || typeof log !== 'object' || typeof log.model !== 'string' || !log.model || !('response' in log)
      || !token(log.tokensIn) || !token(log.tokensOut)) return null;
    tracker.record(log.model, log.tokensIn, log.tokensOut, log.response !== null);
  }
  return tracker.usage;
}
const delta = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : a - b;
export function distribution(values: (number | null | undefined)[]) {
  const sorted = values.filter((n): n is number => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  const n = sorted.length;
  return { min: n ? sorted[0]! : null, median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    max: n ? sorted[n - 1]! : null, measured: n, missing: values.length - n };
}
const audit = (entry: Entry): AdoptionAudit | null => {
  if (status(entry) !== '完了') return null;
  return entry.job.arm === 'current' ? entry.run?.adoptionAudit ?? null
    : entry.scored?.source === entry.run?.runId ? entry.scored?.adoptionAudit ?? null : null;
};
function aggregateA(caseId: string, arm: string, entries: Entry[]): Row {
  const row: Row = { case: caseId, role: caseId.startsWith('小計:') ? caseId.slice(3) : role(caseId), arm, runs: entries.length,
    completed: entries.filter((e) => status(e) === '完了').length, failed: entries.filter((e) => status(e) === '失敗').length,
    missing: entries.filter((e) => status(e) === '欠測').length };
  for (const condition of ['C0', 'C1'] as const) {
    for (const key of ['heldOutRecall', 'hits'] as const) {
      const stats = distribution(entries.map((e) => key === 'hits' ? hits(e, condition) : metric(e, condition)?.heldOutRecall));
      for (const [name, value] of Object.entries(stats)) row[`${condition}_${key}_${name}`] = value;
    }
  }
  return row;
}
export function layerC(entry: Entry): Row {
  const run = entry.run;
  const c0 = metric(entry, 'C0');
  const final = status(entry) === '完了' ? run?.oracle?.final.metrics : null;
  const heldOut = run?.denominator?.groups.filter((g) => run.denominator!.heldOut.includes(g.id)).flatMap((g) => g.members.map((m) => m.studyId));
  const missed = c0 && heldOut && !run?.denominator?.manualReviewPending ? subtract(heldOut, c0.capturedHeldOut) : null;
  const exposed = missed && run?.oracle ? intersection(missed, run.oracle.exposedHeldOutStudies) : null;
  const recovered = missed && final ? intersection(missed, final.capturedHeldOut) : null;
  const confirmations = run?.oracle ? [run.confirmation, ...run.oracle.rounds.map((r) => r.confirmation)] : [];
  const burden = confirmations.length && confirmations.every((c) => c?.status === 'ready')
    ? confirmations.reduce((sum, c) => sum + c!.total, 0) : null;
  return { id: entry.job.id, case: entry.job.caseId, role: role(entry.job.caseId), status: status(entry),
    missedC0: names(missed), exposedMissed: names(exposed), recoveredMissed: names(recovered), recoveredCount: recovered?.length ?? null,
    rounds: run?.oracle?.rounds.length ?? null, stopReason: run?.oracle?.stopReason ?? null,
    presentedPmids: burden, includedPmids: run?.oracle?.rounds.reduce((sum, r) => sum + r.includedPmids.length, 0) ?? null,
    presentationByStage: confirmations.length ? confirmations.map((c, i) => `${i}:${c?.status === 'ready' ? c.total : '欠測'}`).join('; ') : null,
    unexposedTotal: run?.oracle?.unexposedHeldOut.total ?? null, unexposedCaptured: run?.oracle?.unexposedHeldOut.captured ?? null,
    unexposedRecall: run?.oracle?.unexposedHeldOut.recall ?? null,
    withoutLoopRecall: metric(entry, 'C1')?.heldOutRecall ?? null, withLoopRecall: final?.heldOutRecall ?? null };
}

export function buildReport(config: RerunConfig, slots: Slot[], entries: Entry[]) {
  const current = entries.filter((entry) => entry.job.arm === 'current');
  const candidateLosses: Row[] = current.flatMap((entry) => {
    const run = entry.run;
    if (!run || run.status !== 'completed') return [];
    let auditPriorId = 'C0';
    const auditPriors = new Map<string, string>();
    for (const trial of run.adoptionAudit?.trials ?? []) {
      auditPriors.set(trial.candidateId, auditPriorId);
      if (trial.accepted) auditPriorId = trial.candidateId;
    }
    return (run.optimization?.trials ?? []).filter((trial) => trial.kind === 'proposal' && !trial.accepted).map((trial) => {
      const candidate = run.rejectedCandidates?.find((item) => item.candidateId === trial.candidateId);
      const trialAudit = run.adoptionAudit?.trials.find((item) => item.candidateId === trial.candidateId);
      const hasPriorComparison = candidate !== undefined && 'comparedToPrior' in candidate;
      const priorId = candidate?.priorId ?? auditPriors.get(trial.candidateId) ?? null;
      const prior = run.rejectedCandidates?.find((item) => item.candidateId === priorId);
      return { id: entry.job.id, case: entry.job.caseId, c0: entry.job.c0, split: entry.job.split,
        candidateId: trial.candidateId, held: trial.held ? 1 : 0, lostHits: trial.impact?.lostHits ?? null,
        sampleMethod: trial.impact?.sample?.method ?? null, priorId,
        hitsPrior: hasPriorComparison ? priorId === 'C0' ? hits(entry, 'C0') : prior?.hits ?? null : trialAudit?.hitsBefore ?? null,
        hitsCandidate: candidate?.hits ?? trialAudit?.hitsAfter ?? null,
        lostHeldOutPrior: names(hasPriorComparison ? candidate.comparedToPrior?.lostHeldOut ?? null
          : trialAudit && !trialAudit.error && !run.denominator?.manualReviewPending ? trialAudit.lostHeldOut : null),
        lostHeldOutC0: names(candidate?.comparedToC0?.lostHeldOut ?? null),
        lostReportsPrior: hasPriorComparison ? candidate.comparedToPrior?.lostReports?.length ?? null : null,
        priorSource: hasPriorComparison ? 'rejectedCandidates' : trialAudit ? 'adoptionAudit' : null };
    });
  });
  const aEntries = entries.filter((entry) => entry.job.arm === 'legacyLive' || entry.job.arm === 'current' && entry.job.variant === 'criteria-only');
  const layerARuns: Row[] = aEntries.map((e) => ({ id: e.job.id, case: e.job.caseId, role: role(e.job.caseId), arm: e.job.arm, status: status(e),
    C0Recall: metric(e, 'C0')?.heldOutRecall ?? null, C0Hits: hits(e, 'C0'),
    C1Recall: metric(e, 'C1')?.heldOutRecall ?? null, C1Hits: hits(e, 'C1') }));
  const layerA = config.cases.flatMap((id) => ['current', 'legacyLive'].map((arm) => aggregateA(id, arm, aEntries.filter((e) => e.job.caseId === id && e.job.arm === arm))));
  for (const r of ['development', 'confirmation']) {
    for (const arm of ['current', 'legacyLive']) layerA.push(aggregateA(`小計:${r}`, arm, aEntries.filter((e) => role(e.job.caseId) === r && e.job.arm === arm)));
  }
  const layerB: Row[] = current.map((entry) => {
    const old = entries.find((e) => e.job.arm === 'legacy' && e.job.caseId === entry.job.caseId && e.job.c0 === entry.job.c0 && e.job.split === entry.job.split);
    const nowMetric = metric(entry, 'C1'); const oldMetric = old ? metric(old, 'C1') : null;
    const nowAudit = audit(entry); const oldAudit = old ? audit(old) : null;
    const lost = nowMetric && oldMetric ? subtract(oldMetric.capturedHeldOut, nowMetric.capturedHeldOut) : null;
    const gained = nowMetric && oldMetric ? subtract(nowMetric.capturedHeldOut, oldMetric.capturedHeldOut) : null;
    return { case: entry.job.caseId, role: role(entry.job.caseId), c0: entry.job.c0, split: entry.job.split,
      currentStatus: status(entry), legacyStatus: old ? status(old) : '欠測',
      currentHits: hits(entry, 'C1'), legacyHits: old ? hits(old, 'C1') : null, deltaHits: delta(hits(entry, 'C1'), old ? hits(old, 'C1') : null),
      currentRecall: nowMetric?.heldOutRecall ?? null, legacyRecall: oldMetric?.heldOutRecall ?? null,
      deltaRecall: delta(nowMetric?.heldOutRecall, oldMetric?.heldOutRecall),
      currentStop: entry.run?.optimization?.stopReason ?? null, legacyStop: old?.run?.optimization?.stopReason ?? null,
      currentAdopted: nowAudit?.adopted ?? null, legacyAdopted: oldAudit?.adopted ?? null,
      currentHarmful: nowAudit?.harmfulAdopted ?? null, legacyHarmful: oldAudit?.harmfulAdopted ?? null,
      currentUnscoredAdopted: nowAudit?.unscoredAdopted ?? null, legacyUnscoredAdopted: oldAudit?.unscoredAdopted ?? null,
      deltaAdopted: delta(nowAudit?.adopted, oldAudit?.adopted), deltaHarmful: delta(nowAudit?.harmfulAdopted, oldAudit?.harmfulAdopted),
      lostToCurrent: names(lost), gainedToCurrent: names(gained), lostCount: lost?.length ?? null, 原因: '' };
  });
  const c = current.map(layerC);
  const layerCRoles: Row[] = ['development', 'confirmation'].map((r) => {
    const rows = c.filter((row) => row.role === r);
    return { role: r, runs: rows.length, completed: rows.filter((row) => row.status === '完了').length,
      failed: rows.filter((row) => row.status === '失敗').length, missing: rows.filter((row) => row.status === '欠測').length,
      recoveredRuns: rows.filter((row) => Number(row.recoveredCount) > 0).length,
      recoveredCases: new Set(rows.filter((row) => Number(row.recoveredCount) > 0).map((row) => row.case)).size,
      unmeasuredRecovery: rows.filter((row) => row.recoveredCount === null).length,
      presentedPmids: rows.reduce((sum, row) => sum + Number(row.presentedPmids ?? 0), 0),
      presentationMissing: rows.filter((row) => row.presentedPmids === null).length,
      includedPmids: rows.reduce((sum, row) => sum + Number(row.includedPmids ?? 0), 0) };
  });
  const harmful = current.map(audit);
  const unscored = harmful.filter((a) => a?.harmfulAdopted == null || a.unscoredAdopted > 0).length;
  const harmfulCount = harmful.reduce((sum, a) => sum + (a?.harmfulAdopted ?? 0), 0);
  const oldHarmful = layerB.filter((row) => Number(row.legacyHarmful) > 0);
  const s1 = harmfulCount > 0 ? no : !current.length || unscored || layerB.some((row) => row.legacyHarmful === null) ? missing
    : oldHarmful.length ? `要手動分類（旧版の有害採用がある ${oldHarmful.length} 組で同種候補の保留・却下を照合）` : yes;
  const s2Rows = layerB.filter((row) => Number(row.lostCount) > 0);
  const s2 = `要手動分類（${s2Rows.length} 組）${!layerB.length || layerB.some((row) => row.lostCount === null) ? ' / 欠測で判定不能' : ''}`;
  const caseComparisons: Row[] = config.cases.map((id) => {
    const newRow = layerA.find((row) => row.case === id && row.arm === 'current')!;
    const oldRow = layerA.find((row) => row.case === id && row.arm === 'legacyLive')!;
    const complete = Number(newRow.runs) > 0 && Number(oldRow.runs) > 0 && newRow.C1_heldOutRecall_missing === 0 && oldRow.C1_heldOutRecall_missing === 0;
    return { case: id, role: role(id), currentMedian: newRow.C1_heldOutRecall_median!, legacyMedian: oldRow.C1_heldOutRecall_median!,
      currentHitsMedian: newRow.C1_hits_median!, legacyHitsMedian: oldRow.C1_hits_median!,
      result: !complete ? missing : Number(newRow.C1_heldOutRecall_median) >= Number(oldRow.C1_heldOutRecall_median) ? yes : no };
  });
  const wins = caseComparisons.filter((row) => row.result === yes).length;
  const unknown = caseComparisons.filter((row) => row.result === missing).length;
  const s3 = !config.cases.length ? missing : wins > config.cases.length / 2 ? yes : wins + unknown <= config.cases.length / 2 ? no : missing;
  const roleSuccess = layerCRoles.map((row) => Number(row.recoveredCases) > 0 ? yes : !row.runs || Number(row.unmeasuredRecovery) > 0 ? missing : no);
  const s4 = roleSuccess.every((value) => value === yes) ? yes : roleSuccess.includes(no) ? no : missing;
  const s5Runs: Row[] = current.map((entry) => {
    const recall = metric(entry, 'C1')?.heldOutRecall;
    const achieved = status(entry) === '完了' && entry.run?.optimization?.status === 'achieved';
    const relevant = achieved && recall != null && recall < 1;
    const confirmation = entry.run?.confirmation;
    return { id: entry.job.id, case: entry.job.caseId, status: status(entry), achieved: achieved ? 1 : 0, recall: recall ?? null,
      achievedWithMisses: relevant ? 1 : 0,
      confirmationTotal: confirmation?.status === 'ready' ? confirmation.total : null,
      zeroCandidates: relevant && confirmation?.status === 'ready' && confirmation.total === 0 ? 1 : 0 };
  });
  const s5Denominator = s5Runs.filter((row) => row.achievedWithMisses === 1).length;
  const s5Numerator = s5Runs.filter((row) => row.zeroCandidates === 1).length;
  const s5Missing = s5Runs.filter((row) => row.status !== '完了' || row.recall === null || row.achievedWithMisses === 1 && row.confirmationTotal === null).length;
  const s5: Row[] = [{ runs: current.length, achievedWithMisses: s5Denominator, zeroCandidates: s5Numerator,
    proportion: s5Denominator && !s5Missing ? s5Numerator / s5Denominator : null, missing: s5Missing }];
  const s5Judgment = !current.length || s5Missing ? missing : `満たす（割合の報告: ${s5Numerator}/${s5Denominator}${s5Denominator ? ` = ${s5Numerator / s5Denominator}` : '、対象 0 件・割合は定義しない'}。合否の閾値は設定されていない）`;
  const quality: Row[] = slots.map((slot) => ({ id: slot.id, case: slot.caseId, variant: slot.variant, name: slot.name,
    status: slot.name ? '完了' : slot.attempts.length ? '失敗' : '欠測', attempts: slot.attempts.length,
    failures: slot.attempts.filter((a) => !a.success).length,
    syntaxErrors: slot.attempts.filter((a) => !a.success && /構文|syntax|phrase.*not found|invalid.*(?:query|mesh)/i.test(a.error ?? '')).length,
    reasons: slot.attempts.filter((a) => !a.success).map((a) => `${a.draft}: ${a.error}`).join('; ') }));
  const qualityRates: Row[] = config.cases.flatMap((id) => ['criteria-only', 'seeded'].map((variant) => {
    const rows = quality.filter((row) => row.case === id && row.variant === variant);
    const attempts = rows.reduce((sum, row) => sum + Number(row.attempts), 0);
    const errors = rows.reduce((sum, row) => sum + Number(row.syntaxErrors), 0);
    return { case: id, variant, attempts, syntaxErrors: errors, syntaxErrorRate: attempts ? errors / attempts : null,
      unattemptedSlots: rows.filter((row) => row.attempts === 0).length };
  }));
  const costs: Row[] = ['current', 'legacy', 'legacyLive'].map((arm) => {
    const armEntries = entries.filter((entry) => entry.job.arm === arm);
    const runs = armEntries.flatMap((entry) => entry.run ? [entry.run] : []);
    const usages = armEntries.map((entry) => {
      const recorded = entry.run?.llmUsage;
      return { usage: recorded ?? usageFromLogs(entry), fromLogs: recorded == null };
    });
    return { arm, expectedRuns: armEntries.length, runs: runs.length, completed: armEntries.filter((e) => status(e) === '完了').length,
      failed: armEntries.filter((e) => status(e) === '失敗').length, missing: armEntries.filter((e) => status(e) === '欠測').length,
      costUsdKnownSum: usages.some((r) => r.usage?.costUsd != null) ? usages.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0) : null,
      costMissing: armEntries.length - usages.filter((r) => r.usage?.costUsd != null).length,
      costFromLogs: usages.filter((r) => r.fromLogs && r.usage).length,
      llmCallsKnownSum: usages.some((r) => r.usage) ? usages.reduce((sum, r) => sum + (r.usage?.calls ?? 0), 0) : null,
      llmCallsMissing: armEntries.length - usages.filter((r) => r.usage).length,
      ncbiKnownSum: runs.some((r) => r.apiCalls?.ncbi != null) ? runs.reduce((sum, r) => sum + (r.apiCalls?.ncbi ?? 0), 0) : null,
      ncbiMissing: armEntries.length - runs.filter((r) => r.apiCalls?.ncbi != null).length,
      elapsedMsKnownSum: runs.some((r) => r.elapsedMs != null) ? runs.reduce((sum, r) => sum + (r.elapsedMs ?? 0), 0) : null,
      elapsedMissing: armEntries.length - runs.filter((r) => r.elapsedMs != null).length };
  });
  const judgments = { S1: `${s1}（新有害採用 ${harmfulCount}、未採点 run ${unscored}）`, S2: s2,
    S3: `${s3}（${wins}/${config.cases.length} ケース、欠測 ${unknown}）`, S4: `${s4}（development: ${roleSuccess[0]} / confirmation: ${roleSuccess[1]}）`, S5: s5Judgment };
  return { judgments, tables: { layerA, layerARuns, layerB, layerC: c, layerCRoles, S1Manual: oldHarmful, S2Causes: s2Rows,
    S3Cases: caseComparisons, S5: s5, S5Runs: s5Runs, c0Quality: quality, c0QualityRates: qualityRates, costs, candidateLosses } };
}

function markdown(rows: Row[]): string {
  if (!rows.length) return '0 件\n';
  const keys = Object.keys(rows[0]!);
  const cell = (value: Cell | undefined) => value == null ? '欠測' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  return `| ${keys.join(' | ')} |\n| ${keys.map(() => '---').join(' | ')} |\n`
    + rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(' | ')} |`).join('\n') + '\n';
}
export function csv(rows: Row[]): string {
  if (!rows.length) return '件数\r\n0\r\n';
  const keys = Object.keys(rows[0]!);
  const cell = (value: Cell | undefined) => `"${String(value ?? '欠測').replace(/"/g, '""')}"`;
  return [keys.map(cell).join(','), ...rows.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
export function report(config: RerunConfig, paths: Paths = defaultPaths) {
  const slots = makeSlots(config, readSlots(paths));
  const ledger = readLedger(join(paths.results, 'rerun/ledger.jsonl'));
  const entries: Entry[] = buildRunJobs(config, slots, paths).map((job) => ({ job, run: readJson<RunResult>(job.expected),
    scored: readJson<Entry['scored']>(join(dirname(job.expected), 'scored.json')), ledger: ledger.get(job.id) }));
  const result = buildReport(config, slots, entries);
  const output = join(paths.results, 'rerun');
  mkdirSync(output, { recursive: true });
  const notes = '\nS1 は全 run の有害採用 0 に加え、旧版で有害採用があった C0 の同種候補の保留・却下を人が照合する。S2 の原因は空欄を人が分類し、調整ロジック起因 0 を確認する。\n\n'
    + 'candidateLosses は直前の採用済み式との比較を主とし、C0 比も併記する。既存 run は研究単位の直前比だけで、報告単位は欠測になる。\n\n'
    + '旧版はハーネスが `llmUsage` を記録しないため、LLM 呼び出しログのトークン数から同じ単価表で算出した。costFromLogs は使用量をログから復元した run 数（価格表外・トークン不明による費用欠測も含む）。ログの欠落・破損は欠測として数える。\n\n'
    + 'S5 は割合の報告であり、合否の数値閾値はない。ハーネスは画面の区分を作らないため、基本 run の確認負荷が ready かつ total=0 を「確認済み」の近似とする。対象 0 件では割合を定義しない。\n\n'
    + '提示負担は基本 run と各ラウンドの確認候補 PMID 数の合計（段階間は重複を数える）。include 数は実行された模擬判定の合計。構文エラー率は失敗理由の「構文 / syntax / phrase not found / invalid query・mesh」による機械分類で、他の失敗理由も枠の表で確認する。費用の合計は観測済み部分のみで、欠測数を併記する。層 A の role 小計は run をプールした参考分布。\n';
  let md = '# 再評価の集計\n\n' + Object.entries(result.judgments).map(([key, value]) => `${key}: ${value}`).join('\n\n') + '\n' + notes;
  for (const [name, rows] of Object.entries(result.tables)) {
    writeFileSync(join(output, `${name}.csv`), mask(csv(rows)));
    md += `\n## ${name}\n\n${markdown(rows)}`;
  }
  writeFileSync(join(output, 'summary.md'), mask(md));
  process.stdout.write(`集計 ${entries.length} 実行: ${join(output, 'summary.md')}\n`);
  return result;
}
export function main(args: string[]): void {
  let configPath = CONFIG;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error('--config <path> だけを指定できます');
    configPath = resolve(args[1]);
  }
  report(readConfig(configPath));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(mask(String(error)) + '\n'); process.exitCode = 1; }
}
