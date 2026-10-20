export const AI_CONSENT_VERSION = '1';
export const AI_CONSENT_KEY = 'aiConsent';
export const GEMINI_DATA_TERMS_URL = 'https://ai.google.dev/gemini-api/terms';
export const GEMINI_FREE_TIER_NOTICE = 'Google の説明では、Gemini API の無料枠では送った内容と応答が製品の改善に使われ、人が読むことがあるとされています。未公開のプロトコルなど機密の内容は送らないでください。';

/** 無料枠の検出表示に添える注意。文字色は既定値を使う。 */
export function updateGeminiDataNotice(badge: HTMLElement, free: boolean): void {
  const parent = badge.closest('.options__provider-card, .settings__provider-card') ?? badge.parentElement;
  if (!parent) return;
  parent.querySelector('.gemini-data-notice')?.remove();
  if (!free) return;
  const notice = badge.ownerDocument.createElement('p');
  notice.className = 'gemini-data-notice';
  notice.append(`⚠ ${GEMINI_FREE_TIER_NOTICE} `);
  const link = badge.ownerDocument.createElement('a');
  link.href = GEMINI_DATA_TERMS_URL;
  link.textContent = 'Google の説明';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.textDecoration = 'underline';
  notice.appendChild(link);
  parent.appendChild(notice);
}
