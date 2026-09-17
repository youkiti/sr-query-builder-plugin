import { hasPrecedenceMixing } from './precedenceMixing';

test.each([
  'a[tiab] OR b[tiab] OR c[tiab]',
  'a[tiab] AND b[tiab]',
  '(a[tiab] OR b[tiab]) AND c[tiab]',
  'a[tiab] OR (b[tiab] AND c[tiab])',
  '(a[tiab] OR b[tiab]) NOT c[tiab]',
  '(a[tiab] OR (b[tiab] AND c[tiab]))',
  // 引用符内の AND は語の一部であり、実際のブール演算子は OR だけなので混在ではない
  '"salt and pepper"[tiab] OR "black pepper"[tiab] OR "chili pepper"[tiab]',
  // 近接タグの語も 1 語として扱われ、括弧で階層が分かれていれば混在にならない
  '(a[tiab:~2] OR b[tiab:~2]) AND c[tiab]',
  // MeSH（複数語の引用符付き）と出版種別タグ [pt] も語として扱われる
  '("Heart Failure"[Mesh] OR "Cardiac Failure"[Mesh]) AND randomized controlled trial[pt]',
  // 同じ深さでも別々の括弧グループなら混在ではない（issue #202 の codex レビュー指摘）
  '(a[tiab] OR b[tiab]) AND (c[tiab] AND d[tiab])',
  '(a[tiab] AND b[tiab]) OR (c[tiab] OR d[tiab])',
  '((a[tiab] OR b[tiab]) AND c[tiab]) OR d[tiab]',
])('括弧グループが分かれている・演算子が混在しない式は混在と判定しない: %s', (expression) => {
  expect(hasPrecedenceMixing(expression)).toBe(false);
});

test.each([
  '(a[tiab] OR b[tiab] AND c[tiab])',
  'a[tiab] AND b[tiab] OR c[tiab]',
  'a[tiab] OR b[tiab] NOT c[tiab]',
  '("Sodium Chloride, Dietary"[Mesh] OR "salt substitute*"[tiab] OR "NaCl"[tiab] AND "chitosan"[tiab] OR "Symbiosal"[tiab])',
  // 近接タグ・出版種別タグの語でも、括弧が無ければ同様に検出する
  'a[tiab:~2] OR b[tiab:~2] AND c[tiab]',
  '"Heart Failure"[Mesh] OR "Cardiac Failure"[Mesh] AND randomized controlled trial[pt]',
  // 片方の括弧グループの中だけで混在していれば、他のグループが健全でも検出する
  '(a[tiab] OR b[tiab]) AND (c[tiab] OR d[tiab] AND e[tiab])',
  '((a[tiab] OR b[tiab]) AND c[tiab] OR d[tiab])',
])('括弧の無い AND/NOT と OR が同じ括弧グループに混在する式を検出する: %s', (expression) => {
  expect(hasPrecedenceMixing(expression)).toBe(true);
});

test('括弧で混在部分を囲むと検出しなくなる（実例の修正形）', () => {
  expect(hasPrecedenceMixing(
    '("Sodium Chloride, Dietary"[Mesh] OR "salt substitute*"[tiab] OR ("NaCl"[tiab] AND "chitosan"[tiab]) OR "Symbiosal"[tiab])'
  )).toBe(false);
});

test('構文が壊れている式は判定不能として false を返す', () => {
  expect(hasPrecedenceMixing('a[tiab] OR OR b[tiab]')).toBe(false);
  expect(hasPrecedenceMixing('(a[tiab] OR b[tiab]')).toBe(false);
});

test('閉じ括弧が多い式は例外にせず判定不能として false を返す（初期式の診断は構文検査を経ない）', () => {
  expect(hasPrecedenceMixing('a[tiab]) OR b[tiab] AND c[tiab]')).toBe(false);
  expect(hasPrecedenceMixing('(a[tiab] OR b[tiab])) AND c[tiab] OR d[tiab]')).toBe(false);
});
