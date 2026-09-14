/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashC0Content, loadC0Artifact, type C0Content } from './c0Artifact';
import { computeHeldOut, FIXTURES, loadSeedsFile, parseSeedSplit, SEED, seedFileName, seedSplitId, validateSeeds } from './prepare';
import { decideExisting, main, parseArgs, resultDir } from './run';
import type { BenchCase, RunResult } from './types';

const root = mkdtempSync(join(tmpdir(), 'legacy-bench-'));
const id = 'extra-case';
const dir = join(root, id);
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'r3-vascular-bleeding', 'case.json'), 'utf8')) as BenchCase;
const alternate = { name: 'alternate', selections: fixture.gold.slice(-3).map((group) => ({ groupId: group.id, pmid: group.pmids[0]!, year: null })) };
const content: C0Content = {
  schemaVersion: 1, caseId: id, variant: 'criteria-only', draftIndex: 1, seedSplit: null,
  targetHits: 2000, model: 'fake', createdAt: '', gitCommit: null, gitDirty: null,
  protocol: { frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', studyDesign: '',
    sourceType: 'markdown', sourceFilename: 'protocol.md', rawTextRef: null, rawTextPreview: '', rawTextInline: '' },
  blocks: { blocks: [], combinationExpression: '' },
  formula: { blocks: [{ id: '1', expression: 'test[tiab]', isCombination: false }], combinationExpression: null },
  formulaMd: '', seedContext: null, blockApproval: 'auto',
};
const freeze = (name: string, value = content) => writeFileSync(join(dir, 'c0', name + '.json'), JSON.stringify({ ...value, sha256: hashC0Content(value) }));

beforeAll(() => {
  mkdirSync(join(dir, 'c0'), { recursive: true });
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ ...fixture, id, searchDate: '2001-02-03' }));
  writeFileSync(join(dir, 'audit.json'), readFileSync(join(FIXTURES, 'r3-vascular-bleeding', 'audit.json')));
  writeFileSync(join(dir, fixture.protocolPath), 'local protocol');
  writeFileSync(join(dir, 'seeds.json'), JSON.stringify(fixture.seeds));
  writeFileSync(join(dir, 'seeds-alternate.json'), JSON.stringify(alternate));
  writeFileSync(join(dir, 'seeds-7.json'), JSON.stringify({ seed: 7, selections: alternate.selections }));
  freeze('draft1');
});
afterEach(() => { jest.restoreAllMocks(); process.exitCode = 0; });

test('既定と追加の引数を解釈し、fixtures にある追加ケースを選ぶ', () => {
  expect(parseArgs([])).toMatchObject({ fixturesDir: FIXTURES, seed: SEED, c0Name: undefined });
  expect(parseArgs(['--case', id, '--fixtures', root, '--results', join(root, 'results'), '--profile', 'rerun-2000',
    '--seeds', 'alternate', '--c0', 'draft1', '--label', 'legacy.v1', '--dry-run']))
    .toMatchObject({ ids: [id], seed: 'alternate', c0Name: 'draft1', label: 'legacy.v1', dryRun: true, profile: { maxHits: 2000, maxIterations: 5 } });
  expect(parseArgs(['--fixtures', root]).ids).toHaveLength(3);
  expect(parseArgs(['--seeds', '7']).seed).toBe(7);
});

test.each([
  ['--fixtures', 'relative'], ['--results', 'relative'], ['--case', '../escape'], ['--c0', '../escape'], ['--c0', 'live'],
  ['--label', 'replay-test'], ['--label', 'Replay-test'], ['--label', 'a+b'], ['--label', ''], ['--label', 'a'.repeat(41)],
  ['--seeds', '01'], ['--seeds', '-1'], ['--seeds', '1.2'], ['--seeds', 's123'], ['--seeds', 's-123'],
  ['--seeds', 'UPPER'], ['--seeds', '9007199254740992'], ['--seeds', 'a'.repeat(33)],
  ...['--fixtures', '--results', '--c0', '--seeds', '--label'].map((arg) => [arg]),
  ['--c0', 'a', '--c0', 'b'], ['--seeds', '1', '--seeds', '2'], ['--label', 'a', '--label', 'b'],
])('不正引数を拒否: %j', (...args: string[]) => {
  expect(() => parseArgs(args)).toThrow();
});

test('整数と名前付き分割を読み、選んだ群を held-out から除く', () => {
  expect(parseSeedSplit('0')).toBe(0);
  expect(seedFileName(SEED)).toBe('seeds.json');
  expect(seedFileName(7)).toBe('seeds-7.json');
  expect(seedSplitId(7)).toBe('s7');
  expect(seedSplitId('alternate')).toBe('alternate');
  const seeds = loadSeedsFile(dir, 'alternate');
  validateSeeds(seeds, fixture.gold);
  expect(computeHeldOut(fixture.gold, seeds)).toEqual(fixture.gold.slice(0, -3).map((group) => group.id));
  expect(computeHeldOut(fixture.gold, loadSeedsFile(dir, 7))).toEqual(computeHeldOut(fixture.gold, seeds));
  expect(computeHeldOut(fixture.gold, fixture.seeds)).toEqual(fixture.heldOut);
  writeFileSync(join(dir, 'seeds-wrong.json'), JSON.stringify(alternate));
  expect(() => loadSeedsFile(dir, 'wrong')).toThrow('一致');
  expect(() => loadSeedsFile(dir, 8)).toThrow('見つかりません');
  expect(() => validateSeeds({ ...alternate, selections: alternate.selections.slice(1) }, fixture.gold)).toThrow();
});

test('C0 の内容変更、ケース不一致、欠落を拒否する', () => {
  expect(loadC0Artifact(root, id, 'draft1').sha256).toBe(hashC0Content(content));
  writeFileSync(join(dir, 'c0', 'bad.json'), JSON.stringify({ ...content, model: 'changed', sha256: hashC0Content(content) }));
  expect(() => loadC0Artifact(root, id, 'bad')).toThrow('ハッシュ');
  freeze('wrong-case', { ...content, caseId: 'other' });
  expect(() => loadC0Artifact(root, id, 'wrong-case')).toThrow('ケース ID');
  expect(() => loadC0Artifact(root, id, 'absent')).toThrow('見つかりません');
});

test('保存先を C0・分割・ラベルで分離し、完了結果をコミットと上限で判定する', () => {
  expect(resultDir(root, 'rerun-2000', id, 'draft1', 'alternate', 'legacy')).toBe(join(root, 'rerun-2000', id, 'draft1', 'alternate+legacy'));
  expect(resultDir(root, 'default', id, 'live', 's7')).toBe(join(root, 'default', id, 'live', 's7'));
  const existing = { status: 'completed', maxHits: 2000, gitCommit: 'old' } as RunResult;
  expect(decideExisting(existing, { maxHits: 2000 }, 'old')).toBe('skip');
  expect(() => decideExisting(existing, { maxHits: 2000 }, 'new')).toThrow('別コミット');
  expect(decideExisting(existing, { maxHits: 1000 }, 'new')).toBe('run');
  expect(decideExisting({ ...existing, status: 'failed' }, { maxHits: 2000 }, 'new')).toBe('run');
});

test('dry-run は書き込みも通信もせず、凍結 C0 と指定分割を検証して1行表示する', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const before = readdirSync(root, { recursive: true });
  const args = ['--fixtures', root, '--results', join(root, 'results'), '--case', id, '--profile', 'rerun-2000',
    '--c0', 'draft1', '--seeds', 'alternate', '--label', 'legacy', '--dry-run'];
  await main(args);
  expect(output).toHaveBeenCalledTimes(1);
  expect(output.mock.calls[0]![0]).toMatch(/dry-run OK.*profile=rerun-2000.*seedSplit=alternate, c0=draft1, label=legacy/);
  expect(readdirSync(root, { recursive: true })).toEqual(before);
  expect(existsSync(join(root, 'results'))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(process.exitCode).not.toBe(1);
  freeze('seeded', { ...content, seedSplit: 's7' });
  await main(args.map((arg) => arg === 'draft1' ? 'seeded' : arg));
  expect(process.exitCode).toBe(1);
  expect(output.mock.calls[output.mock.calls.length - 1]![0]).toContain('分割');
  await main(args.map((arg) => arg === 'draft1' ? 'bad' : arg));
  expect(output.mock.calls[output.mock.calls.length - 1]![0]).toContain('ハッシュ');
});
