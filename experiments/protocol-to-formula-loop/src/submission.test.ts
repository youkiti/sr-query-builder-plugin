/** @jest-environment node */
import { validateFormulaMd } from './submission';
import { hasPrecedenceMixing } from '../../../src/features/validation/precedenceMixing';
const md = (body: string) => '## PubMed/MEDLINE\n```\n' + body + '\n```\n';

test('結合行を展開し、引用符内の括弧を無視する', () => {
  expect(validateFormulaMd(md('#1 "a("[tiab]\n#2 b[tiab]\n#3 #1 AND #2'))).toMatchObject({ ok: true, query: '("a("[tiab]) AND (b[tiab])' });
});
test.each(['不正', md(''), md('#1 a[tiab])'), md('#1 "a[tiab]'), md('#1 #9'), md('#1 #2\n#2 #1')])('構文・空・引用符・括弧・未定義・循環を拒否する: %s', (text) => {
  expect(validateFormulaMd(text).ok).toBe(false);
});
test('到達しない行も検査し、複数の理由を返す', () => {
  const result = validateFormulaMd(md('#1 "a\n#2 b)\n#3 #9\n#4 c[tiab]'));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reasons.join('\n')).toMatch(/引用符[\s\S]*括弧[\s\S]*未定義/);
});
test('既存の混在検出はタグのない自由語を扱えないため一般の行検査に流用しない', () => {
  expect(hasPrecedenceMixing('a OR b AND c')).toBe(false);
  expect(hasPrecedenceMixing('a[tiab] OR b[tiab] AND c[tiab]')).toBe(true);
});
