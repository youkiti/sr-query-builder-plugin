import { parseRis } from './parseRis';

describe('parseRis', () => {
  const sample = [
    'TY  - JOUR',
    'DB  - PubMed',
    'T1  - Title A',
    'PY  - 2020',
    'DO  - 10.1111/aaa',
    'AN  - 12345678',
    'ER  - ',
    '',
    'TY  - JOUR',
    'DB  - Embase',
    'TI  - Title B',
    'Y1  - 2019/03/15',
    'DO  - 10.2222/bbb',
    'ER  - ',
    '',
  ].join('\n');

  test('2 レコードをパースし、title / year / DB / DOI を取れる', () => {
    const entries = parseRis(sample);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      tags: expect.any(Object),
      rawText: expect.stringContaining('TY  - JOUR'),
      title: 'Title A',
      year: 2020,
      originalDb: 'PubMed',
      doi: '10.1111/aaa',
    });
    expect(entries[1]).toEqual({
      tags: expect.any(Object),
      rawText: expect.stringContaining('DB  - Embase'),
      title: 'Title B',
      year: 2019,
      originalDb: 'Embase',
      doi: '10.2222/bbb',
    });
  });

  test('AN タグも tags に含まれる', () => {
    const entries = parseRis(sample);
    expect(entries[0]?.tags['AN']).toEqual(['12345678']);
  });

  test('T1 が無ければ TI を使う（逆も同様）', () => {
    const text = 'TY  - JOUR\nTI  - OnlyTI\nER  - \n';
    expect(parseRis(text)[0]?.title).toBe('OnlyTI');
  });

  test('TI / T1 が無ければ null', () => {
    const text = 'TY  - JOUR\nER  - \n';
    expect(parseRis(text)[0]?.title).toBeNull();
  });

  test('PY が無ければ Y1 を使い、無ければ null', () => {
    const text1 = 'TY  - JOUR\nY1  - 2022\nER  - \n';
    const text2 = 'TY  - JOUR\nER  - \n';
    expect(parseRis(text1)[0]?.year).toBe(2022);
    expect(parseRis(text2)[0]?.year).toBeNull();
  });

  test('year が数字化できない値でも null', () => {
    const text = 'TY  - JOUR\nPY  - forthcoming\nER  - \n';
    expect(parseRis(text)[0]?.year).toBeNull();
  });

  test('ER が無くても EOF でレコード確定する', () => {
    const text = 'TY  - JOUR\nTI  - Only\n';
    expect(parseRis(text)).toHaveLength(1);
  });

  test('BOM 付きでも読める', () => {
    const text = '\ufeffTY  - JOUR\nTI  - X\nER  - \n';
    expect(parseRis(text)[0]?.title).toBe('X');
    expect(parseRis(text)[0]?.rawText.startsWith('TY  - JOUR')).toBe(true);
  });

  test('TY が無い開始でも先頭を 1 レコードとして扱う', () => {
    const text = 'TI  - X\nPY  - 2020\nER  - \n';
    expect(parseRis(text)).toHaveLength(1);
  });

  test('2 レコードが ER 抜きで連続していても TY で分ける', () => {
    const text = 'TY  - JOUR\nTI  - A\nTY  - JOUR\nTI  - B\n';
    expect(parseRis(text).map((e) => e.title)).toEqual(['A', 'B']);
  });

  test('空行と不正行は無視する', () => {
    const text = '\nnot-a-tag\nTY  - JOUR\nTI  - X\nER  - \n';
    expect(parseRis(text)[0]?.title).toBe('X');
  });
});
