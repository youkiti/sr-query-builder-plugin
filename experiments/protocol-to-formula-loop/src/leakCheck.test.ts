/** @jest-environment node */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateTerms, findLeaks, main, procedureBody } from './leakCheck';
import { review, writeJson, writeLines } from './testFixtures';
import type { Split } from './split';

test('題にだけ現れる固有語を検出し、本文だけの語と日本語を除く', () => {
  expect(findLeaks('Rareword bodyword 日本語', [{ split: 'development', title: '合成の題 Rareword', protocol: 'bodyword' }], new Set()))
    .toEqual([{ term: 'rareword', kind: 'word', reviews: { development: 1, validation: 0, test: 0 } }]);
});

test('本文の出現はレビュー単位で数え、5%以下は含め、超える一般語は除く', () => {
  const reviews = Array.from({ length: 20 }, (_, i) => ({ split: (i === 0 ? 'validation' : 'development') as Split,
    title: 'Rareword Commonword', protocol: i === 0 ? 'rareword rareword commonword' : i === 1 ? 'commonword' : '' }));
  expect(findLeaks('rareword commonword', reviews, new Set())).toEqual([
    { term: 'rareword', kind: 'word', reviews: { development: 19, validation: 1, test: 0 } },
  ]);
  expect(findLeaks('rareword', reviews.slice(0, 19), new Set())).toEqual([]);
});

test('許可語は大文字小文字を区別せず除外する', () => {
  expect(findLeaks('Rareword', [{ split: 'test', title: 'Rareword', protocol: '' }], new Set(['RAREWORD']))).toEqual([]);
});

test('識別子の形はレビューとの一致や許可語に関係なく必ず検出する', () => {
  const terms = ['1234567', '12345678', 'PMC0000001', 'CD000001'];
  const leaks = findLeaks(terms.join(' '), [], new Set(terms));
  expect(leaks.map((leak) => leak.term)).toEqual(terms.map((term) => term.toLowerCase()).sort());
  expect(leaks.every((leak) => leak.kind === 'identifier')).toBe(true);
  expect(findLeaks('123456 123456789 CD00001 PMC', [], new Set())).toEqual([]);
});

test('四文字以上の英字を含む語を小文字化し、数字やハイフンを保つ', () => {
  expect([...candidateTerms('Alpha-2 ALPHA-2 ab-cd abc 12abcd34 日本語 abcd 日本')])
    .toEqual(['alpha-2', 'ab-cd', '12abcd34', 'abcd']);
});

test('単独の区切り行より前だけを除外し、本文中の次の区切り以降も検査する', () => {
  expect(procedureBody('commentword\r\n---\r\nbodyword\r\n---\r\nlastword')).toBe('bodyword\n---\nlastword');
  expect(() => procedureBody('区切りなし')).toThrow('区切り');
});

function setup(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-leak-'));
  const runtime = { casesDir: join(root, 'cases'), harnessDir: join(root, 'harness'), stdout: jest.fn() };
  const pmcid = review().pmcid;
  writeLines(join(runtime.casesDir, 'index.jsonl'), [{ pmcid, split: 'development', title: '合成の秘密の題 Rareword Commentword' }]);
  writeJson(join(runtime.casesDir, pmcid, 'protocol.md'), '合成の本文');
  writeJson(join(runtime.harnessDir, 'v0', 'procedure.md'), '');
  writeFileSync(join(runtime.harnessDir, 'v0', 'procedure.md'), `Commentword ${pmcid}\n---\n${body}`);
  writeFileSync(join(runtime.harnessDir, 'leak-allowlist.txt'), '# 合成のコメント\nAllowedword\n');
  return { runtime, pmcid };
}

test.each([{ body: 'ordinaryword', code: 0, count: 0 }, { body: 'Rareword rareword', code: 1, count: 1 }])(
  '検出数$countの終了コードは$codeで、コメントと題とレビューIDを出さない', ({ body, code, count }) => {
    const s = setup(body);
    expect(main(['--version', 'v0'], s.runtime)).toBe(code);
    const output = s.runtime.stdout.mock.calls.map((call) => call[0]).join('');
    expect(output).toContain(`検査した候補語: 1 件、固有の語: ${count} 件`);
    expect(output).not.toMatch(/合成の秘密の題|commentword/i);
    expect(output).not.toContain(s.pmcid);
    if (count) expect(output).toContain('rareword (word): development=1, validation=0, test=0');
  });

test('必要ファイルが欠けていたら識別子や題を含めず拒否する', () => {
  const s = setup('ordinaryword');
  writeLines(join(s.runtime.casesDir, 'index.jsonl'), [{ pmcid: review(2).pmcid, split: 'test', title: '合成の秘密の題' }]);
  expect(() => main(['--version', 'v0'], s.runtime)).toThrow('プロトコルを読めません');
  expect(() => main(['--version', '../v0'], s.runtime)).toThrow('有効な版');
});

test('許可語ファイルの語を読み、コメント行は許可語にしない', () => {
  const s = setup('Allowedword Rareword');
  writeLines(join(s.runtime.casesDir, 'index.jsonl'), [{ pmcid: s.pmcid, split: 'test', title: 'Allowedword Rareword' }]);
  writeFileSync(join(s.runtime.harnessDir, 'leak-allowlist.txt'), '# Rareword\nAllowedword\n');
  expect(main(['--version', 'v0'], s.runtime)).toBe(1);
  const output = s.runtime.stdout.mock.calls.map((call) => call[0]).join('');
  expect(output).toContain('固有の語: 1 件');
  expect(output).toContain('rareword (word): development=0, validation=0, test=1');
  expect(output).not.toContain('allowedword');
});
