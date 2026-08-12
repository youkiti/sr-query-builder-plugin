import {
  classifyFieldTag,
  extractMeshTerm,
  normalizeOperand,
  tokenizeExpression,
  tokenizeOperands,
} from './formulaDisplay';

describe('classifyFieldTag', () => {
  test('MeSH 系タグは mesh', () => {
    for (const tag of ['Mesh', 'mesh', 'mh', 'Majr', 'MeSH Terms', 'sh']) {
      expect(classifyFieldTag(tag)).toBe('mesh');
    }
  });

  test('フリーワード系タグは freeword', () => {
    for (const tag of ['tiab', 'tw', 'ti', 'ab', 'Title/Abstract']) {
      expect(classifyFieldTag(tag)).toBe('freeword');
    }
  });

  test(':noexp サフィックスは無視して分類する', () => {
    expect(classifyFieldTag('Mesh:noexp')).toBe('mesh');
    expect(classifyFieldTag('mh:noexp')).toBe('mesh');
  });

  test('フィルタ系など判定できないタグは plain', () => {
    for (const tag of ['pt', 'la', 'dp']) {
      expect(classifyFieldTag(tag)).toBe('plain');
    }
  });
});

describe('tokenizeExpression', () => {
  test('単一の MeSH 語をタグ込みで切り出す', () => {
    expect(tokenizeExpression('Pneumonia[Mesh]')).toEqual([
      { text: 'Pneumonia[Mesh]', kind: 'mesh' },
    ]);
  });

  test('空白を含む語（クォートなし）も語全体を 1 セグメントにする', () => {
    expect(tokenizeExpression('Community-Acquired Pneumonia[Mesh]')).toEqual([
      { text: 'Community-Acquired Pneumonia[Mesh]', kind: 'mesh' },
    ]);
  });

  test('OR 演算子は plain として残り、両側の語が色分けされる', () => {
    expect(tokenizeExpression('a[Mesh] OR "b"[tiab]')).toEqual([
      { text: 'a[Mesh]', kind: 'mesh' },
      { text: ' OR ', kind: 'plain' },
      { text: '"b"[tiab]', kind: 'freeword' },
    ]);
  });

  test('括弧は plain として残る', () => {
    expect(tokenizeExpression('(a[Mesh] OR b[tiab])')).toEqual([
      { text: '(', kind: 'plain' },
      { text: 'a[Mesh]', kind: 'mesh' },
      { text: ' OR ', kind: 'plain' },
      { text: 'b[tiab]', kind: 'freeword' },
      { text: ')', kind: 'plain' },
    ]);
  });

  test('タグの無い結合行は全体が plain', () => {
    expect(tokenizeExpression('#1 AND #2')).toEqual([{ text: '#1 AND #2', kind: 'plain' }]);
  });

  test('フィルタ系タグの語は plain 扱い', () => {
    expect(tokenizeExpression('Randomized Controlled Trial[pt]')).toEqual([
      { text: 'Randomized Controlled Trial[pt]', kind: 'plain' },
    ]);
  });

  test('結合された全テキストは入力と一致する（情報欠落なし）', () => {
    const expr = '(Community-Acquired Pneumonia[Mesh] OR "CAP"[tiab]) AND Glucocorticoids[Mesh]';
    expect(tokenizeExpression(expr).map((s) => s.text).join('')).toBe(expr);
  });
});

describe('extractMeshTerm', () => {
  test('末尾タグ・前後クォート・末尾ワイルドカードを落とす', () => {
    expect(extractMeshTerm('"Heart Failure"[Mesh]')).toBe('Heart Failure');
    expect(extractMeshTerm('Asthma[mh]')).toBe('Asthma');
    expect(extractMeshTerm('"Diabetes"[Majr]')).toBe('Diabetes');
    expect(extractMeshTerm('Neoplasm*[Mesh]')).toBe('Neoplasm');
  });
});

describe('tokenizeOperands', () => {
  test('外側括弧を glue に寄せ、OR で句に割る', () => {
    expect(tokenizeOperands('(a[tiab] OR b[tiab])')).toEqual([
      { text: '(', isOperand: false },
      { text: 'a[tiab]', isOperand: true },
      { text: ' OR ', isOperand: false },
      { text: 'b[tiab]', isOperand: true },
      { text: ')', isOperand: false },
    ]);
  });

  test('ネストした群は 1 つの句として保つ（最上位だけで割る）', () => {
    const tokens = tokenizeOperands('(x[tiab] OR y[tiab]) AND z[tiab]');
    expect(tokens.filter((t) => t.isOperand).map((t) => t.text)).toEqual([
      '(x[tiab] OR y[tiab])',
      'z[tiab]',
    ]);
  });

  test('引用符内の or は演算子として割らない', () => {
    const tokens = tokenizeOperands('"heart or lung"[tiab] OR x[tiab]');
    expect(tokens.filter((t) => t.isOperand).map((t) => t.text)).toEqual([
      '"heart or lung"[tiab]',
      'x[tiab]',
    ]);
  });

  test('空式は空配列', () => {
    expect(tokenizeOperands('')).toEqual([]);
    expect(tokenizeOperands('   ')).toEqual([]);
  });
});

describe('normalizeOperand', () => {
  test('連続空白を 1 つに畳み、前後の空白と大小を無視する', () => {
    expect(normalizeOperand('  Heart   Failure[tiab] ')).toBe('heart failure[tiab]');
  });
});
