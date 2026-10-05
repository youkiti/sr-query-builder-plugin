/** @jest-environment node */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConditions } from './conditions';
import { createRun, readBudget, readRun, recordToolCall } from './runDir';

test('入力と条件だけを写し、既存フォルダを上書きせず、予算とログを保存する', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2f-run-'));
  const protocolPath = join(root, 'input.md');
  writeFileSync(protocolPath, '合成プロトコル');
  const options = { root, version: 'v0', pmcid: 'PMC0000001', runIndex: 1, cutoffDate: '2020-01-31',
    protocolPath, conditions: loadConditions('v0'), now: () => new Date('2026-01-01Z') };
  const dir = createRun(options);
  expect(readFileSync(join(dir, 'protocol.md'), 'utf8')).toBe('合成プロトコル');
  expect(Object.keys(readRun(dir)).sort()).toEqual(['version', 'pmcid', 'runIndex', 'cutoffDate', 'conditions', 'createdAt'].sort());
  expect(() => createRun(options)).toThrow();
  expect(readBudget(dir)).toEqual({ measurements: 0, submissions: 0 });
  const log = { at: options.now().toISOString(), command: 'check', args: '式ファイル 1 件', result: '成功' as const,
    remaining: { measurements: 20, submissions: 4 } };
  recordToolCall(dir, readBudget(dir), log);
  recordToolCall(dir, readBudget(dir), log);
  expect(readFileSync(join(dir, 'tool-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});
