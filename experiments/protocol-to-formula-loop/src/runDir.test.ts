/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConditions } from './conditions';
import { withRunLock, createRun, readBudget, readRun, recordToolCall } from './runDir';

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

test('ロック解放を200ミリ秒ごとに待ち、正常終了と例外で必ず解放する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-lock-'));
  const lock = join(dir, '.lock');
  mkdirSync(lock);
  let now = Date.now();
  const sleep = jest.fn(async (ms: number) => { now += ms; rmdirSync(lock); });
  const action = jest.fn(async () => { expect(existsSync(lock)).toBe(true); return 7; });
  expect(await withRunLock(dir, action, { now: () => now, sleep })).toBe(7);
  expect(sleep).toHaveBeenCalledWith(200);
  expect(action).toHaveBeenCalledTimes(1);
  expect(existsSync(lock)).toBe(false);
  await expect(withRunLock(dir, async () => { throw new Error('合成例外'); })).rejects.toThrow('合成例外');
  expect(existsSync(lock)).toBe(false);
});
test('上限で処理せず、10分より古い残骸は回収する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2f-lock-'));
  const lock = join(dir, '.lock');
  mkdirSync(lock);
  let now = Date.now();
  const action = jest.fn(async () => 1);
  expect(await withRunLock(dir, action, { timeoutMs: 400, now: () => now, sleep: async (ms) => { now += ms; } })).toBeNull();
  expect(action).not.toHaveBeenCalled();
  expect(existsSync(lock)).toBe(true);
  utimesSync(lock, new Date(now - 600_001), new Date(now - 600_001));
  expect(await withRunLock(dir, action, { now: () => now })).toBe(1);
  expect(existsSync(lock)).toBe(false);
});
