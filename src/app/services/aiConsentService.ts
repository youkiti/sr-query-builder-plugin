import type { LlmProviderId } from '@/domain/llmApiLog';
import type { ProjectStoreDeps } from '@/features/project';
import { AI_CONSENT_KEY, AI_CONSENT_VERSION, GEMINI_DATA_TERMS_URL } from '@/lib/llm/aiDisclosure';
import { showConfirmationModal } from '../ui/confirmationModal';

export class AiConsentDeclinedError extends Error {
  constructor() {
    super('AI への送信に同意しなかったため中止しました');
    this.name = 'AiConsentDeclinedError';
  }
}

type ConsentRecords = Partial<Record<LlmProviderId, { version: string; acceptedAt: string }>>;

const disclosures = {
  anthropic: {
    destination: 'Anthropic（api.anthropic.com）',
    text: 'Anthropic の説明では、API の入力と出力は、既定ではモデルの学習に使わないとされています。保持期間などは Anthropic の説明を確かめてください。',
    links: ['https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training', 'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data'],
  },
  gemini: {
    destination: 'Google Gemini（generativelanguage.googleapis.com）',
    text: 'Google の説明では、Gemini API の無料枠では、送った内容と応答が Google の製品の改善に使われ、人が読むことがあるとされています。有料枠では改善に使わないとされています。未公開のプロトコルなど機密の内容は、無料枠で送らないでください。',
    links: [GEMINI_DATA_TERMS_URL],
  },
  openrouter: {
    destination: 'OpenRouter（openrouter.ai）。選んだモデルの提供元へ転送されます',
    text: 'OpenRouter の説明では、OpenRouter 自身は既定ではプロンプトと応答を保存しないとされています。転送先の提供元の扱いは提供元ごとに異なり、OpenRouter のプライバシー設定で学習に使う提供元を除外できます。',
    links: ['https://openrouter.ai/docs/guides/features/zdr', 'https://openrouter.ai/docs/guides/privacy/provider-logging'],
  },
};

/** 同時呼び出しをまとめ、同意の保存が成功してから送信を許可する。 */
export function createEnsureAiConsent(doc: Document, store: ProjectStoreDeps): (provider: LlmProviderId) => Promise<void> {
  const pending = new Map<LlmProviderId, Promise<void>>();
  let queue = Promise.resolve();
  return (provider) => {
    const existing = pending.get(provider);
    if (existing) return existing;
    const request = queue.then(async () => {
      const records = await store.read<ConsentRecords>(AI_CONSENT_KEY) ?? {};
      if (records[provider]?.version === AI_CONSENT_VERSION) return;
      if (provider === 'openai') throw new Error('この送り先の同意文は未対応です');
      const disclosure = disclosures[provider];
      const content = doc.createElement('div');
      const paragraph = (text: string): void => {
        const p = doc.createElement('p');
        p.textContent = text;
        content.appendChild(p);
      };
      paragraph(`送り先: ${disclosure.destination}`);
      paragraph('送る内容: 研究プロトコルの本文、検索ブロックの定義、検索式、PubMed の書誌（タイトル・抄録）、シード論文と判定結果。');
      paragraph('未公開のプロトコルを送るときは、送り先の扱いを確かめてください。');
      paragraph(disclosure.text);
      for (const [index, url] of [...disclosure.links, 'https://youkiti.github.io/sr-query-builder-plugin/privacy-policy.html'].entries()) {
        const p = doc.createElement('p');
        const link = doc.createElement('a');
        link.href = url;
        link.textContent = index === disclosure.links.length ? 'プライバシーポリシー' : `送り先の公式説明 ${index + 1}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        p.appendChild(link);
        content.appendChild(p);
      }
      const accepted = await showConfirmationModal(doc, {
        title: 'AI へ送る前に確認してください', content,
        acceptLabel: '同意して続ける', cancelLabel: '送らずに中止する',
      });
      if (!accepted) throw new AiConsentDeclinedError();
      const latest = await store.read<ConsentRecords>(AI_CONSENT_KEY) ?? {};
      await store.write({ [AI_CONSENT_KEY]: { ...latest, [provider]: {
        version: AI_CONSENT_VERSION, acceptedAt: new Date().toISOString(),
      } } });
    }).finally(() => { pending.delete(provider); });
    pending.set(provider, request);
    queue = request.catch(() => undefined);
    return request;
  };
}
