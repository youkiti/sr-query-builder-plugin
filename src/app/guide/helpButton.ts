import { t } from '../../lib/i18n';
import { GUIDE_TOPIC_TITLE_KEYS, isGuideTopicId, type GuideTopicId } from '../../lib/guide/topics';

export const HELP_BUTTON_CLASS = 'guide-help-btn';

/** トピックの見出し（現在の表示言語） */
export function topicTitle(topicId: GuideTopicId): string {
  return t(GUIDE_TOPIC_TITLE_KEYS[topicId]);
}

function labelHelpButton(button: HTMLElement, topicId: GuideTopicId): void {
  button.setAttribute('aria-label', t('guide.helpFor', { title: topicTitle(topicId) }));
}

export type HelpButtonKind = 'heading' | 'topic';

/**
 * 「?」ボタン。文字は CSS の ::before で出し、textContent は空にする。
 * kind は、どの対象のためのボタンかの印（'heading' = 最初の h2、'topic' = data-help-topic の要素）。
 */
export function createHelpButton(doc: Document, topicId: GuideTopicId, kind: HelpButtonKind = 'heading'): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = HELP_BUTTON_CLASS;
  button.dataset.help = topicId;
  button.dataset.helpFor = kind;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  labelHelpButton(button, topicId);
  return button;
}

interface HelpTarget { topic: GuideTopicId; kind: HelpButtonKind }

/**
 * 表示領域に「?」を差す。何度呼んでも結果は同じ（差し込みは変化があるときだけ）。
 * ボタンは対象の要素の「直後の兄弟」に置く。子にすると、見出しの読み上げ名にボタンの aria-label が混ざるため。
 * - 領域内の最初の h2 の直後に、現在のルートのトピックの「?」
 * - data-help-topic を持つ要素の直後に、そのトピックの「?」
 * 直前の兄弟が自分の対象でなくなったボタン（取り残し・重複）は外す。
 */
export function mountHelpButtons(content: Element, routeTopic: GuideTopicId): void {
  const targets = new Map<Element, HelpTarget>();
  const heading = content.querySelector('h2');
  if (heading && !heading.hasAttribute('data-help-topic')) targets.set(heading, { topic: routeTopic, kind: 'heading' });
  content.querySelectorAll('[data-help-topic]').forEach(host => {
    const topic = host.getAttribute('data-help-topic');
    if (isGuideTopicId(topic)) targets.set(host, { topic, kind: 'topic' });
  });
  const satisfied = new Set<Element>();
  content.querySelectorAll<HTMLElement>(`.${HELP_BUTTON_CLASS}`).forEach(button => {
    const host = button.previousElementSibling;
    const target = host ? targets.get(host) : undefined;
    if (!host || !target || satisfied.has(host) || button.dataset.helpFor !== target.kind) {
      button.remove();
      return;
    }
    satisfied.add(host);
    if (button.dataset.help !== target.topic) button.dataset.help = target.topic;
    labelHelpButton(button, target.topic);
  });
  targets.forEach((target, host) => {
    if (!satisfied.has(host)) host.after(createHelpButton(host.ownerDocument, target.topic, target.kind));
  });
}
