/** @jest-environment node */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { collectLegacyRuns, main } from './scoreLegacy';
import { computeAdoptionAudit } from './adoptionAudit';
import { getGitCommit, isGitDirty } from './gitInfo';
import type { RunResult } from './types';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('./adoptionAudit', () => ({ computeAdoptionAudit: jest.fn() }));
jest.mock('./gitInfo', () => ({ getGitCommit: jest.fn(), isGitDirty: jest.fn() }));

let root: string;
let output: jest.SpyInstance;
const adoptionAudit = { adopted: 0, unscoredAdopted: 0, harmfulAdopted: 0, trials: [] };
const denominator = { groups: [{ id: 'shared', pmids: ['4', '5'], members: [
  { studyId: 'd', pmids: ['4'] }, { studyId: 'e', pmids: ['4', '5'] },
] }], heldOut: ['shared'], outsideDatePmids: ['6'], outsideDateGroups: [], manualReviewPending: false };
const writeRun = (name: string, changes: Partial<RunResult> = {}) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run.json');
  writeFileSync(path, JSON.stringify({ runId: 'attempt', legacy: true, status: 'completed', searchDate: '2021-04-15',
    denominator, conditions: {}, ...changes }, null, 2));
  return path;
};

beforeEach(() => {
  jest.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'score-legacy-'));
  output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.mocked(getGitCommit).mockReturnValue('current');
  jest.mocked(isGitDirty).mockReturnValue(false);
  jest.mocked(computeAdoptionAudit).mockResolvedValue(adoptionAudit);
  process.exitCode = 0;
});
afterEach(() => { jest.restoreAllMocks(); process.exitCode = 0; });

test('再帰収集は試行ディレクトリを除外し、重複パスをまとめる', () => {
  const path = writeRun('case/split');
  const attempt = writeRun('case/split/attempt');
  writeFileSync(join(root, 'other.json'), '{}');
  expect(collectLegacyRuns([root, path, attempt])).toEqual([path]);
});

test('legacy 完了だけを採点し、保存済みの分母をそのまま渡して原本を変えない', async () => {
  const path = writeRun('a');
  writeRun('b', { legacy: false });
  writeRun('c', { status: 'failed' });
  const original = readFileSync(path, 'utf8');
  const fetch = jest.fn();
  await main([root], { fetch });
  expect(computeAdoptionAudit).toHaveBeenCalledTimes(1);
  expect(jest.mocked(computeAdoptionAudit).mock.calls[0]![0].denominator).toEqual(denominator);
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(join(root, 'a/scored.json'), 'utf8'))).toEqual({ adoptionAudit,
    scoredAt: expect.any(String), gitCommit: 'current', gitDirty: false, source: 'attempt' });
  expect(existsSync(join(root, 'a/scored.json.tmp'))).toBe(false);
  expect(output.mock.calls.flat().join('')).toContain('legacy ではありません');
  expect(output.mock.calls.flat().join('')).toContain('未完了');
  expect(fetch).not.toHaveBeenCalled();
});

test('同一コミットはスキップし、別コミットのエラー後も次のファイルを採点する', async () => {
  for (const name of ['a', 'b', 'c']) writeRun(name);
  writeFileSync(join(root, 'a/scored.json'), JSON.stringify({ gitCommit: 'current' }));
  writeFileSync(join(root, 'b/scored.json'), JSON.stringify({ gitCommit: 'old' }));
  await main([root], { fetch: jest.fn() });
  expect(computeAdoptionAudit).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(existsSync(join(root, 'c/scored.json'))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, 'b/scored.json'), 'utf8')).gitCommit).toBe('old');
  expect(output.mock.calls.flat().join('')).toContain('採点済み');
  expect(output.mock.calls.flat().join('')).toContain('別コミット');
});

test('dry-run は env・通信・保存をせず対象と保存先を表示し、空なら対象 0 件を出す', async () => {
  const path = writeRun('a');
  await main([path, '--dry-run']);
  expect(config).not.toHaveBeenCalled();
  expect(computeAdoptionAudit).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'a/scored.json'))).toBe(false);
  expect(output.mock.calls.flat().join('')).toContain(join(root, 'a/scored.json'));
  await main(['--dry-run']);
  expect(output.mock.calls.flat().join('')).toContain('対象 0 件');
});

test('通信に検索日制限を付け、例外に含まれるキーをマスクする', async () => {
  const path = writeRun('a');
  const oldKey = process.env.NCBI_API_KEY;
  process.env.NCBI_API_KEY = 'secret-for-test';
  try {
    const fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    jest.mocked(computeAdoptionAudit).mockImplementation(async (_result, eutils) => {
      expect(eutils.apiKey).toBe('secret-for-test');
      await eutils.fetch('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=test');
      throw new Error('secret-for-test');
    });
    await main([path], { fetch, apiKey: process.env.NCBI_API_KEY });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.searchParams.get('datetype')).toBe('crdt');
    expect(url.searchParams.get('maxdate')).toBe('2021/04/15');
    expect(output.mock.calls.flat().join('')).not.toContain('secret-for-test');
  } finally {
    if (oldKey === undefined) delete process.env.NCBI_API_KEY;
    else process.env.NCBI_API_KEY = oldKey;
  }
});
