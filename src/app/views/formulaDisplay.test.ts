import {
  MESH_BROWSER_BASE,
  classifyFieldTag,
  deriveKeywordQueries,
  diffExpressions,
  extractMeshTerm,
  renderDiffSideInto,
  renderExpressionInto,
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
});

describe('diffExpressions', () => {
  test('削除された語・追加された語を句単位で検出する', () => {
    const before = '(a[tiab] OR b[tiab] OR c[tiab])';
    const after = '(a[tiab] OR b[tiab] OR d[tiab])';
    const diff = diffExpressions(before, after);
    expect(diff.removed).toEqual(['c[tiab]']);
    expect(diff.added).toEqual(['d[tiab]']);
    // before 側の各句に status が付く
    const beforeStatuses = diff.beforeTokens
      .filter((t) => t.isOperand)
      .map((t) => `${t.text}:${t.status}`);
    expect(beforeStatuses).toEqual(['a[tiab]:same', 'b[tiab]:same', 'c[tiab]:removed']);
    const afterStatuses = diff.afterTokens
      .filter((t) => t.isOperand)
      .map((t) => `${t.text}:${t.status}`);
    expect(afterStatuses).toEqual(['a[tiab]:same', 'b[tiab]:same', 'd[tiab]:added']);
  });

  test('語順・大文字小文字・空白だけの違いは増減 0 とみなす', () => {
    const before = '(a[tiab] OR B[Tiab])';
    const after = '(b[tiab]  OR  a[tiab])';
    const diff = diffExpressions(before, after);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
  });

  test('スクリーンショットの外科医ブロック例: 4 語削除・0 語追加', () => {
    const before =
      '(Surgeons[Mesh] OR surgeon*[tiab] OR surgical resident*[tiab] OR surgical trainee*[tiab] OR surgical fellow*[tiab] OR surgical registrar*[tiab] OR general surgeon*[tiab] OR surgical specialist*[tiab] OR neurosurgeon*[tiab] OR orthopedic surgeon*[tiab] OR orthopaedic surgeon*[tiab])';
    const after =
      '(Surgeons[Mesh] OR surgeon*[tiab] OR surgical resident*[tiab] OR surgical trainee*[tiab] OR surgical fellow*[tiab] OR surgical registrar*[tiab] OR surgical specialist*[tiab])';
    const diff = diffExpressions(before, after);
    expect(diff.removed).toEqual([
      'general surgeon*[tiab]',
      'neurosurgeon*[tiab]',
      'orthopedic surgeon*[tiab]',
      'orthopaedic surgeon*[tiab]',
    ]);
    expect(diff.added).toEqual([]);
  });
});

describe('deriveKeywordQueries', () => {
  test('MeSH は explode/noexp で単体クエリを作り、フリーワードはタグ込みのまま', () => {
    const expr = '("Asthma"[Mesh] OR "Lung"[Mesh:NoExp] OR wheeze[tiab] OR "cough"[tiab])';
    expect(deriveKeywordQueries(expr)).toEqual([
      { display: 'Asthma', query: '"Asthma"[Mesh]', kind: 'mesh' },
      { display: 'Lung', query: '"Lung"[Mesh:NoExp]', kind: 'mesh' },
      { display: 'wheeze[tiab]', query: 'wheeze[tiab]', kind: 'freeword' },
      { display: '"cough"[tiab]', query: '"cough"[tiab]', kind: 'freeword' },
    ]);
  });

  test('同一語の重複は 1 つにまとめる', () => {
    const expr = '(asthma[tiab] OR asthma[tiab])';
    expect(deriveKeywordQueries(expr)).toEqual([
      { display: 'asthma[tiab]', query: 'asthma[tiab]', kind: 'freeword' },
    ]);
  });

  test('タグ無し結合行はキーワード 0', () => {
    expect(deriveKeywordQueries('#1 AND #2')).toEqual([]);
  });
});

describe('renderDiffSideInto', () => {
  function renderSide(before: string, after: string, side: 'before' | 'after'): HTMLElement {
    const doc = document.implementation.createHTMLDocument('t');
    const parent = doc.createElement('pre');
    const diff = diffExpressions(before, after);
    renderDiffSideInto(parent, side === 'before' ? diff.beforeTokens : diff.afterTokens);
    return parent;
  }

  test('削除句は <del>、追加句は <ins>、全文テキストは元式と一致する', () => {
    const before = '(a[tiab] OR c[tiab])';
    const after = '(a[tiab] OR d[tiab])';
    const beforeEl = renderSide(before, after, 'before');
    expect(beforeEl.querySelector('del.formula-diff__term--removed')?.textContent).toBe('c[tiab]');
    expect(beforeEl.textContent).toBe(before);

    const afterEl = renderSide(before, after, 'after');
    expect(afterEl.querySelector('ins.formula-diff__term--added')?.textContent).toBe('d[tiab]');
    expect(afterEl.textContent).toBe(after);
  });

  test('MeSH 句はリンクを保ったまま差分要素で包まれる', () => {
    const beforeEl = renderSide('("Asthma"[Mesh] OR x[tiab])', '(x[tiab])', 'before');
    const removed = beforeEl.querySelector('del.formula-diff__term--removed')!;
    expect(removed.querySelector('a.draft__term--mesh')?.textContent).toBe('"Asthma"[Mesh]');
  });
});
