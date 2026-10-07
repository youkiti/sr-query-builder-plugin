import { originalRequiredParts, stripDateRange } from './originalParts';

test.each([
  ['(alpha AND beta) AND (2020[edat])', 'alpha AND beta'],
  ['(((alpha AND beta) AND (2020[Date - Entry])))', 'alpha AND beta'],
  ['alpha AND 2020[EDAT]', 'alpha'],
  ['alpha AND beta', null],
  ['alpha AND beta AND 2020[edat]', null],
  ['(alpha AND 2020[edat]', null],
])('日付条件を最上位の右項から外す: %s', (query, expected) => {
  expect(stripDateRange(query)).toBe(expected);
});

test('必須の部分と否定・フィルタを区別する', () => {
  expect(originalRequiredParts('((alpha[Mesh] AND beta[tiab] AND trial[pt] NOT animals[Mesh]))')).toEqual({
    determined: true, parts: [
      { expression: 'alpha[Mesh]', negative: false, kind: 'concept' },
      { expression: 'beta[tiab]', negative: false, kind: 'concept' },
      { expression: 'trial[pt]', negative: false, kind: 'filter' },
      { expression: 'animals[Mesh]', negative: true, kind: 'filter' },
    ],
  });
});
test.each(['alpha OR beta', 'alpha AND beta OR gamma', 'alpha', '"alpha AND beta"'])('OR と単独の式は一単位: %s', (expression) => {
  expect(originalRequiredParts(expression)).toEqual({ determined: true, parts: [{ expression, negative: false, kind: 'concept' }] });
});
test.each(['(alpha', 'alpha)', '"alpha', '', 'alpha AND'])('壊れた式は分解できない: %s', (expression) => {
  expect(originalRequiredParts(expression)).toEqual({ determined: false, parts: [] });
});
