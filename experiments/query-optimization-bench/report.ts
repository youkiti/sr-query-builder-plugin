import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES } from './prepare';
import { RESULTS } from './run';
import type { RunResult } from './types';

export function reportRows(results: RunResult[], baselines: Record<string, string> = {}): string[][] {
  const rows = [['profile', 'case', 'condition', 'status', 'hits', 'heldOutRecall', 'allStudyRecall', 'knownIncludedReportShare',
    'recordsPerKnownIncludedStudy', 'lostStudies', 'gainedStudies', 'lostHeldOut', 'gainedHeldOut', 'outcome', 'stopReason', 'iterations', 'apiCalls', 'elapsedMs', 'query',
    'role', 'c0', 'seedSplit', 'maxHits', 'gitCommit', 'adopted', 'harmfulAdopted', 'confirmationTotal', 'heldOutAmongCandidates',
    'llmCostUsd', 'llmTokensIn', 'llmTokensOut']];
  for (const result of results) {
    const c0Label = result.c0 ? `${result.c0.source}${result.c0.id ? `:${result.c0.id}` : ''}` : '欠測';
    for (const condition of ['C0', 'C1', 'B1'] as const) {
      const item = result.conditions[condition];
      const metrics = item?.metrics;
      const status = !item ? condition === 'B1' && baselines[result.id] ? '未計測' : condition === 'B1' ? '欠測' : result.error ? `失敗: ${result.error}` : result.status
        : item.measurement.status === 'failure' ? `失敗: ${item.measurement.error}`
          : result.denominator?.manualReviewPending ? '要手動監査（採点保留）' : 'success';
      const c1Only = condition === 'C1';
      rows.push([result.profileId ?? 'default', result.id, condition, status,
        item?.measurement.status === 'success' ? String(item.measurement.hits) : '欠測',
        ...[metrics?.heldOutRecall, metrics?.allStudyRecall, metrics?.knownIncludedReportShare, metrics?.recordsPerKnownIncludedStudy]
          .map((value) => value == null ? '欠測' : String(value)),
        c1Only ? result.comparison?.lostStudies.join('; ') ?? '欠測' : '',
        c1Only ? result.comparison?.gainedStudies.join('; ') ?? '欠測' : '',
        c1Only ? result.comparison?.lostHeldOut.join('; ') ?? '欠測' : '',
        c1Only ? result.comparison?.gainedHeldOut.join('; ') ?? '欠測' : '',
        c1Only ? result.comparison?.outcome ?? '欠測' : '',
        c1Only ? result.optimization?.stopReason ?? '欠測' : '',
        c1Only ? String(result.optimization?.iterations ?? '欠測') : '',
        String(result.apiCalls.ncbi + result.apiCalls.llm), String(result.elapsedMs),
        item?.query ?? (condition === 'B1' ? baselines[result.id] ?? '欠測' : ''),
        result.role ?? '欠測', c0Label, result.seedSplit ?? '欠測', String(result.maxHits ?? '欠測'), result.gitCommit ?? '欠測',
        c1Only ? String(result.adoptionAudit?.adopted ?? '欠測') : '',
        c1Only ? (result.adoptionAudit?.harmfulAdopted == null
          ? result.adoptionAudit?.harmfulAdopted === null && (result.adoptionAudit.unscoredAdopted ?? 0) > 0
            ? `未採点（${result.adoptionAudit.unscoredAdopted} 件）` : '欠測'
          : String(result.adoptionAudit.harmfulAdopted)) : '',
        c1Only ? (result.confirmation ? String(result.confirmation.total) : '欠測') : '',
        c1Only ? (result.confirmation ? result.confirmation.heldOutStudiesAmongCandidates.join('; ') : '欠測') : '',
        c1Only ? (result.llmUsage?.costUsd == null ? '欠測' : String(result.llmUsage.costUsd)) : '',
        c1Only ? String(result.llmUsage?.tokensIn ?? '欠測') : '',
        c1Only ? String(result.llmUsage?.tokensOut ?? '欠測') : '']);
    }
  }
  return rows;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** live な C0 は再生成のたびに揺れうるので、min/median/max も「ポリシーの効果」と読めない。 */
function c0VariantOf(result: RunResult): string {
  return result.c0?.source === 'frozen' ? (result.c0.variant ?? 'frozen') : 'live';
}

/**
 * role・profile・case・C0（live/variant）・シード分割でまとめ、頑健性（run 間のばらつき）を集計する。
 * 個々の run 行では見えない「同一条件で複数 run したときの散らばり」を可視化するための集計で、
 * 新しい指標を追加するものではない。
 */
export function aggregateRows(results: readonly RunResult[]): string[][] {
  const groups = new Map<string, RunResult[]>();
  for (const result of results) {
    const key = [result.role ?? '欠測', result.profileId ?? 'default', result.id, c0VariantOf(result), result.seedSplit ?? '欠測'].join('|');
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const header = ['role', 'profile', 'case', 'c0', 'seedSplit', 'runs',
    'c0HitsMin', 'c0HitsMedian', 'c0HitsMax', 'c1HitsMin', 'c1HitsMedian', 'c1HitsMax',
    'c1HeldOutRecallMin', 'c1HeldOutRecallMedian', 'c1HeldOutRecallMax',
    'improved', 'tradeoff', 'unchanged', 'worse', 'harmfulAdoptedTotal', 'confirmationTotalMedian', 'note'];
  const rows: string[][] = [header];
  for (const [key, runs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [role, profile, caseId, c0Variant, seedSplit] = key.split('|');
    const c0Hits = runs.map((r) => r.conditions.C0?.measurement.status === 'success' ? r.conditions.C0.measurement.hits : null).filter((v): v is number => v != null);
    const c1Hits = runs.map((r) => r.conditions.C1?.measurement.status === 'success' ? r.conditions.C1.measurement.hits : null).filter((v): v is number => v != null);
    const c1Recall = runs.map((r) => r.conditions.C1?.metrics?.heldOutRecall ?? null).filter((v): v is number => v != null);
    const outcomes = { improved: 0, tradeoff: 0, unchanged: 0, worse: 0 };
    for (const r of runs) if (r.comparison?.outcome) outcomes[r.comparison.outcome] += 1;
    // 採点保留（null）や監査なしの run を 0 件として足さない。採点できた run だけを合計し、除いた数を併記する。
    const harmfulScored = runs.map((r) => r.adoptionAudit?.harmfulAdopted ?? null).filter((v): v is number => v != null);
    const harmfulUnscored = runs.length - harmfulScored.length;
    const harmfulTotal = harmfulScored.length === 0 ? '欠測'
      : `${harmfulScored.reduce((sum, v) => sum + v, 0)}${harmfulUnscored ? `（未採点 ${harmfulUnscored} run を除く）` : ''}`;
    const confirmationTotals = runs.map((r) => r.confirmation?.status === 'ready' ? r.confirmation.total : null).filter((v): v is number => v != null);
    const note = c0Variant === 'live' ? 'live: C0 は run ごとに再生成される。run 間の差をポリシーの効果と解釈しない' : '';
    const fmt = (value: number | null) => value == null ? '欠測' : String(value);
    rows.push([role!, profile!, caseId!, c0Variant!, seedSplit!, String(runs.length),
      fmt(c0Hits.length ? Math.min(...c0Hits) : null), fmt(median(c0Hits)), fmt(c0Hits.length ? Math.max(...c0Hits) : null),
      fmt(c1Hits.length ? Math.min(...c1Hits) : null), fmt(median(c1Hits)), fmt(c1Hits.length ? Math.max(...c1Hits) : null),
      fmt(c1Recall.length ? Math.min(...c1Recall) : null), fmt(median(c1Recall)), fmt(c1Recall.length ? Math.max(...c1Recall) : null),
      String(outcomes.improved), String(outcomes.tradeoff), String(outcomes.unchanged), String(outcomes.worse),
      harmfulTotal, fmt(median(confirmationTotals)), note]);
  }
  return rows;
}

export function renderCsv(rows: string[][]): string {
  return rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
}

export function renderMarkdown(rows: string[][]): string {
  const row = (cells: string[]) => '| ' + cells.map((value) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, '<br>')).join(' | ') + ' |';
  return [row(rows[0]!), row(rows[0]!.map(() => '---')), ...rows.slice(1).map(row)].join('\n') + '\n';
}

/**
 * resultsDir 配下を再帰的に探索し、各系列の「最新の」run.json だけを集める。
 * 直下の run.json を集めたうえでサブディレクトリへ潜る。ただし親と子の両方が直下に
 * run.json を持つ場合、その子は試行履歴なので集めず探索もしない。このルールで
 * 旧レイアウト（results/<case>/run.json）・現行（results/<profile>/<case>/run.json）・
 * 新レイアウト（results/<profile>/<case>/<c0Key>/<splitKey>/run.json）のすべてを読める。
 */
function findRunFiles(dir: string): string[] {
  const runPath = join(dir, 'run.json');
  const hasRun = existsSync(runPath);
  return [...(hasRun ? [runPath] : []), ...readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const child = join(dir, entry.name);
      return hasRun && existsSync(join(child, 'run.json')) ? [] : findRunFiles(child);
    })];
}

export function report(resultsDir = RESULTS, fixturesDir = FIXTURES): void {
  mkdirSync(resultsDir, { recursive: true });
  const results: RunResult[] = [];
  const baselines: Record<string, string> = {};
  for (const path of findRunFiles(resultsDir)) {
    const result = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
    result.profileId ??= 'default';
    results.push(result);
    const b1 = join(fixturesDir, result.id, 'b1.json');
    if (existsSync(b1)) baselines[result.id] = (JSON.parse(readFileSync(b1, 'utf8')) as { query: string }).query;
  }
  results.sort((a, b) => a.id.localeCompare(b.id) || a.profileId.localeCompare(b.profileId));
  const rows = reportRows(results, baselines);
  writeFileSync(join(resultsDir, 'summary.csv'), renderCsv(rows));
  const aggregate = aggregateRows(results);
  writeFileSync(join(resultsDir, 'summary-aggregate.csv'), renderCsv(aggregate));
  const context = '分割は共有 PMID の群単位、再現率と捕捉・喪失・追加は研究単位。各研究の報告を 1 件以上捕捉すれば捕捉研究とする。recordsPerKnownIncludedStudy は hits / 捕捉研究数。現在の PubMed に作成日上限を適用した後ろ向き評価。完成レビューの適格基準を使い、ブロックは自動承認した（影響の向きは不明）。学習混入を排除できず、PMID のある既知研究に限定する。新規レビューの性能や専門家検索への非劣性は示さない。hits は選考時間ではない。補助指標だけで検索効率の優劣を結論しない。'
    + 'adopted/harmfulAdopted は C0→C1 で採用された候補のうち held-out を失った件数。比較できない採用があると harmfulAdopted は null（未採点）。confirmationTotal/heldOutAmongCandidates は outside check が'
    + '数えた確認対象候補（自動調整へは反映しない）、llmCostUsd 等は概算で未価格化モデルを含むと null。\n\n';
  writeFileSync(join(resultsDir, 'summary.md'), context + renderMarkdown(rows)
    + '\n\n## 頑健性の集計（role・profile・case・C0・シード分割ごと）\n\n'
    + '同一条件を複数 run したときの散らばりを示す（c0 が live の行は run ごとに C0 が再生成されるため、行間の差をポリシーの効果と解釈しない）。\n\n'
    + renderMarkdown(aggregate));
  process.stdout.write(`${results.length} ケースを集計しました\n`);
}

if (require.main === module) report();
