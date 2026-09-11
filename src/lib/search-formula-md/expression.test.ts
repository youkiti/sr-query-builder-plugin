/** @jest-environment node */
import {
  classifyFieldTag, deriveKeywordQueries, diffExpressions, extractMeshTerm,
  normalizeOperand, tokenizeExpression, tokenizeOperands,
} from './expression';

test('DOM のない環境で分類・語分解・差分を利用できる', () => {
  expect(classifyFieldTag('mh:noexp')).toBe('mesh');
  expect(extractMeshTerm('"A"[Mesh]')).toBe('A');
  expect(tokenizeExpression('"A"[Mesh] OR a[tiab]').map((s) => s.kind)).toEqual(['mesh', 'plain', 'freeword']);
  expect(tokenizeOperands('a[tiab] OR b[tiab]').filter((t) => t.isOperand)).toHaveLength(2);
  expect(normalizeOperand(' A[tiab] ')).toBe('a[tiab]');
  expect(diffExpressions('a[tiab]', 'b[tiab]')).toMatchObject({ removed: ['a[tiab]'], added: ['b[tiab]'] });
  expect(deriveKeywordQueries('"A"[Mesh:NoExp] OR a[tiab]')).toEqual([
    { display: 'A', query: '"A"[Mesh:NoExp]', kind: 'mesh' },
    { display: 'a[tiab]', query: 'a[tiab]', kind: 'freeword' },
  ]);
});
