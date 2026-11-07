// ヘルプの端末内検索、一問一答と公開 Issue 下書きをまとめる小窓。
import type { ProjectStoreDeps } from '@/features/project';
import { getUiLanguage, t, type MessageKey } from '@/lib/i18n';
import { GUIDE_TOPICS, HELP_PAGE_URL } from '@/lib/guide/topics';
import { availableTours, type GuideConditionValues } from '@/lib/guide/tourProgress';
import type { GuideTourId } from '@/lib/guide/tours';
import { loadHelpSections } from '@/lib/help-consult/load';
import { searchHelpSections } from '@/lib/help-consult/search';
import { consultHelp } from '@/lib/help-consult/consult';
import { chooseConsultProvider, CONSULT_MODELS, type ConsultProviderId } from '@/lib/help-consult/model';
import { createIssueDraft } from '@/lib/help-consult/issueDraft';
import type { ConsultFailureKind, HelpSection } from '@/lib/help-consult/types';
import { chromeLlmHostPermissions, providerOrigins } from '@/lib/llm/hostPermissions';
import { getGeminiApiKey, getAnthropicApiKey, getOpenRouterApiKey, STORAGE_KEY_LLM_MODEL } from '../../services/llmProviderService';
import { AiConsentDeclinedError, createEnsureHelpConsultConsent } from '../../services/aiConsentService';
import type { RouteName } from '../../router';

export interface ConsultHost {
  store: ProjectStoreDeps;
  route: RouteName;
  conditions: () => GuideConditionValues;
  start: (id: GuideTourId) => void;
}

let sequence = 0;

export function openHelpConsult(doc: Document, returnFocus: HTMLElement, host: ConsultHost): () => void {
  const lang = getUiLanguage();
  const prefix = `guide-consult-${++sequence}`;
  const overlay = doc.createElement('div');
  overlay.className = 'guide-consult';
  const panel = doc.createElement('section');
  panel.className = 'guide-consult__panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${prefix}-title`);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, key?: MessageKey): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (key) {
      node.textContent = t(key);
    }
    return node;
  };
  const button = (key: MessageKey, run: () => void): HTMLButtonElement => {
    const node = element('button', key);
    node.type = 'button';
    node.className = 'guide-consult__btn';
    node.addEventListener('click', run);
    return node;
  };
  const actions = (...nodes: HTMLElement[]): HTMLDivElement => {
    const row = element('div');
    row.className = 'guide-consult__actions';
    row.append(...nodes);
    return row;
  };
  const title = element('h2', 'guide.consultTitle');
  title.id = `${prefix}-title`;
  const questionLabel = element('label', 'guide.consultQuestion');
  const question = element('textarea');
  question.id = `${prefix}-question`;
  question.maxLength = 1000;
  questionLabel.htmlFor = question.id;
  const currentTitle = element('h3', 'guide.consultCurrent');
  const results = element('div');
  results.className = 'guide-consult__results';
  const notice = element('p');
  const gemini = element('p', 'guide.consultGemini');
  gemini.hidden = true;
  const reason = element('p');
  reason.id = `${prefix}-reason`;
  reason.setAttribute('aria-live', 'polite');
  const answer = element('div');
  answer.className = 'guide-consult__answer';
  answer.setAttribute('aria-live', 'polite');
  const draftLabel = element('label', 'guide.consultDraft');
  const draft = element('textarea');
  draft.id = `${prefix}-draft`;
  draft.readOnly = true;
  draft.rows = 8;
  draftLabel.htmlFor = draft.id;
  const issue = element('a', 'guide.consultIssue');
  issue.target = '_blank';
  issue.rel = 'noopener noreferrer';
  const copyStatus = element('p');
  copyStatus.setAttribute('role', 'status');
  let sections: readonly HelpSection[] = [];
  let loaded = false;
  let closed = false;
  let loadFailed = false;
  let controller: AbortController | null = null;
  let provider: ConsultProviderId | null = null;
  let keys: Record<ConsultProviderId, string | null> = { gemini: null, anthropic: null, openrouter: null };
  let configured: ConsultProviderId[] = [];
  let permitted = false;
  let answerText = '';
  let errorKind: ConsultFailureKind | undefined;
  let version = 'unknown';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // 拡張 API が無い文書では unknown を使う。
  }
  const company = (): string => provider === 'gemini' ? 'Google Gemini' : provider === 'anthropic' ? 'Anthropic' : 'OpenRouter';
  const ensureConsent = createEnsureHelpConsultConsent(doc, host.store);
  function updateDraft(): void {
    const result = createIssueDraft({ question: question.value, answer: answerText, environment: {
      version, uiLang: lang, screen: host.route, provider, model: provider ? CONSULT_MODELS[provider] : '',
      configuredProviders: configured, errorKind,
    } });
    draft.value = result.body;
    issue.href = result.url;
  }
  function update(): void {
    const key: MessageKey | null = controller ? 'guide.consultRunning' : !loaded ? 'guide.consultLoading'
      : loadFailed ? 'guide.consult_unknown' : !provider ? 'guide.consult_no_key'
        : !permitted ? 'guide.consult_permission_missing' : !question.value.trim() ? 'guide.consultEmpty' : null;
    ask.disabled = key !== null;
    search.disabled = !loaded || loadFailed;
    reason.textContent = key ? t(key, { company: company() }) : '';
    cancel.hidden = !controller;
    question.disabled = !!controller;
    updateDraft();
  }
  function card(section: HelpSection): HTMLElement {
    const node = element('article');
    node.className = 'guide-consult__card';
    const heading = element('h4');
    heading.textContent = section.title;
    const when = element('p');
    when.textContent = section.when[0] ?? '';
    const link = element('a', 'guide.consultOpen');
    link.href = `${HELP_PAGE_URL}?lang=${lang}#${section.id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const links = actions(link);
    node.append(heading, when, links);
    const usable = availableTours(undefined, host.conditions());
    const ids = new Set(Object.values(GUIDE_TOPICS).filter(topic => topic.helpAnchor === section.id).map(topic => topic.tourId));
    for (const tour of usable.filter(tour => ids.has(tour.id))) {
      links.append(button('guide.consultTour', () => {
        close();
        host.start(tour.id);
      }));
    }
    return node;
  }
  const search = button('guide.consultSearch', () => {
    currentTitle.textContent = t('guide.consultSearchResults');
    const matches = searchHelpSections(sections, question.value, 3);
    results.replaceChildren(...matches.map(card));
    if (!matches.length) {
      results.append(element('p', 'guide.consult_no_match'));
    }
  });
  const ask = button('guide.consultAsk', () => { void send(); });
  ask.classList.add('guide-consult__btn--primary');
  ask.setAttribute('aria-describedby', reason.id);
  const cancel = button('guide.consultCancel', () => controller?.abort());
  async function send(): Promise<void> {
    if (ask.disabled || !provider) {
      return;
    }
    const active = new AbortController();
    controller = active;
    answer.replaceChildren();
    answerText = '';
    errorKind = undefined;
    update();
    try {
      await ensureConsent(provider);
      if (closed || active.signal.aborted) {
        return;
      }
      const result = await consultHelp({
        question: question.value, lang, sections, providerId: provider, apiKey: keys[provider], signal: active.signal,
      });
      if (closed) {
        return;
      }
      if (result.status === 'success') {
        answerText = result.answer;
        const text = element('p');
        text.textContent = result.answer;
        answer.append(text, element('p', 'guide.consultVerify'),
          ...result.sectionIds.flatMap(id => sections.filter(section => section.id === id).map(card)));
      } else {
        errorKind = result.status === 'failure' ? result.kind : undefined;
        answer.textContent = t(result.status === 'no_match' ? 'guide.consult_no_match' : `guide.consult_${result.kind}`,
          { company: company() });
      }
    } catch (error) {
      if (!closed) {
        errorKind = error instanceof AiConsentDeclinedError ? undefined : 'unknown';
        answer.textContent = t(error instanceof AiConsentDeclinedError ? 'guide.consultConsentDeclined' : 'guide.consult_unknown');
      }
    } finally {
      if (active.signal.aborted && !closed) {
        errorKind = 'aborted';
        answer.textContent = t('guide.consult_aborted');
      }
      controller = null;
      update();
    }
  }
  question.addEventListener('input', () => {
    answer.replaceChildren();
    answerText = '';
    errorKind = undefined;
    copyStatus.textContent = '';
    update();
  });
  const copy = button('guide.consultCopy', () => {
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (!clipboard) {
      copyStatus.textContent = t('guide.consultCopyFailed');
      return;
    }
    void clipboard.writeText(draft.value).then(() => {
      copyStatus.textContent = t('guide.consultCopied');
    }).catch(() => {
      copyStatus.textContent = t('guide.consultCopyFailed');
    });
  });
  const header = element('header');
  header.className = 'guide-consult__header';
  header.append(title, button('guide.consultClose', () => close()));
  panel.append(header, questionLabel, question, actions(search), currentTitle, results,
    element('h3', 'guide.consultAiTitle'), notice, gemini, actions(ask, cancel), reason, answer,
    element('h3', 'guide.consultUnresolved'), draftLabel, draft, actions(issue, copy), copyStatus,
    element('p', 'guide.consultFallback'));
  overlay.append(panel);
  const background = Array.from(doc.body.children).map(node => ({ node: node as HTMLElement, inert: (node as HTMLElement).inert }));
  background.forEach(({ node }) => { node.inert = true; });
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    controller?.abort();
    overlay.remove();
    background.forEach(({ node, inert }) => { node.inert = inert; });
    doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('focusin', onFocus);
    if (returnFocus.isConnected) {
      returnFocus.focus();
    }
  }
  function onFocus(event: FocusEvent): void {
    if (overlay.inert) {
      return;
    }
    if (!panel.contains(event.target as Node)) {
      question.focus();
    }
  }
  function onKey(event: KeyboardEvent): void {
    if (overlay.inert) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button, textarea'))
        .filter(node => !node.hidden && !node.hasAttribute('disabled'));
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  doc.body.append(overlay);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('focusin', onFocus);
  question.focus();
  update();
  void Promise.all([
    loadHelpSections(lang), getGeminiApiKey(host.store), getAnthropicApiKey(host.store),
    getOpenRouterApiKey(host.store), host.store.read<string>(STORAGE_KEY_LLM_MODEL),
  ]).then(async ([data, geminiKey, anthropicKey, openrouterKey, selectedModel]) => {
    sections = data;
    keys = { gemini: geminiKey, anthropic: anthropicKey, openrouter: openrouterKey };
    configured = (Object.keys(keys) as ConsultProviderId[]).filter(id => !!keys[id]?.trim());
    provider = chooseConsultProvider(new Set(configured), selectedModel);
    const origins = provider ? providerOrigins([provider]) : [];
    permitted = !origins.length || await chromeLlmHostPermissions().contains({ origins });
    if (closed) {
      return;
    }
    notice.textContent = provider ? t('guide.consultNotice', { company: company(), model: CONSULT_MODELS[provider] }) : '';
    gemini.hidden = provider !== 'gemini';
    const anchor = GUIDE_TOPICS[host.route].helpAnchor;
    const initial = sections.find(section => section.id === anchor);
    const chapter = sections.find(section => section.sectionId === anchor);
    if (initial) {
      results.append(card(initial));
    } else if (chapter) {
      results.append(card({ ...chapter, id: anchor, title: chapter.sectionTitle }));
    }
    loaded = true;
    update();
  }).catch(() => {
    loadFailed = true;
    loaded = true;
    update();
  });
  return close;
}