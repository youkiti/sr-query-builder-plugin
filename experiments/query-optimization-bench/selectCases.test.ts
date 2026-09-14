/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closesWithAnd, main, medlineMatchedBy, pickCases, screenReview, updateEvidence, type SelectionGold, type SelectionParsed } from './selectCases';
import { FIXTURES, selectSeeds } from './prepare';
import { CASES, type BenchCase } from './types';

const gold: SelectionGold = { pmcid: 'PMC123', cochrane_id: 'CD123', needs_review: false,
  included_pmids: Array.from({ length: 15 }, (_, i) => String(i + 1)), excluded_pmids: [], included_without_pmid: ['x', 'y', 'z'],
  pmid_to_study_id: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [String(i + 1), `study${i + 1}`])) };
const parsed: SelectionParsed = { title: 'Drugs to reduce bleeding', objectives: '', eligibility: {}, license: 'CC BY', included_studies: [],
  search_strategies: [{ database: 'MEDLINE', raw_text: '1. exp drugs/ 2. surgery/ 3. 1 and 2' }] };
const date = { pmcid: gold.pmcid, status: 'found', needs_review: false, medline_last_search_date: '2020-01-02' };
const screen = (g = gold, p: SelectionParsed | null = parsed, d = date) => screenReview(g, p, d, {});

test('15 研究・PMID 無し 3 件ちょうどは適格で、全基準と根拠を残す', () => {
  const row = screen();
  expect(row.status).toBe('eligible');
  expect(Object.keys(row.criteria)).toHaveLength(9);
  expect(row.criteria.studiesWithPmid).toEqual({ pass: true, evidence: 15 });
  expect(row.criteria.withoutPmid).toEqual({ pass: true, evidence: ['x', 'y', 'z'] });
  expect(screen({ ...gold, included_pmids: gold.included_pmids.slice(1) }).reasons).toContain('studiesWithPmid');
  expect(screen({ ...gold, included_without_pmid: ['w', 'x', 'y', 'z'] }).reasons).toContain('withoutPmid');
});

test('事前除外・parsed 欠測・重複・共有・未対応・needs_review・検索日の各失格を残す', () => {
  for (const pmcid of ['PMC9009295', 'PMC9943918', 'PMC9936832', 'PMC10164701', 'PMC5865125', 'PMC11384553', 'PMC11110109']) {
    expect(screen({ ...gold, pmcid }).reasons).toContain('excludedPrior');
  }
  expect(screen(gold, null).reasons).toContain('parsedAvailable');
  expect(screen({ ...gold, excluded_pmids: ['1'] }).reasons).toContain('noIncludedExcludedOverlap');
  expect(screen({ ...gold, pmid_to_study_id: { ...gold.pmid_to_study_id, '1': ['study1', 'other'] } }).reasons).toContain('noSharedPmid');
  expect(screen({ ...gold, pmid_to_study_id: { ...gold.pmid_to_study_id, '1': [] } }).reasons).toContain('noSharedPmid');
  expect(screen({ ...gold, needs_review: true }).reasons).toContain('goldNotNeedsReview');
  expect(screen(gold, { ...parsed, search_strategies: [{ database: 'Embase', raw_text: '3. 1 and 2' }] }).reasons).toContain('medlineStrategyClosesWithAnd');
  for (const d of [{ ...date, status: 'missing' }, { ...date, needs_review: true }, { ...date, medline_last_search_date: '2020-1-2' }]) {
    expect(screen(gold, parsed, d).reasons).toContain('searchDateFound');
  }
});

test('収録開始年だけのラベルでも MEDLINE の AND 終了と根拠を残す', () => {
  const database = 'Searched: 1946 to 18 August 2021';
  const raw_text = '#4 "Diet, Sodium‐Restricted"[Mesh]\n#7 sodium[Title/Abstract]\n#8 #4 AND #7';
  const row = screen(gold, { ...parsed, search_strategies: [{ database, raw_text }] });
  expect(row.status).toBe('eligible');
  expect(row.criteria.medlineStrategyClosesWithAnd).toEqual({ pass: true,
    evidence: [{ database, matchedBy: 'coverage1946', pass: true, lastStep: '#8 #4 AND #7' }] });
});

test.each(['MEDLINE (Ovid)', 'PubMed', 'Embase and MEDLINE'])('明示ラベルを判定根拠に残す: %s', (database) => {
  const row = screen(gold, { ...parsed, search_strategies: [{ database, raw_text: '3. 1 and 2' }] });
  expect(row.criteria.medlineStrategyClosesWithAnd).toEqual({ pass: true,
    evidence: [{ database, matchedBy: 'databaseLabel', pass: true, lastStep: '3. 1 and 2' }] });
});

test.each(['Mesh', 'MeSH Terms', 'tiab', 'Title/Abstract', 'pt', 'Publication Type', 'TIAB'])('PubMed タグを判定根拠に残す: %s', (tag) => {
  const database = 'Search strategy';
  const raw_text = `#1 sodium[${tag}]\n#2 diet\n#3 #1 AND #2`;
  const row = screen(gold, { ...parsed, search_strategies: [{ database, raw_text }] });
  expect(row.criteria.medlineStrategyClosesWithAnd).toEqual({ pass: true,
    evidence: [{ database, matchedBy: 'pubmedFieldTag', pass: true, lastStep: '#3 #1 AND #2' }] });
});

test.each([
  ['Searched: 1947 to 18 August 2021', '1 exp sodium/\n2 diet.ti,ab.\n3 1 and 2'],
  ['Embase (Ovid)', '1 sodium[tiab]\n2 diet\n3 1 and 2'],
])('他データベースの戦略を MEDLINE とみなさない: %s', (database, raw_text) => {
  const row = screen(gold, { ...parsed, search_strategies: [{ database, raw_text }] });
  expect(row.criteria.medlineStrategyClosesWithAnd).toEqual({ pass: false, evidence: [] });
  expect(row.status).toBe('ineligible');
});

test.each(['Embase', 'CENTRAL', 'Cochrane', 'CINAHL', 'PsycINFO', 'Web of Science', 'Scopus', 'ClinicalTrials', 'ICTRP'])('他 DB の明示ラベルを収録年とタグより優先して除外する: %s', (database) => {
  expect(medlineMatchedBy({ database: `${database} 1946`, raw_text: 'sodium[tiab]' })).toBeNull();
});

test('1946 の単語境界を判定し、タグなしでも収録年から認識する', () => {
  expect(medlineMatchedBy({ database: 'Searched: 1946 to current', raw_text: '3. 1 and 2' })).toBe('coverage1946');
  expect(medlineMatchedBy({ database: 'Search 11946', raw_text: '3. 1 and 2' })).toBeNull();
});

test.each([
  ['7 sodium/\n49 diet/\n60 trial/\n61 7 and 49 and 60', true, '61 7 and 49 and 60'],
  ['61 7 and 49 and 60\n62 limit 61 to yr="2000 ‐Current"', false, '62 limit 61 to yr="2000 ‐Current"'],
])('ピリオド無し Ovid の最後のステップで適否を決める: %s', (raw_text, pass, lastStep) => {
  const row = screen(gold, { ...parsed, search_strategies: [{ database: 'MEDLINE', raw_text }] });
  expect(row.criteria.medlineStrategyClosesWithAnd).toEqual({ pass,
    evidence: [{ database: 'MEDLINE', matchedBy: 'databaseLabel', pass, lastStep }] });
  expect(row.status).toBe(pass ? 'eligible' : 'ineligible');
});

test.each([
  ['60 term/\n61 7 and 49 and 60', true, '61 7 and 49 and 60'],
  ['60 term/\r\n  61 7 AND 49 and 60', true, '61 7 AND 49 and 60'],
  ['61 7 and 49 and 60\n62 limit 61 to yr="2000 ‐Current"', false, '62 limit 61 to yr="2000 ‐Current"'],
  ['131. term/ 132. 104 and 131', true, '132. 104 and 131'],
  ['1. term\n2. word\n3. 1 AND 2 and 1', true, '3. 1 AND 2 and 1'],
  ['#1 term #5 word #11 other #12 #5 AND #11', true, '#12 #5 AND #11'],
  ['#12 #5 AND #11 AND #2', true, '#12 #5 AND #11 AND #2'],
  ['#12 #5 AND #11\n#3 lower step', false, '#3 lower step'],
  ['#12 #5 OR #11 #13 #12 AND #7', true, '#13 #12 AND #7'],
  ['128. 1 and 2 129. or/123-128', false, '129. or/123-128'],
  ['131. 129 not 130', false, '131. 129 not 130'],
  ['131. exp animals/ not humans/', false, '131. exp animals/ not humans/'],
  ['#12 #5 OR #11', false, '#12 #5 OR #11'],
  ['#12 #5 NOT #11', false, '#12 #5 NOT #11'],
  ['#12 #5 AND humans[mesh]', false, '#12 #5 AND humans[mesh]'],
  ['no numbered steps', false, null],
])('最終番号付きステップを判定する: %s', (raw, pass, lastStep) => {
  expect(closesWithAnd(raw as string)).toEqual({ pass, lastStep });
});

test.each(['2012 to current', '2012–2017', '1999 - present', 'limit 12 to yr=2015', 'limit 3 to ed =2017', 'limit 1 to dt=2020'])('日付制限を検出: %s', (raw) => {
  expect(updateEvidence({ ...parsed, search_strategies: [{ database: 'PubMed', raw_text: raw }] })).toHaveLength(1);
});
test('1946 からの収録範囲と無関係な語を除き、前後 80 文字を残す', () => {
  expect(updateEvidence({ ...parsed, search_methods_text: 'updates updater', search_strategies: [{ database: 'MEDLINE', raw_text: '1946 to current' }] })).toEqual([]);
  const result = updateEvidence({ ...parsed, search_methods_text: `${'a'.repeat(100)} updated ${'b'.repeat(100)}` });
  expect(result[0]!.excerpt).toHaveLength(167);
  expect(result[0]!.source).toBe('search_methods_text');
});
test('更新検索フラグの判断待ちを pick が拒否し、人の判断で適否を確定する', () => {
  const flagged = { ...parsed, search_methods_text: 'We updated the search.' };
  const pending = screen(gold, flagged);
  expect(pending.status).toBe('pending');
  expect(() => pickCases([screen(), pending], 20260915, 3, '')).toThrow('判断待ち');
  for (const updateSearch of [true, false]) {
    expect(screenReview(gold, flagged, date, { [gold.pmcid]: { updateSearch, note: '根拠を確認' } }).status).toBe(updateSearch ? 'ineligible' : 'eligible');
  }
  expect(screen({ ...gold, needs_review: true }, flagged).status).toBe('ineligible');
});
test('pick は PMCID 整列後に決定的に選び、入力ハッシュと安全な suggestedId を保存する', () => {
  const rows = ['PMC4', 'PMC2', 'PMC1', 'PMC3'].map((pmcid) => screen({ ...gold, pmcid }));
  const one = pickCases(rows, 20260915, 3, 'same');
  expect(one).toEqual(pickCases([...rows].reverse(), 20260915, 3, 'same'));
  expect(one.eligible).toEqual(['PMC1', 'PMC2', 'PMC3', 'PMC4']);
  expect(one.selected[0]!.suggestedId).toBe('c1-drugs-to-reduce');
  expect(one.screeningSha256).toHaveLength(64);
  expect(pickCases(rows, 20260915, 9, 'other').selected).toHaveLength(4);
  expect(pickCases([{ ...rows[0]!, title: `${'A'.repeat(100)} ! @` }], 1, 1, '').selected[0]!.suggestedId).toMatch(/^[a-z][a-z0-9-]{0,40}$/);
});
test('selectSeeds の共通化前の凍結 fixture と出力が全ケースで一致する', () => {
  for (const c of CASES) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, c.id, 'case.json'), 'utf8')) as BenchCase;
    const audit = JSON.parse(readFileSync(join(FIXTURES, c.id, 'audit.json'), 'utf8')) as { publicationYears: Record<string, number | null> };
    expect(selectSeeds(fixture.gold, audit.publicationYears)).toEqual(fixture.seeds);
  }
});
test('screen の再生成と pick の上書き禁止、適格不足の表示をローカル入力で確認する', () => {
  const root = mkdtempSync(join(tmpdir(), 'select-cases-'));
  const out = join(root, 'selection');
  const write = (path: string, value: unknown) => { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
  write('data/processed/cc-by/gold/task2_search_screen.jsonl', gold);
  write('data/interim/cc-by/parsed/PMC123.json', parsed);
  write('data/audit/medline_search_dates/session_2026-09-14/final_cc-by.jsonl', date);
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    main(['screen'], root, out);
    const raw = readFileSync(join(out, 'screening.json'), 'utf8');
    main(['screen'], root, out);
    expect(readFileSync(join(out, 'screening.json'), 'utf8')).toBe(raw);
    expect(existsSync(join(out, 'update-search-decisions.json'))).toBe(false);
    main(['pick', '--seed', '20260915', '--count', '3'], root, out);
    expect(stdout.mock.calls.flat().join('')).toContain('要求数未満');
    expect(() => main(['pick', '--seed', '1', '--count', '3'], root, out)).toThrow();
  } finally { stdout.mockRestore(); }
});
