/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeStudies, countTerms, main, quantile, summarizeDiagnoses, type Diagnosis } from './diagnose';
import { createRun, writeJson } from './runDir';
import { loadConditions } from './conditions';
import { fixture, review, writeLines } from './testFixtures';
import { splitReviews } from './split';
import { readSubmissionState } from './scoreRuns';
import { scoreSubmission } from './metrics';
import { validateFormulaMd } from './submission';
import type { RunRuntime } from './startRuns';

const gold = ['11111111', '11111112'];
const studies = [{ id: '合成研究', pmids: gold }];
const md = (body: string) => `## PubMed\n\n\`\`\`\n${body}\n\`\`\`\n`;
function setup(create = true) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-diagnose-'));
  const casesDir = join(root, 'cases');
  const reviews = Array.from({ length: 5 }, (_, i) => review(i + 1));
  fixture(root, reviews);
  writeLines(join(root, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), reviews.map((row) => ({ pmcid: row.pmcid,
    included_pmids: gold, pmid_to_study_id: { [gold[0]!]: '合成研究', [gold[1]!]: '合成研究' } })));
  writeLines(join(casesDir, 'evaluable.jsonl'), reviews.map((row) => ({ pmcid: row.pmcid, cutoffDate: row.cutoffDate,
    existing: gold, withinCutoff: gold })));
  const selected = reviews.find((row) => splitReviews(reviews).get(row.pmcid) === 'development')!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: [selected.pmcid] });
  const runtime: RunRuntime = { casesDir, reportsDir: join(root, 'reports'),
    env: { COCHRANE_BENCH_DIR: root, P2F_NCBI_RPS: '100000', NCBI_API_KEY: 'FAKE_SECRET' },
    now: () => new Date('2026-01-01Z'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    fetchImpl: jest.fn(async () => { throw new Error('想定外の通信'); }) };
  const protocol = join(root, 'protocol.md');
  writeFileSync(protocol, '合成プロトコル');
  const dirs = create ? Array.from({ length: 3 }, (_, i) => createRun({ root: join(root, 'runs'), version: 'v0',
    pmcid: selected.pmcid, runIndex: i + 1, cutoffDate: selected.cutoffDate, protocolPath: protocol,
    conditions: loadConditions('v0'), now: runtime.now })) : [];
  const args = ['--runs', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', '3'];
  const submit = (index: number, body = '#1 alpha[tiab]', capturedPmids: string[] = [], number = 1) => {
    const dir = dirs[index]!;
    const text = md(body);
    const result = validateFormulaMd(text);
    if (!result.ok) throw new Error('合成式が不正です');
    mkdirSync(join(dir, 'submissions'), { recursive: true });
    writeFileSync(join(dir, 'submissions', `${number}.md`), text);
    writeJson(join(dir, 'submission.json'), { number, query: result.query });
    const state = readSubmissionState(dir);
    const outcome = { status: 'measured' as const, hits: 10, capturedPmids };
    writeJson(join(dir, 'score.json'), { ...scoreSubmission(studies, gold, outcome), outcome,
      submission: state.fingerprint, submitAttempts: state.submitAttempts, measuredAt: runtime.now().toISOString() });
  };
  return { root, runtime, dirs, args, submit };
}
function fakeFetch(answer: (params: URLSearchParams) => unknown): typeof fetch {
  return jest.fn(async (input) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://eutils.ncbi.nlm.nih.gov' || url.pathname !== '/entrez/eutils/esearch.fcgi') throw new Error('想定外の通信');
    expect(url.searchParams.get('datetype')).toBe('edat');
    expect(url.searchParams.get('maxdate')).toBe('2020/01/31');
    return new Response(JSON.stringify({ esearchresult: answer(url.searchParams) }));
  });
}
const readDiagnosis = (dir: string): Diagnosis => JSON.parse(readFileSync(join(dir, 'diagnosis.json'), 'utf8')) as Diagnosis;

test('未使用の行は測定も帰属もせず、最上位の選択肢は通信しない', async () => {
  const s = setup();
  s.submit(0, '#1 alpha[tiab]\n#2 beta[tiab]\n#3 unused[tiab]\n#4 #1 AND #2');
  s.submit(1, '#1 alpha[tiab]\n#2 beta[tiab]\n#3 #1 OR #2');
  s.submit(2, '#1 alpha[tiab]');
  s.runtime.fetchImpl = fakeFetch((params) => {
    const term = params.get('term')!;
    if (term.includes('unused')) throw new Error('未使用の行を測定しました');
    if (term.includes('beta')) return { count: '0' };
    return params.get('retmax') === '0' ? { count: '10' } : { count: '2', idlist: gold };
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(5);
  expect(readDiagnosis(s.dirs[0]!)).toMatchObject({ unusedLines: 1, attribution: { single_concept: 1 }, singleCauseLines: { '2': 1 } });
  expect(readDiagnosis(s.dirs[1]!)).toMatchObject({ undetermined: true, lines: [], attribution: { undetermined: 1 } });
  expect(readDiagnosis(s.dirs[2]!)).toMatchObject({ attribution: { no_lines: 1 } });
  const summary = summarizeDiagnoses(s.dirs.map(readDiagnosis));
  expect(summary.byConceptCountExcludedRuns).toBe(1);
  expect(summary.byConceptCount.map((group) => group.runs)).toEqual([1, 1]);
  expect(summary.attribution.undetermined).toEqual({ studies: 1, proportion: 1 / 3 });
  const complete = { ...readDiagnosis(s.dirs[1]!), missedStudies: 0 };
  expect(summarizeDiagnoses([complete]).byConceptCountExcludedRuns).toBe(1);
});

test.each([true, false])('否定の単位は除外集合の補集合で捕捉を測り、件数を保存しない（除外あり=%s）', async (excluded) => {
  const s = setup();
  s.submit(0, '#A alpha[tiab]\n#B beta[tiab]\n#C excluded[tiab]\n#D delta[tiab]\n#E #A AND #B NOT #C AND #D');
  s.runtime.fetchImpl = fakeFetch((params) => {
    if (params.get('term')!.includes('excluded') && !excluded) {
      expect(params.get('retmax')).toBe('0');
      return { count: '0' };
    }
    return params.get('retmax') === '0' ? { count: '10' } : { count: '2', idlist: gold };
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  const row = readDiagnosis(s.dirs[0]!);
  expect(row.lines.map((line) => line.kind)).toEqual(['concept', 'concept', 'filter', 'concept']);
  expect(row.lines[2]).toMatchObject({ id: 'C', hits: null, capturedStudies: excluded ? 0 : 1 });
  expect(row.attribution).toMatchObject({ single_filter: excluded ? 1 : 0, none: excluded ? 0 : 1 });
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(excluded ? 8 : 7);
});

test('採点日時が同じなら再利用し、更新または旧形式なら再測定する', async () => {
  const s = setup(); s.submit(0);
  s.runtime.fetchImpl = fakeFetch(() => ({ count: '0' }));
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
  const scorePath = join(s.dirs[0]!, 'score.json');
  const score = JSON.parse(readFileSync(scorePath, 'utf8'));
  score.measuredAt = '2026-02-01T00:00:00.000Z';
  writeJson(scorePath, score);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(2);
  expect(readDiagnosis(s.dirs[0]!).scoreMeasuredAt).toBe(score.measuredAt);
  const saved = { ...readDiagnosis(s.dirs[0]!), scoreMeasuredAt: undefined };
  writeJson(join(s.dirs[0]!, 'diagnosis.json'), saved);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(3);
});

test('語句を数え、引用符内の演算子、タグなしの句、未知のタグを区別する', () => {
  expect(countTerms('("alpha AND beta"[Mesh:noexp] OR gamma[mh]) AND (delta[tiab] OR epsilon[tw]) OR plain phrase OR "OR (NOT)" OR randomized controlled trial[pt]'))
    .toEqual({ meshTerms: 2, freewordTerms: 2, plainTerms: 2 });
  expect(countTerms('"alpha beta"[tiab:~3]')).toEqual({ meshTerms: 0, freewordTerms: 1, plainTerms: 0 });
  expect(countTerms('#1 AND #2')).toEqual({ meshTerms: 0, freewordTerms: 0, plainTerms: 0 });
  expect(countTerms('(alpha OR beta) AND gamma')).toEqual({ meshTerms: 0, freewordTerms: 0, plainTerms: 3 });
});

test('帰属の六区分と単独原因行を研究単位で数える', () => {
  const sample = gold.map((pmid) => ({ id: '合成', pmids: [pmid] }));
  const concept = { id: '1', kind: 'concept' as const, captured: [] as string[] };
  const filter = { id: 'F', kind: 'filter' as const, captured: [] as string[] };
  const pass = { ...concept, id: '2', captured: gold };
  const single = attributeStudies(sample, [gold[1]!], [concept, pass]);
  expect(single).toMatchObject({ missedStudies: 1, attribution: { single_concept: 1 }, singleCauseLines: { '1': 1 },
    lineCounts: [{ capturedStudies: 0, missedStudies: 1 }, { capturedStudies: 2, missedStudies: 0 }] });
  expect(attributeStudies(sample, [], [filter, pass]).attribution.single_filter).toBe(2);
  expect(attributeStudies(sample, [], [concept, filter]).attribution.multiple).toBe(2);
  expect(attributeStudies(studies, [], [{ ...concept, captured: [gold[0]!] }, { ...filter, captured: [gold[1]!] }]).attribution.none).toBe(1);
  expect(attributeStudies(studies, [], [concept]).attribution.no_lines).toBe(1);
  expect(attributeStudies(studies, [], [], true).attribution.undetermined).toBe(1);
  for (const result of [single, attributeStudies(sample, [], [filter, pass]), attributeStudies(sample, [], [concept, filter]),
    attributeStudies(studies, [], [pass, { ...filter, captured: gold }]), attributeStudies(studies, [], [concept]),
    attributeStudies(studies, [], [], true)]) {
    expect(Object.keys(result.attribution)).toHaveLength(6);
    expect(Object.values(result.attribution).reduce((a, b) => a + b, 0)).toBe(result.missedStudies);
  }
  expect(attributeStudies(studies, [gold[1]!], [concept, filter]).missedStudies).toBe(0);
});

test.each(['validation', 'test'])('開発群以外の %s は開封指定の有無を問わず読み込み前に拒否する', async (subset) => {
  const runtime = setup(false).runtime;
  runtime.env = {};
  for (const extra of [[], ['--open-test-set']]) {
    await expect(main(['--runs', 'unused', '--version', 'v0', '--subset', subset, '--runs-per-review', '1', ...extra], runtime))
      .rejects.toThrow('診断は開発群だけ');
  }
  expect(runtime.fetchImpl).not.toHaveBeenCalled();
});

test('実行フォルダの不足数を示す', async () => {
  const s = setup(false);
  await expect(main(s.args, s.runtime)).rejects.toThrow('3 件不足');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('採点と提出が不一致なら通信前に拒否する', async () => {
  const s = setup(); s.submit(0);
  writeFileSync(join(s.dirs[0]!, 'tool-log.jsonl'), JSON.stringify({ command: 'submit' }) + '\n');
  await expect(main(s.args, s.runtime)).rejects.toThrow('先に採点してください');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('受け付け済みの式を再検査する', async () => {
  const s = setup(); s.submit(0);
  writeFileSync(join(s.dirs[0]!, 'submissions/1.md'), md('#1 (alpha[tiab]'));
  await expect(main(s.args, s.runtime)).rejects.toThrow('提出済みの式が不正');
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test('ゼロ件では捕捉を問い合わせず、匿名の結果と集計を保存し、同じ提出を再測定しない', async () => {
  const s = setup();
  s.submit(0, '#1 zero[tiab]\n#2 beta[Mesh] OR plain\n#F randomized controlled trial[pt]\n#3 #1 AND #2 AND #F');
  s.submit(1, '#1 alpha[tiab]', [gold[0]!]);
  s.runtime.fetchImpl = fakeFetch((params) => {
    if (params.get('term')!.includes('zero[tiab]')) { expect(params.get('retmax')).toBe('0'); return { count: '0' }; }
    return params.get('retmax') === '0' ? { count: '10' } : { count: '1', idlist: [gold[1]!] };
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(7);
  const first = readDiagnosis(s.dirs[0]!);
  expect(first).toMatchObject({ studies: 1, missedStudies: 1, attribution: { single_concept: 1 }, singleCauseLines: { '1': 1 } });
  expect(first.lines.map((line) => [line.id, line.kind, line.capturedStudies])).toEqual([['1', 'concept', 0], ['2', 'concept', 1], ['F', 'filter', 1]]);
  const report = readFileSync(join(s.runtime.reportsDir!, 'diagnose-v0-smoke.json'), 'utf8');
  expect(JSON.parse(report).summary).toMatchObject({ runs: 3, noSubmission: 1, withFilter: { runs: 1, meanStudyRecall: 0 },
    withoutFilter: { runs: 1, meanStudyRecall: 1 }, missedStudies: 1 });
  const output = JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls) + report + JSON.stringify(first) + JSON.stringify(readDiagnosis(s.dirs[1]!));
  expect(output).not.toMatch(/11111111|11111112|PMC\d+|合成研究|FAKE_SECRET|capturedPmids/);
  expect(existsSync(join(s.dirs[2]!, 'diagnosis.json'))).toBe(false);
  (s.runtime.fetchImpl as jest.Mock).mockClear();
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
  s.submit(0, '#1 zero[tiab]', [], 2);
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
  expect(readDiagnosis(s.dirs[0]!).submission.number).toBe(2);
});

test.each(['通信', '拒否', '捕捉'])('測定の%s失敗は保存せず、次へ進んで終了コード一と一行だけを返す', async (failure) => {
  const s = setup(); s.submit(0, '#1 broken[tiab]'); s.submit(1, '#1 zero[tiab]');
  s.runtime.fetchImpl = fakeFetch((params) => {
    if (!params.get('term')!.includes('broken')) return { count: '0' };
    if (failure === '通信') throw new Error('合成障害 FAKE_SECRET');
    if (failure === '捕捉' && params.get('retmax') === '0') return { count: '1' };
    return { errorlist: { fieldsnotfound: ['合成拒否 FAKE_SECRET'] } };
  });
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(existsSync(join(s.dirs[0]!, 'diagnosis.json'))).toBe(false);
  expect(existsSync(join(s.dirs[1]!, 'diagnosis.json'))).toBe(true);
  expect(existsSync(s.runtime.reportsDir!)).toBe(false);
  expect(s.runtime.stdout).toHaveBeenCalledTimes(1);
  expect(s.runtime.stdout).toHaveBeenCalledWith('診断失敗: 1 件。集計しません\n');
  expect(s.runtime.stderr).not.toHaveBeenCalled();
  s.runtime.fetchImpl = fakeFetch(() => ({ count: '0' }));
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1);
});

test('引数や前処理の例外でもキーを伏せる', async () => {
  const s = setup(); s.submit(0);
  writeFileSync(join(s.dirs[0]!, 'submission.json'), 'FAKE_SECRET');
  try { await main(s.args, s.runtime); throw new Error('例外が必要です'); }
  catch (error) { expect(String(error)).not.toContain('FAKE_SECRET'); }
});

test('中央値と四分位は隣接順位を線形補間し、空集合は値なしにする', () => {
  expect([0.25, 0.5, 0.75].map((p) => quantile([40, 10, 30, 20], p))).toEqual([17.5, 25, 32.5]);
  expect([0.25, 0.5, 0.75].map((p) => quantile([1, 2, 3, 4, 5], p))).toEqual([2, 3, 4]);
  expect(quantile([7], 0.25)).toBe(7);
  expect(quantile([], 0.5)).toBeNull();
});

test('概念行数別、フィルタ有無、最大取りこぼし行の同点、全捕捉別を集計する', () => {
  const line = (id: string, hits: number, missedStudies: number, freewordTerms: number) => ({ id, hits, missedStudies, freewordTerms,
    kind: 'concept' as const, capturedStudies: 0, meshTerms: 0, plainTerms: 1 });
  const row: Diagnosis = { status: 'diagnosed', submission: { number: 1, querySha256: 'synthetic' }, studies: 3,
    missedStudies: 3, studyRecall: 0, hits: 100, measuredAt: '2026-01-01Z', scoreMeasuredAt: '2026-01-01Z', unusedLines: 0, undetermined: false, singleCauseLines: {},
    attribution: { single_concept: 1, single_filter: 0, multiple: 2, none: 0, no_lines: 0, undetermined: 0 },
    lines: [line('1', 20, 3, 5), line('2', 10, 3, 2), { ...line('F', 1, 1, 0), kind: 'filter' }] };
  const complete: Diagnosis = { ...row, missedStudies: 0, studyRecall: 1, hits: 200, lines: [line('1', 30, 0, 4)],
    attribution: { single_concept: 0, single_filter: 0, multiple: 0, none: 0, no_lines: 0, undetermined: 0 } };
  const summary = summarizeDiagnoses([row, complete, { status: 'no_submission' }]);
  expect(summary.byConceptCount).toEqual([
    { conceptLines: 1, runs: 1, meanStudyRecall: 1, allCapturedRate: 1, medianHits: 200 },
    { conceptLines: 2, runs: 1, meanStudyRecall: 0, allCapturedRate: 0, medianHits: 100 }]);
  expect(summary.worstConcept).toMatchObject({ lines: 2, hits: { median: 20, q1: 15, q3: 25 },
    freewordTerms: { median: 3 }, zeroMeshLines: 2, atMostThreeFreewordLines: 1 });
  expect(summary.allConcepts).toMatchObject({ lines: 3, hits: { median: 20 }, freewordTerms: { median: 4 } });
  expect(summary.attribution).toMatchObject({ single_concept: { studies: 1, proportion: 1 / 3 }, multiple: { studies: 2, proportion: 2 / 3 } });
  expect(summary.allCaptured).toEqual({ runs: 1, meanConceptLines: 1, medianFreewordTermsPerLine: 4 });
  expect(summary.notAllCaptured).toEqual({ runs: 1, meanConceptLines: 2, medianFreewordTermsPerLine: 3.5 });
  expect(summarizeDiagnoses([]).worstConcept.hits.median).toBeNull();
});
