/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomParser } from '../../query-optimization-bench/domParser';
import { loadConditions, validateConditions } from './conditions';
import { main } from './startSeededRuns';
import { main as startRuns, type RunRuntime } from './startRuns';
import { splitReviews } from './split';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

installDomParser();
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'p2f-seeded-')), runs = join(root, 'runs');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1)); fixture(root, rows);
  const selected = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development').slice(0, 2);
  const runtime: RunRuntime = { env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: 'FAKE_SECRET' }, casesDir: join(root, 'cases'), harnessDir: join(root, 'harness'),
    now: () => new Date('2026-01-01'), stdout: jest.fn(), stderr: jest.fn(), sleep: async () => undefined,
    rateLimiter: { acquire: jest.fn(async () => undefined) }, fetchImpl: jest.fn(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain('efetch.fcgi'); expect(url.searchParams.get('id')).toBe('90000001,90000002');
      expect(url.searchParams.has('maxdate')).toBe(false);
      return new Response('<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>90000002</PMID><Article><ArticleTitle>題二</ArticleTitle></Article></MedlineCitation></PubmedArticle>'
        + '<PubmedArticle><MedlineCitation><PMID>90000001</PMID><Article><ArticleTitle>題一</ArticleTitle><Abstract><AbstractText>合成抄録</AbstractText></Abstract></Article>'
        + '<MeshHeadingList><MeshHeading><DescriptorName MajorTopicYN="Y">主題</DescriptorName></MeshHeading><MeshHeading><DescriptorName MajorTopicYN="N">副題</DescriptorName></MeshHeading></MeshHeadingList>'
        + '</MedlineCitation></PubmedArticle></PubmedArticleSet>');
    }) };
  writeLines(join(runtime.casesDir!, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(runtime.casesDir!, 'subsets.json'), { smoke: selected.map((row) => row.pmcid) });
  const conditions = { ...loadConditions('v0'), seeds: { label: 'probe', max: 2 } };
  const conditionPath = join(runtime.harnessDir!, 'v0/conditions.json'); writeJson(conditionPath, conditions);
  const seedPath = (i = 0) => join(runs, '_seeds/probe', `${selected[i]!.pmcid}.json`);
  const selection = { pmids: ['90000001', '90000002'], studyIds: ['study:甲', 'study:乙'], max: 2, selectedAt: '2026-01-01', candidatesFingerprint: '指紋' };
  selected.forEach((row, i) => {
    mkdirSync(join(runtime.casesDir!, row.pmcid)); writeFileSync(join(runtime.casesDir!, row.pmcid, 'protocol.md'), '合成プロトコル');
    writeJson(seedPath(i), { ...selection, pmids: i ? [] : selection.pmids, studyIds: i ? [] : selection.studyIds });
  });
  const dir = (i = 0, n = 1) => join(runs, 'v0', selected[i]!.pmcid, `run-${n}`);
  return { root, runs, runtime, selected, seedPath, selection, dir, conditionPath, conditions,
    args: ['--out', runs, '--version', 'v0', '--subset', 'smoke', '--runs-per-review', '2'] };
}

test('レビューごとに一度だけ日付なしで取得し、選定順の書誌と空の書誌を各実行に置く', async () => {
  const s = setup(); expect(await main(s.args, s.runtime)).toBe(0);
  const md = readFileSync(join(s.dir(), 'seeds.md'), 'utf8');
  expect(md).toContain('# シード論文（このレビューに組み入れられると、人が判定した論文）');
  expect(md).toContain('## シード 1\nPMID: 90000001\n題: 題一\nMeSH 見出し: *主題, 副題\n抄録: 合成抄録');
  expect(md).toContain('MeSH 見出し: （未付与）\n抄録: （抄録なし）');
  expect(readFileSync(join(s.dir(0, 2), 'seeds.md'), 'utf8')).toBe(md);
  expect(JSON.parse(readFileSync(join(s.dir(), 'seeds.json'), 'utf8'))).toEqual({ pmids: s.selection.pmids });
  expect(readFileSync(join(s.dir(1), 'seeds.md'), 'utf8')).toBe('# シード論文\nこのレビューでは、シード論文は見つかっていません。\n');
  expect(JSON.parse(readFileSync(join(s.dir(1), 'seeds.json'), 'utf8'))).toEqual({ pmids: [] });
  expect(s.runtime.fetchImpl).toHaveBeenCalledTimes(1); expect(s.runtime.rateLimiter!.acquire).toHaveBeenCalledTimes(1);
  expect(s.runtime.stdout).toHaveBeenCalledWith('シードあり: 1 件、シードなし: 1 件\n');
  expect(JSON.stringify((s.runtime.stdout as jest.Mock).mock.calls)).not.toMatch(/PMC|900000|題一|FAKE_SECRET/);
});

test.each(['欠落', '余分', '通信失敗'])('取得が不明なら実行フォルダを作らない: %s', async (mode) => {
  const s = setup();
  s.runtime.fetchImpl = jest.fn(async () => {
    if (mode === '通信失敗') throw new Error('FAKE_SECRET PMC1234567 90000001 題一');
    return new Response(mode === '欠落' ? '<PubmedArticleSet />' : '<PubmedArticleSet><PubmedArticle><PMID>99999999</PMID></PubmedArticle></PubmedArticleSet>');
  });
  await expect(main(s.args, s.runtime)).rejects.toThrow('結果不明');
  expect(existsSync(join(s.runs, 'v0'))).toBe(false);
});

test.each(['なし', '上限違い'])('全体の選定不足を先に検査する: %s', async (mode) => {
  const s = setup();
  if (mode === 'なし') unlinkSync(s.seedPath(1)); else writeJson(s.seedPath(1), { ...s.selection, max: 3 });
  await expect(main(s.args, s.runtime)).rejects.toThrow('シードの選定が 1 件不足しています');
  expect(existsSync(join(s.runs, 'v0'))).toBe(false); expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('既存フォルダは全体で先に拒否する', async () => {
  const s = setup(); mkdirSync(s.dir(1, 2), { recursive: true });
  await expect(main(s.args, s.runtime)).rejects.toThrow('実行フォルダが既にあります');
  expect(existsSync(s.dir())).toBe(false); expect(s.runtime.fetchImpl).not.toHaveBeenCalled();
});
test('通常版とシード版で開始コマンドを相互に拒否する', async () => {
  const s = setup(); expect(() => startRuns(s.args, s.runtime)).toThrow('この版はシードを使います（startSeededRuns を使ってください）');
  writeJson(s.conditionPath, loadConditions('v0'));
  await expect(main(s.args, s.runtime)).rejects.toThrow('この版はシードを使いません（startRuns を使ってください）');
});
test.each([null, {}, { label: '../a', max: 2 }, { label: 1, max: 2 }, { label: 'a', max: 0 }, { label: 'a', max: 6 }, { label: 'a', max: 1.5 }])('不正なシード条件を拒否する: %j', (seeds) => {
  expect(() => validateConditions({ ...loadConditions('v0'), seeds }, 'v0')).toThrow('シードの条件が不正です');
});
