import {
  MESH_BROWSER_BASE,
  classifyFieldTag,
  extractMeshTerm,
  renderExpressionInto,
  tokenizeExpression,
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

describe('renderExpressionInto', () => {
  function render(expr: string): HTMLElement {
    const doc = document.implementation.createHTMLDocument('t');
    const parent = doc.createElement('div');
    renderExpressionInto(parent, expr);
    return parent;
  }

  test('MeSH 語はリンク（別タブ）になり、MeSH ブラウザ URL を指す', () => {
    const parent = render('"Heart Failure"[Mesh] OR hf[tiab]');
    const link = parent.querySelector<HTMLAnchorElement>('a.draft__term--mesh')!;
    expect(link.textContent).toBe('"Heart Failure"[Mesh]');
    expect(link.getAttribute('href')).toBe(`${MESH_BROWSER_BASE}${encodeURIComponent('Heart Failure')}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('フリーワードは span、演算子は地のまま、全文は欠落しない', () => {
    const expr = '"Heart Failure"[Mesh] OR hf[tiab]';
    const parent = render(expr);
    expect(parent.querySelector('span.draft__term--freeword')?.textContent).toBe('hf[tiab]');
    expect(parent.textContent).toBe(expr);
  });
});
