import { renderEditableBlockInto, type EditableBlockHandlers } from './editableBlock';

function buildDoc(): Document {
  return document.implementation.createHTMLDocument('test');
}

function render(
  expr: string,
  over: Partial<EditableBlockHandlers> = {}
): { container: HTMLElement; calls: { remove: number[]; edit: Array<[number, string]>; add: string[] } } {
  const doc = buildDoc();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const calls = { remove: [] as number[], edit: [] as Array<[number, string]>, add: [] as string[] };
  const handlers: EditableBlockHandlers = {
    onRemove: (i) => calls.remove.push(i),
    onEditTerm: (i, t) => calls.edit.push([i, t]),
    onAddFreeword: (t) => calls.add.push(t),
    ...over,
  };
  renderEditableBlockInto(container, expr, handlers);
  return { container, calls };
}

describe('renderEditableBlockInto', () => {
  test('フリーワードはクリック編集ボタン、MeSH はリンクになる', () => {
    const { container } = render('"Asthma"[Mesh] OR asthma*[tiab]');
    const mesh = container.querySelector<HTMLAnchorElement>('.edit__chip--mesh .edit__chip-term--mesh');
    expect(mesh?.tagName).toBe('A');
    expect(mesh?.href).toContain('term=Asthma');
    const free = container.querySelector<HTMLButtonElement>(
      '.edit__chip--freeword .edit__chip-term--editable'
    );
    expect(free?.tagName).toBe('BUTTON');
    expect(free?.textContent).toBe('asthma*[tiab]');
  });

  test('演算子・括弧は地のテキストとして残る', () => {
    const { container } = render('(a[tiab] OR b[tiab])');
    // チップの語と glue を合わせると元式の骨格になる
    expect(container.textContent).toContain('(');
    expect(container.textContent).toContain(' OR ');
    expect(container.textContent).toContain(')');
  });

  test('✕ クリックで onRemove に operand index を渡す', () => {
    const { container, calls } = render('a[tiab] OR b[tiab]');
    const removes = container.querySelectorAll<HTMLButtonElement>('.edit__chip-remove');
    removes[1]!.click(); // 2 つ目（b、index=2）
    expect(calls.remove).toEqual([2]);
  });

  test('フリーワードクリック→input→Enter で onEditTerm（語のみ）を渡す', () => {
    const { container, calls } = render('a[tiab] OR b[tiab]');
    const termBtn = container.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!;
    termBtn.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-input')!;
    expect(input.value).toBe('a'); // タグを除いた語
    input.value = 'asthma*';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(calls.edit).toEqual([[0, 'asthma*']]);
  });

  test('Esc は編集を取り消して何も呼ばない', () => {
    const { container, calls } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.value = 'zzz';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(calls.edit).toEqual([]);
    expect(container.querySelector('.edit__chip-input')).toBeNull();
  });

  test('変化なしの確定は onEditTerm を呼ばない', () => {
    const { container, calls } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(calls.edit).toEqual([]);
  });

  test('「＋ 語を追加」→input→Enter で onAddFreeword を渡す', () => {
    const { container, calls } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-add-btn')!.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-add-input')!;
    input.value = 'cough';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(calls.add).toEqual(['cough']);
  });

  test('語編集の input には保持タグ [tiab] が静的接尾辞として添えられる', () => {
    const { container } = render('asthma*[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!.click();
    const suffix = container.querySelector('.edit__chip-edit .edit__chip-tag-suffix');
    expect(suffix?.textContent).toBe('[tiab]');
  });

  test('語追加の input には [tiab] の静的接尾辞が添えられる', () => {
    const { container } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-add-btn')!.click();
    const suffix = container.querySelector('.edit__chip-edit .edit__chip-tag-suffix');
    expect(suffix?.textContent).toBe('[tiab]');
  });

  test('語編集でうっかり [tiab] を打っても末尾タグを 1 つ剥がして渡す', () => {
    const { container, calls } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-term--editable')!.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-input')!;
    input.value = 'asthma*[tiab]';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(calls.edit).toEqual([[0, 'asthma*']]);
  });

  test('語追加でうっかり [tiab] を打っても末尾タグを 1 つ剥がして渡す', () => {
    const { container, calls } = render('a[tiab]');
    container.querySelector<HTMLButtonElement>('.edit__chip-add-btn')!.click();
    const input = container.querySelector<HTMLInputElement>('.edit__chip-add-input')!;
    input.value = 'cough[tiab]';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(calls.add).toEqual(['cough']);
  });

  test('複合句（ネスト群）は削除のみ、自由入力ボタンを出さない', () => {
    const { container } = render('(a[tiab] OR b[tiab]) AND c[tiab]');
    const otherChip = container.querySelector('.edit__chip--other')!;
    expect(otherChip.querySelector('.edit__chip-term--editable')).toBeNull();
    expect(otherChip.querySelector('.edit__chip-term--static')).toBeTruthy();
    expect(otherChip.querySelector('.edit__chip-remove')).toBeTruthy();
  });
});
