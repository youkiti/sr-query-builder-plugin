/** @jest-environment node */
import { classifyLine, requiredUnits } from './formulaUnits';
import { validateFormulaMd } from './submission';

const md = (body: string) => `## PubMed\n\n\`\`\`\n${body}\n\`\`\`\n`;
function decompose(body: string) {
  const result = validateFormulaMd(md(body));
  if (!result.ok) throw new Error('合成式が不正です');
  return requiredUnits(result.formula);
}

test('括弧内の選択肢は一単位とし、入れ子の結合行とインライン式を分解する', () => {
  const base = '#1 alpha[tiab]\n#2 beta[tiab]\n#3 gamma[tiab]';
  expect(decompose(base + '\n#4 (#1 OR #2) AND #3')).toEqual({
    units: [{ id: 'inline-1', expression: '(alpha[tiab]) OR (beta[tiab])', negative: false },
      { id: '3', expression: 'gamma[tiab]', negative: false }], unusedLines: 0, undetermined: false,
  });
  expect(decompose(base + '\n#4 (#1 AND #2)\n#5 #4 AND #3').units.map((unit) => unit.id)).toEqual(['1', '2', '3']);
  expect(decompose(base + '\n#4 #1 AND "OR (NOT)"[tiab] AND (#2 OR extra[tiab])').units).toEqual([
    { id: '1', expression: 'alpha[tiab]', negative: false },
    { id: 'inline-1', expression: '"OR (NOT)"[tiab]', negative: false },
    { id: 'inline-2', expression: '(beta[tiab]) OR extra[tiab]', negative: false },
  ]);
});

test('起点は最後の結合行、結合行がなければ最後の行にする', () => {
  expect(decompose('#1 alpha[tiab]\n#2 beta[tiab]').units[0]!.expression).toBe('beta[tiab]');
  expect(decompose('#1 alpha[tiab]\n#2 #1 AND beta[tiab]\n#3 unused[tiab]').unusedLines).toBe(1);
});

test('最上位の選択肢、深さ超過、演算子の間の空項は分解不能にする', () => {
  for (const expression of ['#1 OR #2', '(#1 OR #2)', '#1 AND AND #2']) {
    expect(decompose('#1 alpha[tiab]\n#2 beta[tiab]\n#3 ' + expression)).toMatchObject({ units: [], undetermined: true });
  }
  const body = ['#1 alpha[tiab]', ...Array.from({ length: 22 }, (_, i) => '#' + (i + 2) + ' #' + (i + 1))].join('\n');
  expect(decompose(body)).toMatchObject({ units: [], undetermined: true });
});

test('複合式の否定は分割せず、参照を展開して一つの除外集合にする', () => {
  expect(decompose('#1 alpha[tiab]\n#2 beta[tiab]\n#3 #1 NOT (#1 AND #2)').units[1]).toEqual({
    id: 'inline-1', expression: '((alpha[tiab]) AND (beta[tiab]))', negative: true,
  });
});

test('単位の中身で種類を決める', () => {
  const block = (id: string, expression: string, isCombination = false) => ({ id, expression, isCombination });
  expect(classifyLine(block('1', 'a[tiab]'))).toBe('concept');
  expect(classifyLine(block('RCTfilter', 'a[tiab]'))).toBe('concept');
  expect(classifyLine(block('2', 'Randomized Controlled Trial[pt]'))).toBe('filter');
  expect(classifyLine(block('Design', 'randomized controlled trials[mh]'))).toBe('concept');
  for (const tag of ['pt', 'Publication Type', 'sh', 'Subheading', 'dp', 'Date - Publication', 'edat', 'crdt', 'pdat', 'la', 'Language']) {
    expect(classifyLine(block('1', '"synthetic"[' + tag.toUpperCase() + ']'))).toBe('filter');
  }
  expect(classifyLine(block('1', 'a[tiab]'), true)).toBe('filter');
});

