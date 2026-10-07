import { relaxationLadder, relaxTags } from './relaxQuery';

test.each([
  ['[majr]', '[Mesh]'], ['[Mesh:Majr]', '[Mesh]'], ['[MeSH Major Topic]', '[Mesh]'],
  ['[majr:noexp]', '[Mesh:NoExp]'], ['[Mesh:Majr:NoExp]', '[Mesh:NoExp]'],
])('主要見出しの限定を大文字小文字によらず外す（%s）', (tag, expected) => {
  for (const variant of [tag, tag.toUpperCase(), tag.toLowerCase()]) {
    for (const level of [1, 2] as const) expect(relaxTags(`a${variant}`, level)).toBe(`a${expected}`);
  }
});

test.each([['[ti]', '[tiab]'], ['[Title]', '[tiab]'], ['[ti:~3]', '[tiab:~3]'], ['[Title:~12]', '[tiab:~12]']])(
  '題の限定は段２だけで変える（%s）', (tag, expected) => {
    for (const variant of [tag, tag.toUpperCase(), tag.toLowerCase()]) {
      expect(relaxTags(`a${variant}`, 1)).toBe(`a${variant}`);
      expect(relaxTags(`a${variant}`, 2)).toBe(`a${expected}`);
    }
  },
);

test('引用符の中と他のタグ・タグなしの語は保つ', () => {
  const text = '"a[majr] b[ti]"[Title] c[pt] d[Mesh] e f[tiab] "未完[majr]';
  expect(relaxTags(text, 2)).toBe(text.replace('[Title]', '[tiab]'));
});

test('全体の括弧を外して出版タイプを除き、１部分ずつ外した AND を OR に束ねる', () => {
  const query = '(a[majr] AND b[ti] AND c[ti] AND (trial[pt] OR review[Publication Type]))';
  expect(relaxationLadder(query)).toEqual([
    '(a[Mesh] AND b[ti] AND c[ti] AND (trial[pt] OR review[Publication Type]))',
    '(a[Mesh] AND b[tiab] AND c[tiab] AND (trial[pt] OR review[Publication Type]))',
    '(a[Mesh]) AND (b[tiab]) AND (c[tiab])',
    '((b[tiab]) AND (c[tiab])) OR ((a[Mesh]) AND (c[tiab])) OR ((a[Mesh]) AND (b[tiab]))',
  ]);
});

test('出版タイプが無ければ段３を省き、２部分以下なら段４を省く', () => {
  expect(relaxationLadder('a[majr] AND b[ti] AND c')).toHaveLength(3);
  expect(relaxationLadder('a[majr] AND b[ti]')).toEqual(['a[Mesh] AND b[ti]', 'a[Mesh] AND b[tiab]']);
  expect(relaxationLadder('a[ti] AND trial[pt]')).toEqual(['a[tiab] AND trial[pt]', '(a[tiab])']);
  expect(relaxationLadder('a[pt] AND b[Publication Type]')).toEqual([]);
});

test.each(['a[majr] OR b[ti] AND c', 'a[majr] NOT b[ti] AND c', '(a[majr] AND b[ti] AND c', 'a[majr] AND b[ti])']) (
  '最上位の混在や壊れた括弧ではタグだけ変える（%s）', (query) => {
    expect(relaxationLadder(query)).toEqual([relaxTags(query, 1), relaxTags(query, 2)]);
  },
);

test('変化のない段を省き、引用符内のタグや混合タグを出版タイプと扱わない', () => {
  expect(relaxationLadder('a[tiab]')).toEqual([]);
  expect(relaxationLadder('a[ti]')).toEqual(['a[tiab]']);
  expect(relaxationLadder('a AND "b[pt]"')).toEqual([]);
  expect(relaxationLadder('a AND (b[pt] OR c[tiab])')).toEqual([]);
});
