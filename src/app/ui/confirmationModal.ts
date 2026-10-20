let modalSequence = 0;

/** 中止を既定とし、背景操作を止めてフォーカスを戻す共通モーダル。 */
export function showConfirmationModal(doc: Document, options: {
  title: string;
  content: HTMLElement;
  acceptLabel: string;
  cancelLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = doc.activeElement as HTMLElement | null;
    const overlay = doc.createElement('div');
    overlay.className = 'confirmation-modal';
    const panel = doc.createElement('div');
    panel.className = 'confirmation-modal__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const title = doc.createElement('h2');
    title.id = `confirmation-modal-${++modalSequence}`;
    title.textContent = options.title;
    title.tabIndex = -1;
    panel.setAttribute('aria-labelledby', title.id);
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = options.cancelLabel;
    const accept = doc.createElement('button');
    accept.type = 'button';
    accept.textContent = options.acceptLabel;
    panel.append(title, options.content, cancel, accept);
    overlay.appendChild(panel);
    const background = Array.from(doc.body.children).map((element) => ({
      element: element as HTMLElement, inert: (element as HTMLElement).inert,
    }));
    background.forEach(({ element }) => { element.inert = true; });
    const finish = (accepted: boolean): void => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocus, true);
      overlay.remove();
      background.forEach(({ element, inert }) => { element.inert = inert; });
      if (previous?.isConnected) previous.focus();
      resolve(accepted);
    };
    const onFocus = (event: FocusEvent): void => {
      if (!panel.contains(event.target as Node)) title.focus();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Tab') {
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button'));
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && (doc.activeElement === first || doc.activeElement === title)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(false); });
    doc.body.appendChild(overlay);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    title.focus();
  });
}
