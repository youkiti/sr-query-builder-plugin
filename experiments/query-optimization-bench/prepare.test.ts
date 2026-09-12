/** @jest-environment node */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditGold, buildProtocol, prepare, selectSeeds, validateSeeds, type GoldRecord, type ParsedReview } from './prepare';
import { CASES, type StudyGroup } from './types';

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
