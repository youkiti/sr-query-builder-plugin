/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURES, SEED, auditGold, buildProtocol, computeHeldOut, loadSeedsFile, parseSeedSplit, seedFileName, parsePrepareArgs, prepare, selectSeeds, seedSplitId,
  validateSeeds, type GoldRecord, type ParsedReview,
} from './prepare';
import { CASES, type BenchCase, type StudyGroup } from './types';

const parsed: ParsedReview = { title: 'title', objectives: 'objective', eligibility: {
  types_of_studies: 'study', types_of_participants: 'people', types_of_interventions: 'intervention', types_of_outcomes: 'outcome',
  inclusion_criteria_text: 'MUST NOT LEAK',
}, license: 'CC BY', included_studies: [{ study_id: 'missing', pmids: [] }] };
const gold: GoldRecord = { pmcid: 'test', included_pmids: ['1', '2', '3', '4', '5'], excluded_pmids: ['2'],
  included_without_pmid: ['missing'], pmid_to_study_id: { '1': 'a', '2': ['a', 'b'], '3': ['c'], '4': 'd' } };

test('protocol は許可した 6 フィールドだけを使用する', () => {
  const text = buildProtocol({ ...parsed, search_methods_text: 'SECRET', results: 'SECRET', search_strategies: ['SECRET'] } as ParsedReview);
  expect(text).toContain('intervention');
  expect(text).not.toMatch(/SECRET|MUST NOT LEAK/);
});
test('文字列・配列の対応から共有群と監査理由を作り、研究名を保持する', () => {
  const { groups, audit } = auditGold(gold, parsed);
  expect(groups[0]).toEqual({ id: 'a + b', members: [{ studyId: 'a', pmids: ['1', '2'] }, { studyId: 'b', pmids: ['2'] }], pmids: ['1', '2'] });
  expect(audit).toMatchObject({ includedStudyCount: 4, overlapPmids: ['2'], sharedPmids: [{ pmid: '2', studies: ['a', 'b'] }],
    withoutPmid: ['missing'], unmappedPmids: ['5'], manual_review: true });
});
test('共有 PMID の連鎖を同じ群へまとめる', () => {
  const { groups } = auditGold({ ...gold, pmid_to_study_id: { '1': ['a', 'b'], '2': ['b', 'c'] } }, parsed);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.members).toEqual([{ studyId: 'a', pmids: ['1'] }, { studyId: 'b', pmids: ['1', '2'] }, { studyId: 'c', pmids: ['2'] }]);
});
test('年の昇順・同年の PMID 数値順・不明年のフォールバックと固定乱数', () => {
  const groups: StudyGroup[] = ['a', 'b', 'c'].map((id) => ({ id, members: [{ studyId: id, pmids: ['10', '2', '3'] }], pmids: ['10', '2', '3'] }));
  expect(selectSeeds(groups, { '10': 1999, '2': 2000, '3': 2000 }).selections.every((s) => s.pmid === '10')).toBe(true);
  expect(selectSeeds(groups, { '10': 2000, '2': 2000, '3': 2000 }).selections.every((s) => s.pmid === '2')).toBe(true);
  expect(selectSeeds(groups, { '10': null, '2': 2000, '3': 1999 }).selections.every((s) => s.pmid === '2')).toBe(true);
  expect(selectSeeds(groups, {})).toEqual(selectSeeds([...groups].reverse(), {}));
  expect(() => validateSeeds({ seed: 1, selections: [] }, groups)).toThrow();
});
test('再準備しても seeds.json を書き直さず 3 ケースを生成する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optimize-prepare-'));
  const fixtures = join(dir, 'fixtures');
  mkdirSync(join(dir, 'data/processed/cc-by/gold'), { recursive: true });
  mkdirSync(join(dir, 'data/interim/cc-by/parsed'), { recursive: true });
  writeFileSync(join(dir, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), CASES.map((c) => JSON.stringify({ ...gold, pmcid: c.pmcid })).join('\n'));
  for (const c of CASES) writeFileSync(join(dir, `data/interim/cc-by/parsed/${c.pmcid}.json`), JSON.stringify(parsed));
  prepare(dir, fixtures);
  const path = join(fixtures, CASES[0].id, 'seeds.json');
  const frozen = readFileSync(path, 'utf8') + ' ';
  writeFileSync(path, frozen);
  const auditPath = join(fixtures, CASES[0].id, 'audit.json');
  const auditText = readFileSync(auditPath, 'utf8').replace('"manual_review": true', '"manual_review": false') + ' ';
  writeFileSync(auditPath, auditText);
  prepare(dir, fixtures);
  expect(readFileSync(path, 'utf8')).toBe(frozen);
  expect(readFileSync(auditPath, 'utf8')).toBe(auditText);
});

test('missing benchmark directory explains the environment variable to configure', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'prepare-missing-')), 'absent');
  expect(() => prepare(missing)).toThrow('COCHRANE_BENCH_DIR');
});

test('computeHeldOut は既定 split で 3 ケースすべての case.json の heldOut と一致する（実測）', () => {
  for (const definition of CASES) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, definition.id, 'case.json'), 'utf8')) as BenchCase;
    expect(computeHeldOut(fixture.gold, fixture.seeds)).toEqual(fixture.heldOut);
  }
});

test('seedSplitId は既定 SEED を s20260912 に変換し、loadSeedsFile は seeds.json/seeds-<n>.json を読み分ける', () => {
  expect(seedSplitId(SEED)).toBe('s20260912');
  expect(seedSplitId(42)).toBe('s42');
  const fixtureDir = join(FIXTURES, CASES[0].id);
  expect(loadSeedsFile(fixtureDir, SEED).seed).toBe(SEED);
  expect(() => loadSeedsFile(fixtureDir, 424242)).toThrow('eval:prepare -- --seed 424242');
});

test('parsePrepareArgs は --seed だけを読み、未指定なら undefined', () => {
  expect(parsePrepareArgs([])).toEqual({});
  expect(parsePrepareArgs(['--seed', '42'])).toEqual({ seed: 42 });
  expect(() => parsePrepareArgs(['--seed', 'abc'])).toThrow('整数');
  expect(() => parsePrepareArgs(['--seed'])).toThrow('整数');
});

test('--seed で追加のシード分割を凍結し、default と異なる 3 群を選ぶことがある。再実行しても上書きしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optimize-prepare-seed-'));
  const fixtures = join(dir, 'fixtures');
  mkdirSync(join(dir, 'data/processed/cc-by/gold'), { recursive: true });
  mkdirSync(join(dir, 'data/interim/cc-by/parsed'), { recursive: true });
  writeFileSync(join(dir, 'data/processed/cc-by/gold/task2_search_screen.jsonl'), CASES.map((c) => JSON.stringify({ ...gold, pmcid: c.pmcid })).join('\n'));
  for (const c of CASES) writeFileSync(join(dir, `data/interim/cc-by/parsed/${c.pmcid}.json`), JSON.stringify(parsed));
  prepare(dir, fixtures, 555);
  const altPath = join(fixtures, CASES[0].id, `seeds-555.json`);
  expect(existsSync(altPath)).toBe(true);
  const alt = JSON.parse(readFileSync(altPath, 'utf8'));
  expect(alt.seed).toBe(555);
  validateSeeds(alt, auditGold(gold, parsed).groups);
  const frozen = readFileSync(altPath, 'utf8') + ' ';
  writeFileSync(altPath, frozen);
  prepare(dir, fixtures, 555);
  expect(readFileSync(altPath, 'utf8')).toBe(frozen);
  // 既定 SEED を明示しても、既定分割と同じなので追加ファイルは作らない。
  prepare(dir, fixtures, SEED);
  expect(existsSync(join(fixtures, CASES[0].id, `seeds-${SEED}.json`))).toBe(false);
});

test('分割指定は10 進の非負整数表記に限定し、名前は命名規則に制限する', () => {
  for (const raw of ['42', '0', String(SEED), '9007199254740991']) {
    expect(parseSeedSplit(raw)).toBe(Number(raw));
    expect(seedSplitId(parseSeedSplit(raw))).toBe(`s${Number(raw)}`);
  }
  for (const raw of ['abc', 'without-one', 'a', 'a'.repeat(32), 's42-extra']) {
    expect(parseSeedSplit(raw)).toBe(raw);
    expect(seedSplitId(raw)).toBe(raw);
    expect(seedFileName(raw)).toBe(`seeds-${raw}.json`);
  }
  for (const raw of ['s42', 's20260912', 's-42', 'Upper', 'a_b', '../other', 'a/b', 'a'.repeat(33), '42name', '1.5', '9007199254740992', 'a\n']) {
    expect(() => parseSeedSplit(raw)).toThrow('--seeds');
  }
  for (const raw of ['-42', '-1', '0042', '042', '+42', '42.0', '4.2e1', '1e3', '0x2a', ' 42 ', '', ' ', '42\n']) {
    expect(() => parseSeedSplit(raw)).toThrow('10 進の非負整数');
  }
});

test('名前付き集合は name の一致と識別形式・3 群の整合を検証する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'named-seeds-'));
  const fixture = JSON.parse(readFileSync(join(FIXTURES, CASES[0].id, 'case.json'), 'utf8')) as BenchCase;
  const named = { name: 'without-one', selections: fixture.seeds.selections };
  const path = join(dir, 'seeds-without-one.json');
  expect(() => loadSeedsFile(dir, named.name)).toThrow(path);
  expect(() => loadSeedsFile(dir, named.name)).toThrow('"name":"without-one","selections"');
  writeFileSync(path, JSON.stringify(named));
  expect(loadSeedsFile(dir, named.name)).toEqual(named);
  expect(() => validateSeeds(named, fixture.gold)).not.toThrow();
  for (const invalid of [{ ...named, name: 'other' }, fixture.seeds, { ...named, seed: 42 }]) {
    writeFileSync(path, JSON.stringify(invalid));
    expect(() => loadSeedsFile(dir, named.name)).toThrow('要求した集合');
  }
  writeFileSync(join(dir, 'seeds-42.json'), JSON.stringify(named));
  expect(() => loadSeedsFile(dir, 42)).toThrow('要求した分割');
  expect(() => validateSeeds({ ...named, name: 's42' }, fixture.gold)).toThrow('群構造');
  expect(() => validateSeeds({ ...named, selections: named.selections.slice(1) }, fixture.gold)).toThrow('群構造');
  expect(() => validateSeeds({ ...named, selections: [named.selections[0]!, named.selections[0]!, named.selections[1]!] }, fixture.gold)).toThrow('群構造');
});
