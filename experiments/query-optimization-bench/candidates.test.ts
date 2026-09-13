/** @jest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './candidates';
import { measureRejectedCandidates, resultDir } from './run';
import { calculateMetrics, compareMetrics } from './metrics';
import { CASES, type RunResult } from './types';
import type { OptimizationTrial } from '../../src/features/formula/skills/optimizeQuery';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';

/** run.ts と同じキー(live / 既定分割 s20260912)で run.json を置くディレクトリ。 */
const dirFor = (root: string, profileId: string, caseId: string) => resultDir(root, profileId, caseId, 'live', 's20260912');

const groups = ['1', '2'].map((pmid) => ({ id: pmid, pmids: [pmid], members: [{ studyId: pmid, pmids: [pmid] }] }));
const trial = (candidateId: string, accepted = false): OptimizationTrial => ({
  candidateId, accepted, kind: 'proposal', changes: { targetBlockId: '1', addedTerms: [], removedTerms: ['broad[tiab]'], replacedTerms: [] },
  formula: { blocks: [{ id: '1', expression: 'narrow[tiab]', isCombination: false },
    { id: '2', expression: '#1 AND other[tiab]', isCombination: true }], combinationExpression: '#2' },
  apiEvents: [], before: null, after: null, reason: 'Rejected by seed metrics', rationale: 'Reduce hits',
});
const makeResult = (): RunResult => ({
  id: CASES[1].id, runId: 'fake-run', status: 'completed', startedAt: '', model: 'fake', searchDate: '2022-05-27',
  profileId: 'default', maxHits: 10000, maxIterations: 5,
  denominator: { groups, heldOut: ['2'], outsideDatePmids: ['3'], outsideDateGroups: ['outside'], manualReviewPending: false },
  conditions: { C0: { query: 'broad[tiab]', measurement: { status: 'success', hits: 100, capturedPmids: ['1', '2'] },
    metrics: calculateMetrics(groups, ['2'], ['1', '2'], 100) } },
  optimization: { status: 'needs_review', stopReason: 'iteration_limit', best: null, unmetReasons: [], iterations: 2, apiCalls: 5, elapsedMs: 7,
    trials: [{ ...trial('initial'), kind: 'initial' }, trial('candidate-2'), trial('candidate-3', true), { ...trial('info'), kind: 'information' }] },
  apiCalls: { ncbi: 9, llm: 3 }, apiElapsedMs: { ncbi: 6, llm: 4 }, elapsedMs: 10, llmLogs: ['existing.json'],
});
const response = (count: number, idlist: string[] = []) => new Response(JSON.stringify({ esearchresult: { count: String(count), idlist } }));
const deps = (fetch: typeof globalThis.fetch): EutilsDeps => ({ fetch, maxRetries: 0, rateLimiter: { acquire: async () => undefined } });
let network: jest.SpyInstance;
let output: jest.SpyInstance;
beforeEach(() => {
  network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real API forbidden'));
  output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore(); output.mockRestore();
});

test('all proposals use expanded formulas, frozen denominator and the C0 date cutoff', async () => {
  const result = makeResult();
  const fetch = jest.fn().mockResolvedValueOnce(response(40)).mockResolvedValueOnce(response(1, ['1']))
    .mockResolvedValueOnce(response(50)).mockResolvedValueOnce(response(2, ['1', '2']));
  const measured = await measureRejectedCandidates(result, deps(fetch));
  expect(measured.map((candidate) => [candidate.candidateId, candidate.accepted, candidate.hits])).toEqual([
    ['candidate-2', false, 40], ['candidate-3', true, 50],
  ]);
  expect(measured[0]!.changes).toEqual(trial('x').changes);
  expect(measured[0]!.metrics).toEqual(calculateMetrics(groups, ['2'], ['1'], 40));
  expect(measured[0]!.comparedToC0).toEqual(compareMetrics(result.conditions.C0!.metrics!, measured[0]!.metrics!));
  expect(measured[0]!.comparedToC0!.lostHeldOut).toEqual(['2']);
  expect(measured[1]!.comparedToC0!.outcome).toBe('improved');
  for (const [url] of fetch.mock.calls) {
    const params = new URL(String(url)).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ datetype: 'crdt', mindate: '1800/01/01', maxdate: '2022/05/27' });
    expect(params.get('term')).toContain('(narrow[tiab]) AND other[tiab]');
    expect(params.get('term')).not.toContain('#');
    expect(params.get('term')).not.toContain('3[uid]');
  }
  expect(new URL(fetch.mock.calls[1]![0]).searchParams.get('term')).toContain('1[uid] OR 2[uid]');
});

test('API and formula failures remain unscored, while pending manual review suppresses metrics', async () => {
  const result = makeResult();
  result.optimization!.trials = [trial('candidate')];
  const failed = await measureRejectedCandidates(result, deps(jest.fn().mockResolvedValue(new Response('{}'))));
  expect(failed[0]).toMatchObject({ hits: null, metrics: null, comparedToC0: null, error: expect.any(String) });
  result.denominator!.manualReviewPending = true;
  const pending = await measureRejectedCandidates(result, deps(jest.fn().mockResolvedValue(response(0))));
  expect(pending[0]).toMatchObject({ hits: 0, metrics: null, comparedToC0: null });
  result.optimization!.trials[0]!.formula.blocks[0]!.expression = '#2';
  const fetch = jest.fn();
  const invalid = await measureRejectedCandidates(result, deps(fetch));
  expect(invalid[0]!.error).toContain('循環');
  expect(fetch).not.toHaveBeenCalled();
});

test('candidate-only CLI preserves existing data, skips measured candidates, and dry-run is read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-test-'));
  const result = { ...makeResult(), extraExistingData: { preserve: true } };
  const dir = dirFor(root, 'default', result.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run.json');
  const original = JSON.stringify(result);
  writeFileSync(path, original);
  const fetch = jest.fn().mockImplementation(async () => response(0));
  await main(['--case', result.id, '--dry-run'], root, deps(fetch));
  expect(fetch).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe(original);
  await main(['--case', result.id], root, deps(fetch));
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.rejectedCandidates).toHaveLength(2);
  delete saved.rejectedCandidates;
  expect(saved).toEqual(result);
  const measured = readFileSync(path, 'utf8');
  fetch.mockClear();
  await main(['--case', result.id], root, deps(fetch));
  expect(fetch).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe(measured);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('計測済み'));
});

test('no rejected candidates is an explicit no-op and missing denominator is an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-empty-'));
  const result = makeResult();
  result.optimization!.trials = [trial('accepted', true)];
  const dir = dirFor(root, 'default', result.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run.json');
  const original = JSON.stringify(result);
  writeFileSync(path, original);
  const fetch = jest.fn();
  await main(['--case', result.id], root, deps(fetch));
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(fetch).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledWith(`${result.id}: 却下候補なし; 追加計測なし\n`);
  result.optimization!.trials = [trial('rejected')];
  delete result.denominator;
  await expect(measureRejectedCandidates(result, deps(fetch))).rejects.toThrow('分母');
});

test.each([
  { args: [], count: 1 },
  { args: ['--profile', 'tight-1000'], count: 2 },
])('dry-run reads the selected profile: $args', async ({ args, count }) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-profile-'));
  const result = makeResult();
  const originals = ['default', 'tight-1000'].map((profileId, index) => {
    const dir = dirFor(root, profileId, result.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'run.json');
    const original = JSON.stringify({ ...result, profileId,
      optimization: { ...result.optimization, trials: Array.from({ length: index + 1 }, (_, i) => trial(`candidate-${i}`)) } });
    writeFileSync(path, original);
    return { path, original };
  });
  await main(['--case', result.id, '--dry-run', ...args], root);
  expect(output).toHaveBeenCalledWith(`${result.id}: dry-run; 却下候補=${count}, API calls=0\n`);
  for (const { path, original } of originals) expect(readFileSync(path, 'utf8')).toBe(original);
});

test.each([true, false])('missing run.json logs one line and continues (dry-run=%s)', async (dryRun) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-missing-'));
  const result = makeResult();
  result.optimization!.trials = [];
  const dir = dirFor(root, 'tight-1000', result.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...result, profileId: 'tight-1000' }));
  const fetch = jest.fn();
  await main(['--profile', 'tight-1000', ...(dryRun ? ['--dry-run'] : [])], root, deps(fetch));
  for (const { id } of CASES.filter(({ id }) => id !== result.id)) {
    expect(output.mock.calls.filter(([line]) => line === `${id}: run.json が存在しないためスキップ (profile=tight-1000)\n`)).toHaveLength(1);
  }
  expect(output).toHaveBeenCalledWith(dryRun
    ? `${result.id}: dry-run; 却下候補=0, API calls=0\n`
    : `${result.id}: 却下候補なし; 追加計測なし\n`);
  expect(fetch).not.toHaveBeenCalled();
});

test('invalid run.json remains an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-invalid-'));
  const dir = dirFor(root, 'default', CASES[0].id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), '{');
  await expect(main(['--case', CASES[0].id, '--dry-run'], root)).rejects.toThrow(SyntaxError);
  expect(output).not.toHaveBeenCalled();
});
