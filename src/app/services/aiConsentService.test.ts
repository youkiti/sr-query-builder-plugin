import { AiConsentDeclinedError, createEnsureAiConsent } from './aiConsentService';
import { AI_CONSENT_VERSION } from '@/lib/llm/aiDisclosure';

function setup(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const store = {
    read: async <T>(key: string) => data[key] as T | undefined,
    write: jest.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
  };
  return { data, store, ensure: createEnsureAiConsent(document, store) };
}
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function click(label: string) {
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent === label)!.click();
}
afterEach(() => { document.body.innerHTML = ''; });

test('同時呼び出しは一つの同意になり、版と日時を保存して次回は表示しない', async () => {
  const f = setup();
  const first = f.ensure('gemini');
  const concurrent = f.ensure('gemini');
  await flush();
  expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
  expect(document.body.textContent).toContain('generativelanguage.googleapis.com');
  expect(document.body.textContent).toContain('Google の説明では、Gemini API の無料枠では、送った内容と応答が Google の製品の改善に使われ、人が読むことがあるとされています。有料枠では改善に使わないとされています。未公開のプロトコルなど機密の内容は、無料枠で送らないでください。');
  click('同意して続ける');
  await Promise.all([first, concurrent]);
  expect(f.data.aiConsent).toEqual({ gemini: { version: AI_CONSENT_VERSION, acceptedAt: expect.any(String) } });
  const record = (f.data.aiConsent as Record<string, { acceptedAt: string }>).gemini!;
  expect(new Date(record.acceptedAt).toISOString()).toBe(record.acceptedAt);
  await f.ensure('gemini');
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

test.each(['button', 'escape', 'outside'])('中止 %s は保存せず専用エラーにし、安全な初期フォーカスと元への復帰を守る', async (method) => {
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();
  const f = setup();
  const result = f.ensure('anthropic');
  const rejected = expect(result).rejects.toBeInstanceOf(AiConsentDeclinedError);
  await flush();
  const dialog = document.querySelector('[role=dialog]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement?.id).toBe(dialog.getAttribute('aria-labelledby'));
  expect(document.body.textContent).toContain('api.anthropic.com');
  expect(document.body.textContent).toContain('Anthropic の説明では、API の入力と出力は、既定ではモデルの学習に使わないとされています。保持期間などは Anthropic の説明を確かめてください。');
  if (method === 'button') click('送らずに中止する');
  else if (method === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  else document.querySelector<HTMLElement>('.confirmation-modal')!.click();
  await rejected;
  expect(f.store.write).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

test('旧版は再同意を求め、別プロバイダの記録を残す', async () => {
  const f = setup({ aiConsent: { anthropic: { version: AI_CONSENT_VERSION, acceptedAt: 'old' }, openrouter: { version: '0', acceptedAt: 'old' } } });
  const request = f.ensure('openrouter');
  await flush();
  expect(document.body.textContent).toContain('選んだモデルの提供元へ転送されます');
  expect(document.body.textContent).toContain('OpenRouter の説明では、OpenRouter 自身は既定ではプロンプトと応答を保存しないとされています。転送先の提供元の扱いは提供元ごとに異なり、OpenRouter のプライバシー設定で学習に使う提供元を除外できます。');
  click('同意して続ける');
  await request;
  expect(f.data.aiConsent).toMatchObject({ anthropic: { acceptedAt: 'old' }, openrouter: { version: AI_CONSENT_VERSION } });
});

test('保存失敗は送信許可にせず、再度同意を求める', async () => {
  const f = setup();
  f.store.write.mockRejectedValueOnce(new Error('保存失敗'));
  const request = f.ensure('gemini');
  const rejected = expect(request).rejects.toThrow('保存失敗');
  await flush();
  click('同意して続ける');
  await rejected;
  const retry = f.ensure('gemini');
  await flush();
  click('送らずに中止する');
  await expect(retry).rejects.toBeInstanceOf(AiConsentDeclinedError);
});

test('Tab をダイアログ内で循環させ、背景に移ったフォーカスを戻す', async () => {
  const background = document.createElement('button');
  document.body.appendChild(background);
  const f = setup();
  const request = f.ensure('gemini');
  await flush();
  expect(background.inert).toBe(true);
  const dialog = document.querySelector('[role=dialog]')!;
  const accept = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '同意して続ける')!;
  accept.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(dialog.querySelector('a'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(accept);
  background.focus();
  expect(document.activeElement?.id).toBe(dialog.getAttribute('aria-labelledby'));
  click('同意して続ける');
  await request;
  expect(background.inert).not.toBe(true);
});
