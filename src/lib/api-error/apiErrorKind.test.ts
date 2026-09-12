import { GoogleApiError } from '@/lib/google';
import { LlmProviderError } from '@/lib/llm';
import { EutilsError } from '@/lib/ncbi';
import { classifyApiError } from './apiErrorKind';

function google(status: number): GoogleApiError {
  return new GoogleApiError(`Google API failed: HTTP ${status}`, status, '/v4/spreadsheets', '');
}

describe('classifyApiError', () => {
  test.each([403, 404])('Google の %i は許可の問題として扱う（drive.file では未選択が 404 でも返る）', (status) => {
    expect(classifyApiError(google(status))).toBe('permission');
  });

  test.each([
    [429, 'rate_limit'],
    [500, 'temporary'],
    [503, 'temporary'],
    [400, 'other'],
    [401, 'other'],
  ] as const)('Google の %i は %s', (status, kind) => {
    expect(classifyApiError(google(status))).toBe(kind);
  });

  test.each([
    [429, 'rate_limit'],
    [502, 'temporary'],
    [400, 'other'],
  ] as const)('NCBI の %i は %s', (status, kind) => {
    expect(classifyApiError(new EutilsError('esearch failed', status))).toBe(kind);
  });

  test('NCBI の恒久エラー（構文エラー等）は再試行を勧めない', () => {
    // permanent は status に関わらず other。500 で来ても再試行しても解消しない。
    expect(classifyApiError(new EutilsError('不明なタグ', 500, true))).toBe('other');
  });

  test.each([
    [429, 'rate_limit'],
    [503, 'temporary'],
    // LLM の 403 はほとんどが API キーの誤りで、共有設定の話ではない
    [403, 'other'],
  ] as const)('LLM の %i は %s', (status, kind) => {
    expect(classifyApiError(new LlmProviderError('Gemini API failed', 'gemini', status, ''))).toBe(kind);
  });

  test('ステータスを持たない LLM エラー（ネットワーク断・パース失敗）は other', () => {
    expect(classifyApiError(new LlmProviderError('壊れた応答', 'gemini', null, ''))).toBe('other');
  });

  test.each([
    new Error('検索式の展開結果が空です'),
    'ただの文字列',
    null,
  ])('分類できない例外は other', (err) => {
    expect(classifyApiError(err)).toBe('other');
  });
});
