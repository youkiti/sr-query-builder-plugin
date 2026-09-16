/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { main, parseDiagnoseArgs, reportDiagnosis, quantile, type DiagnoseDeps, type DiagnosisRecord } from './blockDiagnose';
import { c0Dir, c0FixturePath, hashC0Content, type C0Content } from './c0Artifact';
import { sharedEutilsRateLimiters } from '../../src/lib/ncbi/eutils';
import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { BlockDiagnosis } from '../../src/features/validation/blockDiagnosis';

jest.mock('dotenv', () => ({ config: jest.fn() }));

let output: jest.SpyInstance;
beforeEach(() => {
  output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(sharedEutilsRateLimiters.withoutApiKey, 'acquire').mockResolvedValue(undefined);
  jest.spyOn(sharedEutilsRateLimiters.withApiKey, 'acquire').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const CASE_ID = 'r1-mindfulness-smoking';

/** テスト用の凍結 C0 を fixturesDir に書き出す。ブロックは非結合＋結合を 1 つずつ AND で結ぶだけの単純形。 */
function writeC0(dir: string, caseId: string, name: string, blocks: { id: string; expression: string; label: string }[]): void {
  const combination = blocks.map((b) => `#${b.id}`).join(' AND ');
  const formula: PubmedFormula = {
    blocks: [...blocks.map((b) => ({ id: b.id, expression: b.expression, isCombination: false })),
      { id: 'final', expression: combination, isCombination: true }],
    combinationExpression: combination,
  };
  const content: C0Content = {
    schemaVersion: 1, caseId, variant: 'criteria-only', draftIndex: 1, seedSplit: null, targetHits: 2000,
    model: 'test-model', createdAt: '2026-09-01T00:00:00.000Z', gitCommit: null, gitDirty: null,
    protocol: { frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'i', exclusionCriteria: '',
      studyDesign: 'any', sourceType: 'markdown', sourceFilename: 'protocol.md', rawTextRef: null, rawTextPreview: 'p', rawTextInline: 'p' },
    blocks: { blocks: blocks.map((b) => ({ blockLabel: b.label, description: '', aiGenerated: true, note: '' })), combinationExpression: combination },
    formula, formulaMd: '```\n#1 test\n```', seedContext: null, blockApproval: 'auto',
  };
  const sha256 = hashC0Content(content);
  mkdirSync(c0Dir(dir, caseId), { recursive: true });
  writeFileSync(c0FixturePath(dir, caseId, name), JSON.stringify({ ...content, sha256 }));
}

function writeCase(dir: string, caseId: string, searchDate: string): void {
  mkdirSync(join(dir, caseId), { recursive: true });
  writeFileSync(join(dir, caseId, 'case.json'), JSON.stringify({ searchDate }));
}

/** db=pubmed の esearch は `pubmed(term)` で件数（null なら HTTP 500）、db=mesh は `mesh` の対応表で解決する。 */
function fakeFetch(opts: { pubmed: (term: string) => number | null; mesh?: Record<string, string[]> }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const params = url.searchParams;
    const db = params.get('db');
    if (url.pathname.endsWith('/esearch.fcgi') && db === 'pubmed') {
      const hits = opts.pubmed(params.get('term') ?? '');
      if (hits === null) return new Response('error', { status: 500 });
      return new Response(JSON.stringify({ esearchresult: { count: String(hits), idlist: [] } }));
    }
    if (url.pathname.endsWith('/esearch.fcgi') && db === 'mesh') {
      const descriptor = (params.get('term') ?? '').replace(/\[mh\]$/, '');
      const tree = opts.mesh?.[descriptor];
      const uid = tree ? `uid-${descriptor.toLowerCase()}` : undefined;
      return new Response(JSON.stringify({ esearchresult: { count: uid ? '1' : '0', idlist: uid ? [uid] : [] } }));
    }
    if (url.pathname.endsWith('/esummary.fcgi') && db === 'mesh') {
      const ids = (params.get('id') ?? '').split(',').filter(Boolean);
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) {
        const descriptor = Object.keys(opts.mesh ?? {}).find((key) => `uid-${key.toLowerCase()}` === id);
        result[id] = { ds_recordtype: 'descriptor', ds_meshterms: descriptor ? [descriptor] : [],
          ds_idxlinks: (descriptor ? opts.mesh![descriptor] ?? [] : []).map((treenum) => ({ treenum })) };
      }
      return new Response(JSON.stringify({ result }));
    }
    throw new Error(`テストで想定していないリクエストです: ${url.toString()} ${JSON.stringify(init ?? {})}`);
  }) as typeof fetch;
}

function setup() {
  const resultsRoot = mkdtempSync(join(tmpdir(), 'block-diagnose-'));
  const fixturesRoot = mkdtempSync(join(tmpdir(), 'block-diagnose-fixtures-'));
  writeCase(fixturesRoot, CASE_ID, '2021-04-15');
  return { resultsRoot, fixturesRoot };
}

test.each([
  ['--unknown'],
  ['--case'],
  ['--case', 'unknown-case'],
  ['--case', CASE_ID, '--case', CASE_ID],
  ['--c0', 'x'],
  ['--harvest', '--report'],
  ['--harvest', '--dry-run'],
  ['--report', '--dry-run'],
  ['--label', '..'],
  ['--label', 'replay-x'],
  ['--results', '/tmp/x'],
  ['--run-label', 'x'],
  ['--run-label', '!!!'],
])('引数を拒否: %j', (...args) => {
  expect(() => parseDiagnoseArgs(args)).toThrow();
});

test('引数の既定値と --harvest の付随オプションを受け付ける', () => {
  expect(parseDiagnoseArgs([])).toMatchObject({ label: 'default', harvest: false, report: false, dryRun: false, runLabel: 'issue164-current' });
  expect(parseDiagnoseArgs(['--harvest', '--results', '/tmp/x', '--run-label', 'baseline']))
    .toMatchObject({ harvest: true, resultsDir: '/tmp/x', runLabel: 'baseline' });
  expect(parseDiagnoseArgs(['--case', CASE_ID, '--c0', 'seeded-draft1'])).toMatchObject({ caseId: CASE_ID, c0Name: 'seeded-draft1' });
});

test('同じ MeSH を 2 ブロックが持つ式で same の重なりが出る', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'same-c0', [
    { id: '1', expression: '"X"[Mesh]', label: 'ブロック1' },
    { id: '2', expression: '"X"[Mesh]', label: 'ブロック2' },
  ]);
  const deps: DiagnoseDeps = { fetch: fakeFetch({ pubmed: () => 50 }), eutils: { maxRetries: 0, sleep: async () => undefined } };
  await main(['--case', CASE_ID, '--c0', 'same-c0'], fixturesRoot, resultsRoot, deps);
  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'same-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.complete).toBe(true);
  expect(record.source).toBe('diagnosis-only');
  expect(record.diagnosis.overlaps).toEqual([expect.objectContaining({ blockIds: ['1', '2'], kind: 'same' })]);
  expect(record.diagnosis.fingerprint).toBe('');
  expect(record.finalQuery).toBe('("X"[Mesh]) AND ("X"[Mesh])');
});

test('上位語と explode で ancestor が出て、木が取れない語は unknown になる', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'ancestor-c0', [
    { id: '1', expression: '"Parent"[Mesh]', label: '親' },
    { id: '2', expression: '"Child"[Mesh]', label: '子' },
    { id: '3', expression: '"Missing"[Mesh]', label: '不明' },
  ]);
  const deps: DiagnoseDeps = {
    fetch: fakeFetch({ pubmed: () => 50, mesh: { Parent: ['C01'], Child: ['C01.100'] } }),
    eutils: { maxRetries: 0, sleep: async () => undefined },
  };
  await main(['--case', CASE_ID, '--c0', 'ancestor-c0'], fixturesRoot, resultsRoot, deps);
  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'ancestor-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.diagnosis.overlaps.map((o) => [o.blockIds, o.kind])).toEqual([
    [['1', '2'], 'ancestor'], [['1', '3'], 'unknown'], [['2', '3'], 'unknown'],
  ]);
});

test('階層取得の未解決理由を小文字キーに揃えて unknown の note に保存する', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'reasons-c0', [
    { id: '1', expression: '"Incidence"[Mesh]', label: '発生率' },
    { id: '2', expression: '"Hemostatics"[Mesh]', label: '止血薬' },
  ]);
  const reason = '候補の descriptor が語と一致しない（Epidemiology）';
  const deps: DiagnoseDeps = {
    fetch: fakeFetch({ pubmed: () => 50 }),
    eutils: { maxRetries: 0, sleep: async () => undefined },
    fetchMeshTreeNumbers: jest.fn(async () => ({
      trees: new Map([['Hemostatics', ['D27.505.954.502.270.463']]]),
      reasons: new Map([['Incidence', reason]]),
    })),
  };
  await main(['--case', CASE_ID, '--c0', 'reasons-c0'], fixturesRoot, resultsRoot, deps);
  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'reasons-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.complete).toBe(true);
  expect(deps.fetchMeshTreeNumbers).toHaveBeenCalledWith(['Incidence', 'Hemostatics'], expect.anything());
  expect(record.diagnosis.overlaps).toEqual([expect.objectContaining({
    blockIds: ['1', '2'], kind: 'unknown',
    terms: [{ blockId: '1', text: '"Incidence"[Mesh]' }],
    note: `#1 と #2: 未判定: 階層を取得できなかった（"Incidence"[Mesh]: ${reason}）`,
  })]);
});

test('件数診断: 閾値未満は ineffective、閾値以上は false、測定失敗・0 件・最終式より少ない場合は null で理由が入る', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  // 件数は閾値 BLOCK_NARROWING_MIN_REDUCTION（0.13）の境界を跨ぐように選んである。
  // A: 外すと 100 件 → 削減率 (100-87)/100=0.13 ちょうど → false（ちょうどは含めない）
  // B: 外すと 95 件 → 削減率 (95-87)/95≈0.0842 → true（閾値未満）
  // C: 通信失敗（HTTP 500） → null、理由に本文を含む
  // D: 外した式が 0 件 → null
  // E: 外した式が最終式より少ない（70 < 87）→ null
  writeC0(fixturesRoot, CASE_ID, 'narrowing-c0', [
    { id: '1', expression: 'A[tiab]', label: 'A' },
    { id: '2', expression: 'B[tiab]', label: 'B' },
    { id: '3', expression: 'C[tiab]', label: 'C' },
    { id: '4', expression: 'D[tiab]', label: 'D' },
    { id: '5', expression: 'E[tiab]', label: 'E' },
  ]);
  const counts: Record<string, number | null> = {
    '(A[tiab]) AND (B[tiab]) AND (C[tiab]) AND (D[tiab]) AND (E[tiab])': 87,
    '(B[tiab]) AND (C[tiab]) AND (D[tiab]) AND (E[tiab])': 100,
    '(A[tiab]) AND (C[tiab]) AND (D[tiab]) AND (E[tiab])': 95,
    '(A[tiab]) AND (B[tiab]) AND (D[tiab]) AND (E[tiab])': null,
    '(A[tiab]) AND (B[tiab]) AND (C[tiab]) AND (E[tiab])': 0,
    '(A[tiab]) AND (B[tiab]) AND (C[tiab]) AND (D[tiab])': 70,
  };
  const deps: DiagnoseDeps = {
    fetch: fakeFetch({ pubmed: (term) => { if (!(term in counts)) throw new Error(`未知の term: ${term}`); return counts[term]!; } }),
    eutils: { maxRetries: 0, sleep: async () => undefined },
  };
  await main(['--case', CASE_ID, '--c0', 'narrowing-c0'], fixturesRoot, resultsRoot, deps);
  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'narrowing-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.finalHits).toBe(87);
  const byBlock = Object.fromEntries(record.diagnosis.narrowing.map((row) => [row.blockId, row]));
  expect(byBlock['1']).toMatchObject({ reduction: 0.13, ineffective: false });
  expect(byBlock['2']).toMatchObject({ ineffective: true });
  expect(byBlock['2']!.reduction!).toBeCloseTo((95 - 87) / 95);
  expect(byBlock['3']).toMatchObject({ withoutHits: null, reduction: null, ineffective: null });
  expect(byBlock['3']!.note).toContain('未判定');
  expect(byBlock['4']).toMatchObject({ withoutHits: 0, reduction: null, ineffective: null, note: expect.stringContaining('0 件') });
  expect(byBlock['5']).toMatchObject({ withoutHits: 70, reduction: null, ineffective: null, note: expect.stringContaining('最終式より少ない') });
});

test('既に complete: true の出力ファイルがある C0 はスキップされ API が呼ばれない', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  const outDir = join(resultsRoot, 'block-diagnosis', 'default', CASE_ID);
  mkdirSync(outDir, { recursive: true });
  const existing: DiagnosisRecord = {
    schemaVersion: 1, source: 'diagnosis-only', caseId: CASE_ID,
    c0: { name: 'skip-c0', sha256: 'sha', variant: 'criteria-only', draftIndex: 1 },
    searchDate: '2021-04-15', startedAt: '2026-09-01T00:00:00.000Z', elapsedMs: 1, gitCommit: null, gitDirty: null,
    complete: true, error: null, finalQuery: '("X"[tiab])', finalHits: 10, diagnosisTarget: 'c0', simple: true, targetBlockIds: ['1'],
    diagnosis: { fingerprint: '', overlaps: [], narrowing: [], note: '' }, apiCalls: 1, diagnosisApiCalls: 0,
    exceedsProductBudget: false, representativeSplit: null,
  };
  writeFileSync(join(outDir, 'skip-c0.json'), JSON.stringify(existing));
  const before = readFileSync(join(outDir, 'skip-c0.json'), 'utf8');
  const fetchSpy = jest.fn();
  await main(['--case', CASE_ID, '--c0', 'skip-c0'], fixturesRoot, resultsRoot, { fetch: fetchSpy as unknown as typeof fetch });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readFileSync(join(outDir, 'skip-c0.json'), 'utf8')).toBe(before);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('完了済みのためスキップ'));
});

test('--harvest は複数 split の診断を 1 本にまとめ、不一致は splitMismatch、blockDiagnosis 無しはスキップする', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'match-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  writeC0(fixturesRoot, CASE_ID, 'mismatch-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  writeC0(fixturesRoot, CASE_ID, 'nodiag-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  const diagnosisA: BlockDiagnosis = { fingerprint: 'fp-a', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 100, withoutHits: 150, reduction: 1 / 3, ineffective: false, note: '' },
  ], note: '' };
  const diagnosisB: BlockDiagnosis = { fingerprint: 'fp-b', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 90, withoutHits: 150, reduction: 0.4, ineffective: false, note: '' },
  ], note: '' };
  const writeRun = (dir: string, runId: string, diagnosis: BlockDiagnosis | undefined, hits: number, query: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      runId, gitCommit: 'commit-abc', startedAt: '2026-09-15T00:00:00.000Z',
      conditions: { C0: { query, measurement: { status: 'success', hits } } },
      optimization: diagnosis ? { blockDiagnosis: diagnosis } : {},
    }));
  };
  const caseDir = join(resultsRoot, 'default', CASE_ID);
  writeRun(join(caseDir, 'match-c0', 's1+issue164-current'), 'run-match-1', diagnosisA, 100, 'q1');
  writeRun(join(caseDir, 'match-c0', 's2+issue164-current'), 'run-match-2', diagnosisA, 100, 'q1');
  writeRun(join(caseDir, 'mismatch-c0', 's1+issue164-current'), 'run-mismatch-1', diagnosisA, 100, 'q1');
  writeRun(join(caseDir, 'mismatch-c0', 's2+issue164-current'), 'run-mismatch-2', diagnosisB, 90, 'q2');
  writeRun(join(caseDir, 'nodiag-c0', 's1+issue164-current'), 'run-nodiag-1', undefined, 100, 'q1');

  await main(['--harvest', '--case', CASE_ID], fixturesRoot, resultsRoot);

  const outDir = join(resultsRoot, 'block-diagnosis', 'default', CASE_ID);
  const matched = JSON.parse(readFileSync(join(outDir, 'match-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(matched.source).toBe('full-run');
  expect(matched.runIds).toEqual(['run-match-1', 'run-match-2']);
  expect(matched.diagnosis).toEqual(diagnosisA);
  expect(matched.diagnosisTarget).toBe('c0');
  expect(matched.splitMismatch).toBeUndefined();
  expect(matched.apiCalls).toBeNull();
  expect(matched.diagnosisApiCalls).toBeNull();
  expect(matched.representativeSplit).toBe('s1');

  const mismatched = JSON.parse(readFileSync(join(outDir, 'mismatch-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(mismatched.representativeSplit).toBe('s1');
  expect(mismatched.diagnosis).toEqual(diagnosisA);
  expect(mismatched.splitMismatch).toEqual([
    { split: 's1', runId: 'run-mismatch-1', finalHits: 100, finalQuery: 'q1', diagnosisTarget: 'c0', diagnosis: diagnosisA },
    { split: 's2', runId: 'run-mismatch-2', finalHits: 90, finalQuery: 'q2', diagnosisTarget: 'c0', diagnosis: diagnosisB },
  ]);

  expect(existsSync(join(outDir, 'nodiag-c0.json'))).toBe(false);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('optimization.blockDiagnosis がありません'));
});

test('--harvest は --c0 で指定した C0 だけを収集し、他の C0 の既存結果を上書きしない', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'target-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  writeC0(fixturesRoot, CASE_ID, 'other-c0', [{ id: '1', expression: 'y[tiab]', label: 'Y' }]);
  const diagnosis: BlockDiagnosis = { fingerprint: 'fp', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 100, withoutHits: 150, reduction: 1 / 3, ineffective: false, note: '' },
  ], note: '' };
  const writeRun = (dir: string, runId: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      runId, gitCommit: 'commit-abc', startedAt: '2026-09-15T00:00:00.000Z',
      conditions: { C0: { query: 'q', measurement: { status: 'success', hits: 100 } } },
      optimization: { blockDiagnosis: diagnosis },
    }));
  };
  const caseDir = join(resultsRoot, 'default', CASE_ID);
  writeRun(join(caseDir, 'target-c0', 's1+issue164-current'), 'run-target');
  writeRun(join(caseDir, 'other-c0', 's1+issue164-current'), 'run-other');

  await main(['--harvest', '--case', CASE_ID, '--c0', 'target-c0'], fixturesRoot, resultsRoot);

  const outDir = join(resultsRoot, 'block-diagnosis', 'default', CASE_ID);
  expect(existsSync(join(outDir, 'target-c0.json'))).toBe(true);
  expect(existsSync(join(outDir, 'other-c0.json'))).toBe(false);
});

test('--harvest の代表 split はディレクトリ列挙順に依存せず split 名の昇順で決まる', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'order-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  const diagnosisZ: BlockDiagnosis = { fingerprint: 'fp-z', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 100, withoutHits: 150, reduction: 1 / 3, ineffective: false, note: '' },
  ], note: '' };
  const diagnosisA: BlockDiagnosis = { fingerprint: 'fp-a', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 90, withoutHits: 150, reduction: 0.4, ineffective: false, note: '' },
  ], note: '' };
  const diagnosisM: BlockDiagnosis = { fingerprint: 'fp-m', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 80, withoutHits: 150, reduction: 7 / 15, ineffective: false, note: '' },
  ], note: '' };
  const writeRun = (dir: string, runId: string, diagnosis: BlockDiagnosis, hits: number, query: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      runId, gitCommit: 'commit-abc', startedAt: '2026-09-15T00:00:00.000Z',
      conditions: { C0: { query, measurement: { status: 'success', hits } } },
      optimization: { blockDiagnosis: diagnosis },
    }));
  };
  const harvestDir = join(resultsRoot, 'default', CASE_ID, 'order-c0');
  // ディレクトリ作成順をアルファベット順とわざと逆にする（readdirSync が作成順を返す環境でも
  // 列挙順だけを見て代表を選ばないことを確かめるため）。
  writeRun(join(harvestDir, 'zzz+issue164-current'), 'run-z', diagnosisZ, 100, 'qz');
  writeRun(join(harvestDir, 'mmm+issue164-current'), 'run-m', diagnosisM, 80, 'qm');
  writeRun(join(harvestDir, 'aaa+issue164-current'), 'run-a', diagnosisA, 90, 'qa');

  await main(['--harvest', '--case', CASE_ID], fixturesRoot, resultsRoot);

  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'order-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.representativeSplit).toBe('aaa');
  expect(record.diagnosis).toEqual(diagnosisA);
  expect(record.diagnosisTarget).toBe('c0');
  expect(record.runIds).toEqual(['run-a', 'run-m', 'run-z']);
  expect(record.splitMismatch?.map((entry) => entry.split)).toEqual(['aaa', 'mmm', 'zzz']);
});

test.each([
  // 採用あり: blockDiagnosis は最良式（C1）を測った後の状態で、narrowing の finalHits は
  // C1 側の件数と一致する。C0（28 件）ではなく C1（3,155 件）の query/hits を保存すべきケース
  // （c1-replacing-salt-with/seeded-draft13 の実データで確認済みの構図を再現）。
  ['採用あり: C1 側の件数と一致すれば diagnosisTarget は best', 3155, 28, 3155, 'best', 'c1-query', 3155],
  // 採用なし: blockDiagnosis はまだ C0 を測った状態のまま。narrowing の finalHits は C0 側と一致する。
  ['採用なし: C0 側の件数と一致すれば diagnosisTarget は c0', 28, 28, 3155, 'c0', 'c0-query', 28],
])('--harvest は診断済みの finalHits を C0/C1 の実測件数と突き合わせて対応する式を保存する: %s',
  async (_label, diagnosedHits, c0Hits, c1Hits, expectedTarget, expectedQuery, expectedHits) => {
    const { resultsRoot, fixturesRoot } = setup();
    writeC0(fixturesRoot, CASE_ID, 'adoption-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
    const diagnosis: BlockDiagnosis = { fingerprint: 'fp', overlaps: [], narrowing: [
      { blockId: '1', label: 'X', finalHits: diagnosedHits, withoutHits: diagnosedHits * 2, reduction: 0.5, ineffective: false, note: '' },
    ], note: '' };
    const dir = join(resultsRoot, 'default', CASE_ID, 'adoption-c0', 's1+issue164-current');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({
      runId: 'run-adoption', gitCommit: 'commit-abc', startedAt: '2026-09-15T00:00:00.000Z',
      conditions: {
        C0: { query: 'c0-query', measurement: { status: 'success', hits: c0Hits } },
        C1: { query: 'c1-query', measurement: { status: 'success', hits: c1Hits } },
      },
      optimization: { blockDiagnosis: diagnosis },
    }));

    await main(['--harvest', '--case', CASE_ID, '--c0', 'adoption-c0'], fixturesRoot, resultsRoot);

    const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'adoption-c0.json'), 'utf8')) as DiagnosisRecord;
    expect(record.diagnosisTarget).toBe(expectedTarget);
    expect(record.finalQuery).toBe(expectedQuery);
    expect(record.finalHits).toBe(expectedHits);
  });

test('--harvest は診断済みの finalHits が C0 にも C1 にも一致しなければ finalQuery/finalHits/diagnosisTarget を null にする', async () => {
  const { resultsRoot, fixturesRoot } = setup();
  writeC0(fixturesRoot, CASE_ID, 'unresolvable-c0', [{ id: '1', expression: 'x[tiab]', label: 'X' }]);
  const diagnosis: BlockDiagnosis = { fingerprint: 'fp', overlaps: [], narrowing: [
    { blockId: '1', label: 'X', finalHits: 500, withoutHits: 1000, reduction: 0.5, ineffective: false, note: '' },
  ], note: '' };
  const dir = join(resultsRoot, 'default', CASE_ID, 'unresolvable-c0', 's1+issue164-current');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    runId: 'run-unresolvable', gitCommit: 'commit-abc', startedAt: '2026-09-15T00:00:00.000Z',
    conditions: {
      C0: { query: 'c0-query', measurement: { status: 'success', hits: 100 } },
      C1: { query: 'c1-query', measurement: { status: 'success', hits: 200 } },
    },
    optimization: { blockDiagnosis: diagnosis },
  }));

  await main(['--harvest', '--case', CASE_ID, '--c0', 'unresolvable-c0'], fixturesRoot, resultsRoot);

  const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'unresolvable-c0.json'), 'utf8')) as DiagnosisRecord;
  expect(record.diagnosisTarget).toBeNull();
  expect(record.finalQuery).toBeNull();
  expect(record.finalHits).toBeNull();
  expect(output).toHaveBeenCalledWith(expect.stringContaining('診断対象の式を C0/C1 の実測件数から特定できませんでした'));
});

test('--report は検出 C0 数・ineffective 数・削減率分位点を集計する', () => {
  const root = mkdtempSync(join(tmpdir(), 'block-diagnose-report-'));
  const caseId = CASE_ID;
  const record = (overrides: Partial<DiagnosisRecord>): DiagnosisRecord => ({
    schemaVersion: 1, source: 'diagnosis-only', caseId,
    c0: { name: 'x', sha256: 'sha', variant: 'criteria-only', draftIndex: 1 },
    searchDate: '2021-04-15', startedAt: '2026-09-01T00:00:00.000Z', elapsedMs: 1, gitCommit: null, gitDirty: null,
    complete: true, error: null, finalQuery: 'q', finalHits: 100, diagnosisTarget: 'c0', simple: true, targetBlockIds: [],
    diagnosis: { fingerprint: '', overlaps: [], narrowing: [], note: '' }, apiCalls: 1, diagnosisApiCalls: 1,
    exceedsProductBudget: false, representativeSplit: null,
    ...overrides,
  });
  const r1 = record({
    c0: { name: 'r1', sha256: 's', variant: 'criteria-only', draftIndex: 1 },
    diagnosis: { fingerprint: '', overlaps: [{ blockIds: ['1', '2'], kind: 'same', terms: [], qualified: false, note: '' }],
      narrowing: [
        { blockId: '1', label: 'A', finalHits: 100, withoutHits: 111, reduction: 0.1, ineffective: true, note: '' },
        { blockId: '2', label: 'B', finalHits: 100, withoutHits: 143, reduction: 0.3, ineffective: false, note: '' },
        { blockId: '3', label: 'C', finalHits: null, withoutHits: null, reduction: null, ineffective: null, note: '未判定: 最終式の件数が不明' },
      ], note: '' },
  });
  const r2 = record({
    source: 'full-run',
    c0: { name: 'r2', sha256: 's', variant: 'seeded', draftIndex: 1 },
    diagnosis: { fingerprint: '', overlaps: [
      { blockIds: ['1', '2'], kind: 'ancestor', terms: [], qualified: false, note: '' },
      { blockIds: ['1', '3'], kind: 'unknown', terms: [], qualified: false, note: '' },
    ], narrowing: [
      { blockId: '1', label: 'A', finalHits: 100, withoutHits: 200, reduction: 0.5, ineffective: false, note: '' },
      { blockId: '2', label: 'B', finalHits: 100, withoutHits: 333, reduction: 0.7, ineffective: false, note: '' },
      { blockId: '3', label: 'C', finalHits: 100, withoutHits: 1000, reduction: 0.9, ineffective: false, note: '' },
    ], note: '' },
  });
  const r3 = record({ c0: { name: 'r3', sha256: 's', variant: 'criteria-only', draftIndex: 1 },
    diagnosis: { fingerprint: '', overlaps: [], narrowing: [], note: '' } });
  const r4 = record({ complete: false, error: '通信断', c0: { name: 'r4', sha256: 's', variant: 'criteria-only', draftIndex: 1 } });
  // 結合式が単純な AND でない C0（simple: false）。diagnoseStructure は空の overlaps を返すが、
  // これは「重なりが無いと確認できた」のではなく「判定できなかった」ので、重なりなしC0 には
  // 数えず、構造未判定C0 側に計上されることを確認する。
  const r5 = record({ simple: false, c0: { name: 'r5', sha256: 's', variant: 'criteria-only', draftIndex: 1 },
    diagnosis: { fingerprint: '', overlaps: [], narrowing: [], note: '未判定: 結合式が単純な AND ではない' } });
  const dir = join(root, caseId);
  mkdirSync(dir, { recursive: true });
  for (const rec of [r1, r2, r3, r4, r5]) writeFileSync(join(dir, `${rec.c0.name}.json`), JSON.stringify(rec));

  const markdown = reportDiagnosis(root, 'default');
  const overall = markdown.split('\n').find((line) => line.startsWith('| 全体 |'));
  expect(overall).toBe('| 全体 | 5 | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1/5 | 1 | 未判定: 最終式の件数が不明: 1 | 10.0% | 30.0% | 50.0% | 70.0% | 90.0% | 3 | 1 | 0 |');
  expect(existsSync(join(root, 'summary.csv'))).toBe(true);
  expect(config).not.toHaveBeenCalled();
});

test('分位点は線形補間で計算する', () => {
  expect(quantile([], 0.5)).toBeNull();
  expect(quantile([5], 0.5)).toBe(5);
  expect(quantile([0.1, 0.3, 0.5, 0.7, 0.9], 0.25)).toBeCloseTo(0.3);
  expect(quantile([0, 10], 0.5)).toBeCloseTo(5);
});

test.each([
  // 30 ブロック: 総通信数（最終式 1 + 除去 30 = 31）は 30 を超えるが、診断フェーズだけの通信数
  // （除去 30 回。queryOptimizationService.ts の updateDiagnosis が診断予算として数える範囲と
  // 同じ区切り）はちょうど 30 で「超えて」いない → false。総数で判定すると誤って true になる境界。
  [30, 31, 30, false],
  // 31 ブロック: 診断フェーズだけで 31 回になり、ここで初めて 30 を超える → true。
  [31, 32, 31, true],
])('診断フェーズの通信数（最終式の実測を含まない）だけで exceedsProductBudget を判定する: %i ブロック',
  async (blockCount, expectedApiCalls, expectedDiagnosisApiCalls, expected) => {
    const { resultsRoot, fixturesRoot } = setup();
    const blocks = Array.from({ length: blockCount }, (_, i) => ({ id: String(i + 1), expression: `T${i + 1}[tiab]`, label: `T${i + 1}` }));
    writeC0(fixturesRoot, CASE_ID, 'budget-c0', blocks);
    const deps: DiagnoseDeps = {
      fetch: fakeFetch({ pubmed: (term) => (term.match(/\[tiab\]/g) ?? []).length === blockCount ? 100 : 200 }),
      eutils: { maxRetries: 0, sleep: async () => undefined },
    };
    await main(['--case', CASE_ID, '--c0', 'budget-c0'], fixturesRoot, resultsRoot, deps);
    const record = JSON.parse(readFileSync(join(resultsRoot, 'block-diagnosis', 'default', CASE_ID, 'budget-c0.json'), 'utf8')) as DiagnosisRecord;
    // 最終式の実測（1 回）は診断フェーズの前に行うため、apiCalls（総数）と diagnosisApiCalls
    // （除去のみ）はちょうど 1 だけずれる。
    expect(record.apiCalls).toBe(expectedApiCalls);
    expect(record.diagnosisApiCalls).toBe(expectedDiagnosisApiCalls);
    expect(record.exceedsProductBudget).toBe(expected);
  });
