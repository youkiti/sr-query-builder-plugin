import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES } from './prepare';
import { RESULTS } from './run';
import type { RunResult } from './types';

export function reportRows(results: RunResult[], baselines: Record<string, string> = {}): string[][] {
  const rows = [['profile', 'case', 'condition', 'status', 'hits', 'heldOutRecall', 'allStudyRecall', 'knownIncludedReportShare',
    'recordsPerKnownIncludedStudy', 'lostStudies', 'gainedStudies', 'lostHeldOut', 'gainedHeldOut', 'outcome', 'stopReason', 'iterations', 'apiCalls', 'elapsedMs', 'query']];
  for (const result of results) {
    for (const condition of ['C0', 'C1', 'B1'] as const) {
      const item = result.conditions[condition];
      const metrics = item?.metrics;
      const status = !item ? condition === 'B1' && baselines[result.id] ? '未計測' : condition === 'B1' ? '欠測' : result.error ? `失敗: ${result.error}` : result.status
        : item.measurement.status === 'failure' ? `失敗: ${item.measurement.error}`
          : result.denominator?.manualReviewPending ? '要手動監査（採点保留）' : 'success';
      rows.push([result.profileId ?? 'default', result.id, condition, status,
        item?.measurement.status === 'success' ? String(item.measurement.hits) : '欠測',
        ...[metrics?.heldOutRecall, metrics?.allStudyRecall, metrics?.knownIncludedReportShare, metrics?.recordsPerKnownIncludedStudy]
          .map((value) => value == null ? '欠測' : String(value)),
        condition === 'C1' ? result.comparison?.lostStudies.join('; ') ?? '欠測' : '',
        condition === 'C1' ? result.comparison?.gainedStudies.join('; ') ?? '欠測' : '',
        condition === 'C1' ? result.comparison?.lostHeldOut.join('; ') ?? '欠測' : '',
        condition === 'C1' ? result.comparison?.gainedHeldOut.join('; ') ?? '欠測' : '',
        condition === 'C1' ? result.comparison?.outcome ?? '欠測' : '',
        condition === 'C1' ? result.optimization?.stopReason ?? '欠測' : '',
        condition === 'C1' ? String(result.optimization?.iterations ?? '欠測') : '',
        String(result.apiCalls.ncbi + result.apiCalls.llm), String(result.elapsedMs),
        item?.query ?? (condition === 'B1' ? baselines[result.id] ?? '欠測' : '')]);
    }
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

export function report(resultsDir = RESULTS, fixturesDir = FIXTURES): void {
  mkdirSync(resultsDir, { recursive: true });
  const results: RunResult[] = [];
  const baselines: Record<string, string> = {};
  for (const entry of readdirSync(resultsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(resultsDir, entry.name);
    const legacyPath = join(dir, 'run.json');
    const paths = existsSync(legacyPath) ? [legacyPath]
      : readdirSync(dir, { withFileTypes: true }).filter((child) => child.isDirectory())
        .map((child) => join(dir, child.name, 'run.json')).filter((path) => existsSync(path));
    for (const path of paths) {
      const result = JSON.parse(readFileSync(path, 'utf8')) as RunResult;
      result.profileId ??= 'default';
      results.push(result);
      const b1 = join(fixturesDir, result.id, 'b1.json');
      if (existsSync(b1)) baselines[result.id] = (JSON.parse(readFileSync(b1, 'utf8')) as { query: string }).query;
    }
  }
  results.sort((a, b) => a.id.localeCompare(b.id) || a.profileId.localeCompare(b.profileId));
  const rows = reportRows(results, baselines);
  writeFileSync(join(resultsDir, 'summary.csv'), renderCsv(rows));
  const context = '分割は共有 PMID の群単位、再現率と捕捉・喪失・追加は研究単位。各研究の報告を 1 件以上捕捉すれば捕捉研究とする。recordsPerKnownIncludedStudy は hits / 捕捉研究数。現在の PubMed に作成日上限を適用した後ろ向き評価。完成レビューの適格基準を使い、ブロックは自動承認した（影響の向きは不明）。学習混入を排除できず、PMID のある既知研究に限定する。新規レビューの性能や専門家検索への非劣性は示さない。hits は選考時間ではない。補助指標だけで検索効率の優劣を結論しない。\n\n';
  writeFileSync(join(resultsDir, 'summary.md'), context + renderMarkdown(rows));
  process.stdout.write(`${results.length} ケースを集計しました\n`);
}

if (require.main === module) report();
