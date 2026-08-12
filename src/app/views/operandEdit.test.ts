import {
  appendFreeword,
  findOperandByText,
  listOperands,
  removeOperandAt,
  setOperandTerm,
} from './operandEdit';

describe('listOperands', () => {
  test('OR リストを語種・編集対象語・タグ付きで列挙する', () => {
    const ops = listOperands('("Heart Failure"[Mesh] OR heart failure[tiab] OR "cardiac"[tw])');
    expect(ops).toEqual([
      { index: 1, order: 0, text: '"Heart Failure"[Mesh]', kind: 'mesh', term: 'Heart Failure', tag: 'Mesh' },
      { index: 3, order: 1, text: 'heart failure[tiab]', kind: 'freeword', term: 'heart failure', tag: 'tiab' },
      { index: 5, order: 2, text: '"cardiac"[tw]', kind: 'freeword', term: '"cardiac"', tag: 'tw' },
    ]);
  });

  test('複合句（ネスト群）は other 扱いでタグ無し', () => {
    const ops = listOperands('(a[tiab] OR b[tiab]) AND c[tiab]');
    expect(ops.map((o) => o.kind)).toEqual(['other', 'freeword']);
    expect(ops[0]!.term).toBe('(a[tiab] OR b[tiab])');
    expect(ops[0]!.tag).toBeNull();
  });

  test('括弧なしフラット式でも index/order が一致する', () => {
    const ops = listOperands('x[tiab] OR y[tiab]');
    expect(ops.map((o) => [o.index, o.order, o.term])).toEqual([
      [0, 0, 'x'],
      [2, 1, 'y'],
    ]);
  });
});

describe('findOperandByText', () => {
  test('タグ込みテキストで operand を引き当てる（大小・空白無視）', () => {
    const expr = '"Heart Failure"[Mesh] OR surgeon*[tiab]';
    expect(findOperandByText(expr, 'surgeon*[tiab]')?.index).toBe(2);
    expect(findOperandByText(expr, 'SURGEON*[tiab]')?.term).toBe('surgeon*');
    expect(findOperandByText(expr, '"heart failure"[mesh]')?.kind).toBe('mesh');
  });

  test('一致しなければ null', () => {
    expect(findOperandByText('a[tiab]', 'b[tiab]')).toBeNull();
  });
});

describe('removeOperandAt', () => {
  test('中間の句を隣接 OR ごと取り除く', () => {
    const expr = '(a[tiab] OR b[tiab] OR c[tiab])';
    // b は order=1 → index=3
    expect(removeOperandAt(expr, 3)).toBe('(a[tiab] OR c[tiab])');
  });

  test('先頭の句を後続 OR ごと取り除く', () => {
    expect(removeOperandAt('(a[tiab] OR b[tiab])', 1)).toBe('(b[tiab])');
  });

  test('末尾の句を直前 OR ごと取り除く', () => {
    expect(removeOperandAt('(a[tiab] OR b[tiab])', 3)).toBe('(a[tiab])');
  });

  test('唯一の句を消すと空になる', () => {
    expect(removeOperandAt('(a[tiab])', 1)).toBe('');
    expect(removeOperandAt('a[tiab]', 0)).toBe('');
  });

  test('MeSH 句もインデックスで取り除ける', () => {
    expect(removeOperandAt('"A"[Mesh] OR b[tiab]', 0)).toBe('b[tiab]');
  });

  test('operand でない位置・範囲外は原文のまま', () => {
    const expr = '(a[tiab] OR b[tiab])';
    expect(removeOperandAt(expr, 2)).toBe(expr); // glue 位置
    expect(removeOperandAt(expr, 99)).toBe(expr);
  });
});

describe('setOperandTerm', () => {
  test('フリーワードの語だけ差し替え、タグは保持する', () => {
    expect(setOperandTerm('a[tiab] OR b[tiab]', 0, 'asthma*')).toBe('asthma*[tiab] OR b[tiab]');
  });

  test('引用句のタグも保持する', () => {
    expect(setOperandTerm('"old phrase"[tw]', 0, '"new phrase"')).toBe('"new phrase"[tw]');
  });

  test('空語は削除に倒す', () => {
    expect(setOperandTerm('a[tiab] OR b[tiab]', 0, '   ')).toBe('b[tiab]');
  });

  test('複合句（タグ無し）は全文置換', () => {
    expect(setOperandTerm('(a OR b) AND c[tiab]', 0, '(x OR y)')).toBe('(x OR y) AND c[tiab]');
  });

  test('operand でない位置は原文のまま', () => {
    expect(setOperandTerm('a[tiab] OR b[tiab]', 1, 'z')).toBe('a[tiab] OR b[tiab]');
  });
});

describe('appendFreeword', () => {
  test('括弧付き OR リストの内側に tiab で追加する', () => {
    expect(appendFreeword('(a[tiab] OR b[tiab])', 'cough')).toBe(
      '(a[tiab] OR b[tiab] OR cough[tiab])'
    );
  });

  test('括弧なしの式にも OR で追加する', () => {
    expect(appendFreeword('a[tiab]', 'cough')).toBe('a[tiab] OR cough[tiab]');
  });

  test('タグを指定できる', () => {
    expect(appendFreeword('a[tiab]', 'cough', 'tw')).toBe('a[tiab] OR cough[tw]');
  });

  test('空式なら単独の句にする', () => {
    expect(appendFreeword('', 'cough')).toBe('cough[tiab]');
  });

  test('空語は無視', () => {
    expect(appendFreeword('a[tiab]', '   ')).toBe('a[tiab]');
  });

  test('AND を含む式でも末尾 operand の後ろに足す', () => {
    expect(appendFreeword('a[tiab] AND b[tiab]', 'cough')).toBe('a[tiab] AND b[tiab] OR cough[tiab]');
  });
});
