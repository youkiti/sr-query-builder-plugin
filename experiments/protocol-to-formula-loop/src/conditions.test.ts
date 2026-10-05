/** @jest-environment node */
import { loadConditions, validateConditions } from './conditions';

test('固定した版と生成条件を読み込む', () => {
  expect(loadConditions('v0')).toMatchObject({ version: 'v0', model: 'claude-haiku-4-5-20251001',
    tools: ['check', 'count', 'mesh', 'submit'], maxMeasurements: 20, maxSubmissions: 4 });
});
test.each([{ version: 'v1' }, { model: 'claude-latest' }, { tools: ['check'] }, { tools: ['submit', 'other'] },
  { maxMeasurements: 0 }, { maxSubmissions: 1.5 }, { maxMeasurements: Infinity }])('不正な生成条件を拒否する: %j', (change) => {
  expect(() => validateConditions({ ...loadConditions('v0'), ...change }, 'v0')).toThrow();
});
test('フォルダ外の版を拒否する', () => { expect(() => loadConditions('../v0')).toThrow(); });
