import { t } from '../../lib/i18n';

export function guideButton(doc: Document, action: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.dataset.guideAction = action;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

export function createSuggestBand(doc: Document, actions: { start: () => void; postpone: () => void; suppress: () => void }): HTMLElement {
  const band = doc.createElement('section');
  band.id = 'guide-suggest-band';
  band.className = 'guide-suggest-band';
  const title = doc.createElement('p');
  title.textContent = t('guide.suggest');
  band.append(title,
    guideButton(doc, 'start', t('guide.startSuggested'), actions.start),
    guideButton(doc, 'postpone', t('guide.postpone'), actions.postpone),
    guideButton(doc, 'suppress', t('guide.suppress'), actions.suppress));
  return band;
}
