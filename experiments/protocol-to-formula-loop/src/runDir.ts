import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateConditions, type Conditions } from './conditions';

export interface RunInfo {
  version: string; pmcid: string; runIndex: number; cutoffDate: string; conditions: Conditions; createdAt: string;
}
export interface Budget { measurements: number; submissions: number }
export type ToolResult = '成功' | '検査不合格' | '上限超過' | '使えないコマンド' | '測定失敗（結果不明）';
export interface ToolLog {
  at: string; command: string; args: string; result: ToolResult; remaining: Budget;
}
export function runPath(root: string, version: string, pmcid: string, runIndex: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(version) || !/^PMC\d+$/.test(pmcid)
    || !Number.isSafeInteger(runIndex) || runIndex < 1) throw new Error('実行フォルダの識別子が不正です');
  return join(root, version, pmcid, `run-${runIndex}`);
}
export function createRun(options: Omit<RunInfo, 'createdAt'> & { root: string; protocolPath: string; now: () => Date }): string {
  const { root, version, pmcid, runIndex, cutoffDate, conditions, protocolPath, now } = options;
  validateConditions(conditions, version);
  const dir = runPath(root, version, pmcid, runIndex);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir);
  copyFileSync(protocolPath, join(dir, 'protocol.md'));
  writeJson(join(dir, 'run.json'), { version, pmcid, runIndex, cutoffDate, conditions, createdAt: now().toISOString() });
  writeJson(join(dir, 'budget.json'), { measurements: 0, submissions: 0 });
  return dir;
}
export function writeJson(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
export function readRun(dir: string): RunInfo {
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunInfo;
  validateConditions(run.conditions, run.version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(run.cutoffDate) || !Number.isFinite(Date.parse(run.cutoffDate))) throw new Error('検索日が不正です');
  return run;
}
export function readBudget(dir: string): Budget {
  const budget = JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8')) as Budget;
  if (![budget.measurements, budget.submissions].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('予算の記録が不正です');
  return budget;
}
export function recordToolCall(dir: string, budget: Budget, log: ToolLog): void {
  writeJson(join(dir, 'budget.json'), budget);
  appendFileSync(join(dir, 'tool-log.jsonl'), JSON.stringify(log) + '\n');
}
