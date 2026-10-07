/** @jest-environment node */
import { loadConditions, validateConditions } from './conditions';

test.each([undefined, false, true])('表の指定を省略または真偽値にできる: %j', (table) => {
  const conditions = { ...loadConditions('v1'), table };
  expect(validateConditions(conditions, 'v1')).toEqual(conditions);
});
test.each([{ table: 'true' }, { table: null }, { table: true, tools: ['submit', 'seeds'] },
  { table: true, tools: ['submit', 'titles'] }, { table: true, tools: ['submit', 'outside'] },
  { table: true, seeds: { label: 'seed', max: 1 } }])('不正な表の条件を拒否する: %j', (override) => {
  expect(() => validateConditions({ ...loadConditions('v1'), ...override }, 'v1')).toThrow('表の条件が不正です');
});
test('表の版と表から作った式を束ねる版を読み込む', () => {
  expect(loadConditions('v11')).toMatchObject({ table: true, model: 'claude-haiku-5-5' });
  expect(loadConditions('v12')).toMatchObject({ combine: { from: 'v11', k: 3 }, model: 'claude-haiku-5-5' });
  expect(loadConditions('v12').table).toBeUndefined();
});

test('概念の束ね方のしきい値と境界値を受け付ける', () => {
  for (const blocks of [{ minOverlap: 0, minMargin: 1, maxConcepts: 1 }, { minOverlap: 1, minMargin: 0, maxConcepts: 4 }]) {
    const value = { ...loadConditions('v0'), combine: { from: 'v1', k: 3, blocks } };
    expect(validateConditions(value, 'v0')).toEqual(value);
  }
  expect(loadConditions('v6').combine).toEqual({ from: 'v1', k: 3, blocks: { minOverlap: 0.3, minMargin: 0.1, maxConcepts: 3 } });
});
test.each([null, {}, { minOverlap: -0.1 }, { minOverlap: 1.1 }, { minOverlap: Infinity }, { minOverlap: NaN },
  { minOverlap: '0.3' }, { minMargin: -0.1 }, { minMargin: 1.1 }, { minMargin: Infinity }, { minMargin: NaN },
  { maxConcepts: 0 }, { maxConcepts: 5 }, { maxConcepts: 1.5 }])('不正な概念のしきい値を拒否する: %j', (change) => {
  const blocks = change === null ? null : Object.keys(change).length ? { minOverlap: 0.3, minMargin: 0.1, maxConcepts: 3, ...change } : {};
  expect(() => validateConditions({ ...loadConditions('v0'), combine: { from: 'v1', k: 3, blocks } }, 'v0')).toThrow('束ねる条件');
});
test('版の一覧に概念のしきい値を付けると拒否する', () => {
  expect(() => validateConditions({ ...loadConditions('v0'), combine: { versions: ['v1', 'v2'], blocks: { minOverlap: 0.3, minMargin: 0.1, maxConcepts: 3 } } }, 'v0')).toThrow('束ねる条件');
});

test('日付の接尾辞のない固定モデルと実行役の正常値を受け付ける', () => {
  for (const runner of [undefined, 'claude-subagent', 'gemini-api']) {
    expect(validateConditions({ ...loadConditions('v0'), model: 'gemini-2.5-flash', runner }, 'v0').runner).toBe(runner);
  }
});
test.each(['latest', 'gemini-latest-12345678', 'gemini.latest', 'prefixlatestsuffix', 'gemini/a'])('不正なモデルを拒否する: %s', (model) => {
  expect(() => validateConditions({ ...loadConditions('v0'), model }, 'v0')).toThrow('固定 ID');
});
test.each(['other', '', null, 1])('不正な実行役を拒否する: %j', (runner) => {
  expect(() => validateConditions({ ...loadConditions('v0'), runner }, 'v0')).toThrow('実行役');
});

test('固定した版と生成条件を読み込む', () => {
  expect(loadConditions('v0')).toMatchObject({ version: 'v0', model: 'claude-haiku-4-5-20251001',
    tools: ['check', 'count', 'mesh', 'submit'], maxMeasurements: 20, maxSubmissions: 4 });
});
test.each([{ version: 'v1' }, { model: 'claude-latest' }, { tools: ['check'] }, { tools: ['submit', 'other'] },
  { maxMeasurements: 0 }, { maxSubmissions: 1.5 }, { maxMeasurements: Infinity }])('不正な生成条件を拒否する: %j', (change) => {
  expect(() => validateConditions({ ...loadConditions('v0'), ...change }, 'v0')).toThrow();
});
test('フォルダ外の版を拒否する', () => { expect(() => loadConditions('../v0')).toThrow(); });

test('外側を見る道具を含む版も受け付ける', () => {
  const conditions = loadConditions('v0');
  conditions.tools.push('outside');
  expect(validateConditions(conditions, 'v0').tools).toContain('outside');
});

test.each([2, 3, 10])('束ねる本数 %i と元の版を受け付ける', (k) => {
  const conditions = { ...loadConditions('v0'), combine: { from: 'source_1-a', k } };
  expect(validateConditions(conditions, 'v0')).toEqual(conditions);
});

test.each([{ from: 'v0', k: 3 }, { from: '../v1', k: 3 }, { from: '', k: 3 }, { from: 1, k: 3 },
  { from: 'v1', k: 1 }, { from: 'v1', k: 11 }, { from: 'v1', k: 2.5 }, { from: 'v1', k: NaN }, null])(
  '不正な束ねる条件を拒否する: %j', (combine) => {
    expect(() => validateConditions({ ...loadConditions('v0'), combine }, 'v0')).toThrow('束ねる条件');
  });

test('束ねる条件のない既存版も受け付ける', () => {
  const conditions = loadConditions('v0');
  expect(conditions.combine).toBeUndefined();
  expect(validateConditions(conditions, 'v0')).toEqual(conditions);
});

test.each([2, 10])('別々の版 %i 個を束ねる条件を受け付ける', (count) => {
  const conditions = { ...loadConditions('v0'), combine: {
    versions: Array.from({ length: count }, (_, i) => `source_${i}-a`),
  } };
  expect(validateConditions(conditions, 'v0')).toEqual(conditions);
});

test.each([{ versions: ['v1'] }, { versions: Array.from({ length: 11 }, (_, i) => `source${i}`) },
  { versions: ['v1', 'v1'] }, { versions: ['v1', 'v0'] }, { versions: ['v1', '../v2'] },
  { versions: ['v1', ''] }, { versions: ['v1', 2] }, { versions: 'v1,v2' }, { versions: null },
  { versions: ['v1', 'v2'], from: 'v1', k: 2 }, { versions: ['v1', 'v2'], from: 'v1' },
  { versions: ['v1', 'v2'], k: 2 }, {}, { from: 'v1' }, { k: 2 }])(
  '不正な別々の版の束ねる条件を拒否する: %j', (combine) => {
    expect(() => validateConditions({ ...loadConditions('v0'), combine }, 'v0')).toThrow('束ねる条件');
  });
