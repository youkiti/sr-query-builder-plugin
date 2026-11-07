// 公開下書きの伏せ字・許可 URL の境界・長さ制限を検証する。
import { createIssueDraft, sanitizeForIssue } from '../src/lib/help-consult/issueDraft';

const environment = {
  version: '0.9.0', uiLang: 'ja' as const, screen: 'draft', provider: 'gemini' as const,
  model: 'gemini-3.5-flash-lite', configuredProviders: ['gemini', 'anthropic'] as const, errorKind: 'timeout' as const,
};

test.each([
  'user+test@example.org', 'https://example.org/sheet?id=abc', 'http://localhost:123/a',
  'Abcdef1234567890_-ABC', 'https://github.com/youkiti/sr-query-builder-plugin-fake/a',
  'https://youkiti.github.io.evil/sr-query-builder-plugin/help', 'https://github.com/other/repo',
  'http://github.com/youkiti/sr-query-builder-plugin/issues',
  'https://user:pass@github.com/youkiti/sr-query-builder-plugin/issues',
  'https://github.com:443/youkiti/sr-query-builder-plugin/issues',
  'https://youkiti.github.io:8443/sr-query-builder-plugin/help.html',
  'https://youkiti.github.io/sr-query-builder-plugin',
])('公開できない文字列を伏せる: %s', value => {
  expect(sanitizeForIssue(value)).toBe('[REDACTED]');
});

test.each([
  'https://github.com/youkiti/sr-query-builder-plugin',
  'https://github.com/youkiti/sr-query-builder-plugin/issues/1',
  'https://youkiti.github.io/sr-query-builder-plugin/help.html?lang=ja#troubleshooting-shared-spreadsheet',
])('許可 URL は長いアンカーも含めて残す: %s', value => {
  expect(sanitizeForIssue(value + ' sk-abcdefghijklmnopqrstuvwxyz')).toBe(value + ' [REDACTED]');
});

test('全入力を伏せ、注意と環境を含む本文および題を URL から復元できる', () => {
  const draft = createIssueDraft({
    question: '質問 & # ? user@example.org', answer: 'https://private.test/data',
    environment: { ...environment, version: 'user@example.org', screen: 'https://private.test/data' },
  });
  const parsed = new URL(draft.url);
  expect(parsed.origin + parsed.pathname).toBe('https://github.com/youkiti/sr-query-builder-plugin/issues/new');
  expect(parsed.searchParams.get('title')).toBe(draft.title);
  expect(parsed.searchParams.get('body')).toBe(draft.body);
  expect(draft.body + draft.title).not.toMatch(/user@example|private.test/);
  expect(draft.body).toMatch(/^この下書きは公開の Issue/);
  expect(draft.body).toContain('public Issue');
  expect(draft.body).toContain('UI language: ja');
  expect(draft.body).toContain('Provider: gemini');
  expect(draft.body).toContain('Model: gemini-3.5-flash-lite');
  expect(draft.body).toContain('Configured providers: gemini, anthropic');
  expect(draft.body).toContain('Error kind: timeout');
});

test('日本語と絵文字を含む長い入力でも題は100文字、URL は8,000文字以内にし省略を明示する', () => {
  const draft = createIssueDraft({ question: '困りました😀'.repeat(20000), answer: '回答'.repeat(20000), environment });
  expect(Array.from(draft.title).length).toBeLessThanOrEqual(100);
  expect(draft.url.length).toBeLessThanOrEqual(8000);
  expect(draft.body).toContain('省略しました');
  expect(new URL(draft.url).searchParams.get('body')).toBe(draft.body);
  const short = createIssueDraft({ question: '短い質問', environment });
  expect(short.body).not.toContain('省略しました');
});
