/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoldRow } from './bench';
import { main } from './seedSelect';
import { runPath } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import type { RunRuntime } from './startRuns';
import { fixture, pmids, record, review, writeJson, writeLines } from './testFixtures';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-select-'));
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  const selected = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development').slice(0, 2);
  const runtime: RunRuntime = { env: { COCHRANE_BENCH_DIR: root }, casesDir: join(root, 'cases'), reportsDir: join(root, 'reports'),
    fetchImpl: jest.fn(), now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn() };
  writeLines(join(runtime.casesDir!, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(runtime.casesDir!, 'subsets.json'), { smoke: selected.map((row) => row.pmcid), fixed: selected.map((row) => row.pmcid) });
  const path = (i: number, file: string) => join(root, '_seed-probe/probe', selected[i]!.pmcid, file);
  const seeds = (i = 0) => join(root, '_seeds/probe', `${selected[i]!.pmcid}.json`);
  const candidates = (ids: string[], i = 0) => {
    writeJson(path(i, 'candidates-relax-ladder.json'), { pmids: ids, fingerprint: '同じ指紋', measuredAt: '2026-01-01' });
    writeJson(path(i, 'result-relax-ladder.json'), { fingerprint: '同じ指紋' });
  };
  candidates(['99999999', pmids[1]!, pmids[0]!, pmids[2]!, pmids[3]!]); candidates([], 1);
  const args = ['--runs', root, '--label', 'probe', '--subset', 'smoke', '--max', '2'];
  const read = (i = 0) => JSON.parse(readFileSync(seeds(i), 'utf8'));
  return { root, runtime, args, path, seeds, candidates, read, selected };
}

test('候補順に選び、選んだ研究を含む複数研究の報告を飛ばし、空も保存して匿名集計する', async () => {
  const s = setup();
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read()).toMatchObject({ pmids: [pmids[1], pmids[2]], studyIds: ['study:合成研究甲', `pmid:${pmids[2]}`], max: 2 });
  expect(s.read(1).pmids).toEqual([]);
  const report = readFileSync(join(s.runtime.reportsDir!, 'seed-select-probe-smoke.json'), 'utf8');
  expect(JSON.parse(report)).toMatchObject({ reviewsBySeedCount: [1, 0, 1], seedsTotal: 2 });
  const output = JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls) + report;
  for (const secret of [...pmids, ...s.selected.map((row) => row.pmcid)]) expect(output).not.toContain(secret);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each([1, 2, 5])('複数研究の報告はすべての研究を選択済みにし、最大 %i 本で止める', async (max) => {
  const s = setup(); s.candidates([...pmids]);
  await main([...s.args.slice(0, -1), String(max)], s.runtime);
  expect(s.read().pmids).toEqual([pmids[0], pmids[2], pmids[3]].slice(0, max));
  expect(s.read().studyIds).toEqual(expect.arrayContaining(['study:合成研究甲', 'study:合成研究乙']));
});

test('同条件は保存済みを使い、別条件は新規ファイルも作らず止める', async () => {
  const s = setup(); await main(s.args, s.runtime);
  const before = readFileSync(s.seeds(), 'utf8');
  s.runtime.now = () => new Date('2026-02-01');
  await main(s.args, s.runtime);
  expect(readFileSync(s.seeds(), 'utf8')).toBe(before);
  unlinkSync(s.seeds(1));
  await expect(main([...s.args.slice(0, -1), '1'], s.runtime)).rejects.toThrow('シードの選定が 1 件、別の条件で作られています');
  expect(existsSync(s.seeds(1))).toBe(false);
  writeJson(s.path(0, 'candidates-relax-ladder.json'), { pmids: [], fingerprint: '変更後' });
  writeJson(s.path(0, 'result-relax-ladder.json'), { fingerprint: '変更後' });
  await expect(main(s.args, s.runtime)).rejects.toThrow('別の条件');
  expect(readFileSync(s.seeds(), 'utf8')).toBe(before);
});

test.each(['candidates-relax-ladder.json', 'result-relax-ladder.json', '指紋'])('不足を全体で先に検出する: %s', async (missing) => {
  const s = setup();
  if (missing === '指紋') writeJson(s.path(1, 'result-relax-ladder.json'), { fingerprint: '別' });
  else unlinkSync(s.path(1, missing));
  await expect(main(s.args, s.runtime)).rejects.toThrow('候補の一覧が 1 件不足しています');
  expect(existsSync(join(s.root, '_seeds'))).toBe(false);
});

test.each(['validation', 'test'])('開発群以外を拒否する: %s', async (subset) => {
  const s = setup();
  await expect(main(s.args.map((value) => value === 'smoke' ? subset : value), s.runtime)).rejects.toThrow('シードの下調べは開発群でだけ実行できます');
});
test('試験群を開く指定も拒否する', async () => {
  const s = setup(); await expect(main([...s.args, '--open-test-set'], s.runtime)).rejects.toThrow('実行引数が不正です');
});
test.each(['0', '6', '1.5', 'NaN'])('不正な上限を拒否する: %s', async (max) => {
  const s = setup(); await expect(main([...s.args.slice(0, -1), max], s.runtime)).rejects.toThrow('シードの条件が不正です');
});

function setupMissed() {
  const s = setup();
  const dir = (i = 0, run = 1, base = 'baseline') => runPath(s.root, base, s.selected[i]!.pmcid, run);
  const score = (capturedPmids: string[], i = 0, run = 1, query = '合成の検索式', base = 'baseline') => {
    const path = dir(i, run, base);
    writeJson(join(path, 'submission.json'), { number: 1, query });
    writeLines(join(path, 'tool-log.jsonl'), [{ command: 'submit' }]);
    const state = readSubmissionState(path);
    writeJson(join(path, 'score.json'), { status: 'scored', submission: state.fingerprint, submitAttempts: state.submitAttempts,
      measuredAt: '2026-01-01', outcome: { status: 'measured', hits: 100, capturedPmids } });
  };
  for (let i = 0; i < s.selected.length; i++) for (let run = 1; run <= 2; run++) score([], i, run);
  return { ...s, dir, score, args: [...s.args, '--from', 'missed', '--base', 'baseline', '--runs-per-review', '2'] };
}

test('同じ式を採点し直して捕捉が変わったら、保存済みの選定を黙って使い回さない', async () => {
  const s = setupMissed();
  s.score([pmids[0]!]); s.score([pmids[2]!], 0, 2);
  expect(await main(s.args, s.runtime)).toBe(0);
  const before = s.read().pmids;
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read().pmids).toEqual(before);
  s.score([pmids[0]!, pmids[3]!]);
  await expect(main(s.args, s.runtime)).rejects.toThrow('別の条件で作られています');
  expect(s.read().pmids).toEqual(before);
});

test('全実行で未捕捉の研究だけを選び、全捕捉のレビューは空として匿名集計する', async () => {
  const s = setupMissed();
  s.score([pmids[0]!]); s.score([pmids[2]!], 0, 2);
  s.score([...pmids], 1);
  unlinkSync(s.path(0, 'candidates-relax-ladder.json'));
  s.runtime.env.NCBI_API_KEY = '合成の秘密キー';
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(s.read().pmids).toEqual([pmids[3]]);
  expect(s.read(1).pmids).toEqual([]);
  const report = readFileSync(join(s.runtime.reportsDir!, 'seed-select-probe-smoke.json'), 'utf8');
  expect(JSON.parse(report)).toMatchObject({ from: 'missed', base: 'baseline', runsPerReview: 2, reviewsWithMissed: 1,
    reviewsBySeedCount: [1, 1, 0], seedsTotal: 1 });
  const output = JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls) + report;
  for (const secret of [...pmids, ...s.selected.flatMap((row) => [row.pmcid, ...row.studies.map((study) => study.id)]),
    '合成の検索式', s.runtime.env.NCBI_API_KEY]) expect(output).not.toContain(secret);
  expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});

test.each([1, 2, 5])('研究のハッシュ昇順で決定的に最大 %i 本を選び、共有する研究をすべて記録する', async (max) => {
  const s = setupMissed();
  const args = s.args.map((value, i) => s.args[i - 1] === '--max' ? String(max) : value);
  const ranked = s.selected[0]!.studies.map((study) => ({ study,
    rank: createHash('sha256').update(`seed-select-missed-v1\n${s.selected[0]!.pmcid}\n${study.id}`).digest('hex') }))
    .sort((a, b) => a.rank < b.rank ? -1 : 1);
  const expected: string[] = [];
  for (const { study } of ranked) {
    const pmid = [...study.pmids].sort()[0]!;
    if (!expected.includes(pmid)) expected.push(pmid);
  }
  await main(args, s.runtime);
  expect(s.read().pmids).toEqual(expected.slice(0, max));
  if (s.read().pmids.includes(pmids[0])) expect(s.read().studyIds).toEqual(expect.arrayContaining(['study:合成研究甲', 'study:合成研究乙']));
  const first = s.read();
  unlinkSync(s.seeds());
  await main(args, s.runtime);
  expect(s.read()).toEqual(first);
});

test.each([true, false])('報告は桁数と文字列の順で選び、選ばれない報告だけを共有する研究も飛ばす: %s', async (sharedFirst) => {
  const s = setupMissed();
  const ids = ['100', '20', '3', '4'];
  const goldPath = join(s.root, 'data/processed/cc-by/gold/task2_search_screen.jsonl');
  const gold = readFileSync(goldPath, 'utf8').split('\n').map((line) => JSON.parse(line) as GoldRow);
  writeLines(goldPath, gold.map((row) => s.selected.some((selected) => selected.pmcid === row.pmcid)
    ? { ...row, included_pmids: ids, pmid_to_study_id: sharedFirst
      ? { '100': '甲', '20': '甲', '3': ['甲', '乙'], '4': '乙' }
      : { '100': '甲', '20': ['甲', '乙'], '3': '甲', '4': '乙' } } : row));
  writeLines(join(s.runtime.casesDir!, 'evaluable.jsonl'), Array.from({ length: 10 }, (_, i) => {
    const row = review(i + 1);
    return s.selected.some((selected) => selected.pmcid === row.pmcid)
      ? { ...record(row), existing: ids, withinCutoff: ids } : record(row);
  }));
  await main(s.args, s.runtime);
  if (sharedFirst) {
    expect(s.read().pmids).toEqual(['3']);
    expect(s.read().studyIds).toEqual(expect.arrayContaining(['study:甲', 'study:乙']));
  } else {
    expect(s.read().pmids).toHaveLength(1);
    expect(['3', '4']).toContain(s.read().pmids[0]);
    expect(s.read().studyIds).toHaveLength(1);
  }
});

test.each(['不足', '提出変更', '提出番号', '提出回数', '未採点', '未測定', '不正な捕捉集合', '壊れた記録'])('採点の不備を実行単位で全体検査して保存前に止める: %s', async (kind) => {
  const s = setupMissed();
  for (const [i, run] of [[0, 2], [1, 1]]) {
    const path = join(s.dir(i, run), 'score.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === '不足') unlinkSync(path);
    else if (kind === '提出変更') writeJson(join(s.dir(i, run), 'submission.json'), { number: 1, query: '別の式と秘密キー' });
    else {
      if (kind === '提出番号') saved.submission.number++;
      if (kind === '提出回数') saved.submitAttempts++;
      if (kind === '未採点') saved.status = 'unknown';
      if (kind === '未測定') saved.outcome.status = 'measurement_failed';
      if (kind === '不正な捕捉集合') saved.outcome.capturedPmids = null;
      writeJson(path, kind === '壊れた記録' ? null : saved);
    }
  }
  await expect(main(s.args, s.runtime)).rejects.toThrow(/^採点記録が 2 件不足しています$/);
  expect(existsSync(join(s.root, '_seeds'))).toBe(false);
  expect(s.runtime.stdout).not.toHaveBeenCalled();
});

test('未捕捉選定も同条件は飛ばし、入力指紋か上限が異なれば全体を保存前に止める', async () => {
  const s = setupMissed(); await main(s.args, s.runtime);
  const before = readFileSync(s.seeds(), 'utf8');
  s.runtime.now = () => new Date('2026-02-01');
  await main(s.args, s.runtime);
  expect(readFileSync(s.seeds(), 'utf8')).toBe(before);
  unlinkSync(s.seeds(1));
  await expect(main(s.args.map((value, i) => s.args[i - 1] === '--max' ? '1' : value), s.runtime))
    .rejects.toThrow('シードの選定が 1 件、別の条件で作られています');
  s.score([], 0, 2, '変更した合成式');
  await expect(main(s.args, s.runtime)).rejects.toThrow('シードの選定が 1 件、別の条件で作られています');
  expect(existsSync(s.seeds(1))).toBe(false);
  expect(readFileSync(s.seeds(), 'utf8')).toBe(before);
});

test.each(['版', '実行数', '評価可能集合', '研究対応'])('選定入力の変更が指紋に反映される: %s', async (change) => {
  const s = setupMissed(); await main(s.args, s.runtime);
  let args = s.args;
  if (change === '版') {
    for (let i = 0; i < s.selected.length; i++) for (let run = 1; run <= 2; run++) s.score([], i, run, '合成の検索式', 'another');
    args = args.map((value) => value === 'baseline' ? 'another' : value);
  } else if (change === '実行数') args = [...args.slice(0, -1), '1'];
  else if (change === '評価可能集合') {
    writeLines(join(s.runtime.casesDir!, 'evaluable.jsonl'), Array.from({ length: 10 }, (_, i) => ({
      ...record(review(i + 1)), withinCutoff: pmids.slice(1),
    })));
  } else {
    const path = join(s.root, 'data/processed/cc-by/gold/task2_search_screen.jsonl');
    writeLines(path, readFileSync(path, 'utf8').split('\n').map((line) => {
      const row = JSON.parse(line) as GoldRow;
      return { ...row, pmid_to_study_id: { ...row.pmid_to_study_id, [pmids[3]!]: '別の研究' } };
    }));
  }
  await expect(main(args, s.runtime)).rejects.toThrow('シードの選定が 2 件、別の条件で作られています');
});

test.each(['--base', '--runs-per-review'])('未捕捉選定には追加引数が必須: %s', async (flag) => {
  const s = setupMissed();
  const index = s.args.indexOf(flag);
  await expect(main(s.args.filter((_, i) => i !== index && i !== index + 1), s.runtime)).rejects.toThrow('シードの選定元の指定が不足しているか不正です');
});

test.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('未捕捉選定の実行数は正の安全な整数に限る: %s', async (count) => {
  const s = setupMissed();
  await expect(main([...s.args.slice(0, -1), count], s.runtime)).rejects.toThrow('実行引数が不足しているか不正です');
});

test.each([{ from: [] }, { from: ['--from', 'candidates'] }])('候補方式で追加引数を拒否する: %j', async ({ from }) => {
  const s = setup();
  for (const extra of [['--base', 'baseline'], ['--runs-per-review', '2']]) {
    await expect(main([...s.args, ...from, ...extra], s.runtime)).rejects.toThrow('シードの選定元の指定が不足しているか不正です');
  }
});

test('候補方式の明示と省略で保存内容・集計・標準出力が変わらない', async () => {
  const s = setup(); await main(s.args, s.runtime);
  const before = s.read(), reportPath = join(s.runtime.reportsDir!, 'seed-select-probe-smoke.json');
  const report = readFileSync(reportPath, 'utf8'), stdout = (s.runtime.stdout as jest.Mock).mock.calls.slice();
  unlinkSync(s.seeds());
  (s.runtime.stdout as jest.Mock).mockClear();
  await main([...s.args, '--from', 'candidates'], s.runtime);
  expect(s.read()).toEqual(before);
  expect(readFileSync(reportPath, 'utf8')).toBe(report);
  expect((s.runtime.stdout as jest.Mock).mock.calls).toEqual(stdout);
  expect(JSON.parse(report)).not.toHaveProperty('from');
});

test.each(['validation', 'test', '--open-test-set'])('未捕捉選定でも開発群の制限を維持する: %s', async (subset) => {
  const s = setupMissed();
  const args = subset === '--open-test-set' ? [...s.args, subset] : s.args.map((value) => value === 'smoke' ? subset : value);
  await expect(main(args, s.runtime)).rejects.toThrow(subset === '--open-test-set' ? '実行引数が不正です' : 'シードの下調べは開発群でだけ実行できます');
});
