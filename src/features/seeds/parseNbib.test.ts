import { parseNbib } from './parseNbib';

describe('parseNbib', () => {
  const sample = [
    'PMID- 12345678',
    'OWN - NLM',
    'TI  - Effect of A on B',
    '      continuation of title',
    'DP  - 2020 Jan',
    'AB  - Abstract.',
    '',
    'PMID- 23456789',
    'TI  - Another study',
    'DP  - 2019',
    '',
  ].join('\n');

  test('2 レコードをパースできる', () => {
    const entries = parseNbib(sample);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      pmid: '12345678',
      title: 'Effect of A on B continuation of title',
      year: 2020,
      tags: expect.any(Object),
    });
    expect(entries[1]?.pmid).toBe('23456789');
  });

  test('タグへのアクセスが可能', () => {
    const entries = parseNbib(sample);
    expect(entries[0]?.tags['OWN']).toEqual(['NLM']);
    expect(entries[0]?.tags['AB']).toEqual(['Abstract.']);
  });

  test('PMID が欠けていても他フィールドは取れる', () => {
    const text = 'TI  - Only title\nDP  - 2021\n';
    const entries = parseNbib(text);
    expect(entries[0]).toEqual({
      pmid: null,
      title: 'Only title',
      year: 2021,
      tags: expect.any(Object),
    });
  });

  test('年が数値にできない場合 null', () => {
    const text = 'PMID- 1\nDP  - unknown\n';
    expect(parseNbib(text)[0]?.year).toBeNull();
  });

  test('空テキストは [] を返す', () => {
    expect(parseNbib('')).toEqual([]);
  });

  test('空行のみの連続は 1 つのレコード区切り扱い', () => {
    const text = 'PMID- 1\nTI  - A\n\n\nPMID- 2\nTI  - B\n';
    expect(parseNbib(text)).toHaveLength(2);
  });

  test('継続行が先頭のケース（lastTag が未設定）は無視する', () => {
    const text = '    orphan line\nPMID- 9\n';
    const entries = parseNbib(text);
    expect(entries[0]?.pmid).toBe('9');
  });

  test('PDAT タグからも年を取得できる', () => {
    const text = 'PMID- 1\nPDAT - 2018\n';
    expect(parseNbib(text)[0]?.year).toBe(2018);
  });

  test('\\r\\n 改行も扱える', () => {
    const text = 'PMID- 1\r\nTI  - X\r\n';
    expect(parseNbib(text)[0]?.title).toBe('X');
  });

  test('末尾に改行が無くても最後のレコードが拾われる', () => {
    const text = 'PMID- 1\nTI  - X';
    expect(parseNbib(text)).toHaveLength(1);
  });

  test('タグ行が無い（継続行のみ）レコードは null 扱いで除外', () => {
    const text = '    orphan\n    another\n';
    expect(parseNbib(text)).toEqual([]);
  });
});
