/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './seedSelect';
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
