import {
  addMeshDescriptor,
  hasMeshDescriptor,
  operandMeshDescriptor,
  removeMeshDescriptor,
} from './meshExpressionEdit';

describe('operandMeshDescriptor', () => {
  test('単一 MeSH 句なら descriptor を返す', () => {
    expect(operandMeshDescriptor('"Surgeons"[Mesh]')).toBe('Surgeons');
    expect(operandMeshDescriptor('Asthma[mh]')).toBe('Asthma');
  });
  test('フリーワード・複合句は null', () => {
    expect(operandMeshDescriptor('surgeon*[tiab]')).toBeNull();
    expect(operandMeshDescriptor('"A"[Mesh] OR b[tiab]')).toBeNull();
  });
});

describe('hasMeshDescriptor', () => {
  test('大小・空白を無視して既存判定', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(hasMeshDescriptor(expr, 'surgeons')).toBe(true);
    expect(hasMeshDescriptor(expr, 'Neurosurgeons')).toBe(false);
  });
});

describe('addMeshDescriptor', () => {
  test('括弧付き OR リストの内側に追加する', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(addMeshDescriptor(expr, 'Neurosurgeons')).toBe(
      '("Surgeons"[Mesh] OR surgeon*[tiab] OR "Neurosurgeons"[Mesh])'
    );
  });

  test('括弧なしの式にも OR で追加する', () => {
    expect(addMeshDescriptor('"Surgeons"[Mesh]', 'Neurosurgeons')).toBe(
      '"Surgeons"[Mesh] OR "Neurosurgeons"[Mesh]'
    );
  });

  test('空式なら単独の句にする', () => {
    expect(addMeshDescriptor('', 'Surgeons')).toBe('"Surgeons"[Mesh]');
    expect(addMeshDescriptor('   ', 'Surgeons')).toBe('"Surgeons"[Mesh]');
  });

  test('既に含まれていれば原文のまま', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(addMeshDescriptor(expr, 'Surgeons')).toBe(expr);
    // 大小違いも重複扱い
    expect(addMeshDescriptor(expr, 'surgeons')).toBe(expr);
  });

  test('空ラベルは無視', () => {
    expect(addMeshDescriptor('a[tiab]', '  ')).toBe('a[tiab]');
  });

  test('AND を含む式でも末尾 operand の後ろに足す（演算子は壊さない）', () => {
    const expr = 'a[tiab] AND b[tiab]';
    expect(addMeshDescriptor(expr, 'Surgeons')).toBe('a[tiab] AND b[tiab] OR "Surgeons"[Mesh]');
  });
});

describe('removeMeshDescriptor', () => {
  test('中間の MeSH 句を隣接 OR ごと取り除く', () => {
    const expr = '("Surgeons"[Mesh] OR "Neurosurgeons"[Mesh] OR surgeon*[tiab])';
    expect(removeMeshDescriptor(expr, 'Neurosurgeons')).toBe(
      '("Surgeons"[Mesh] OR surgeon*[tiab])'
    );
  });

  test('先頭の MeSH 句を後続 OR ごと取り除く', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(removeMeshDescriptor(expr, 'Surgeons')).toBe('(surgeon*[tiab])');
  });

  test('末尾の MeSH 句を直前 OR ごと取り除く', () => {
    const expr = '(surgeon*[tiab] OR "Surgeons"[Mesh])';
    expect(removeMeshDescriptor(expr, 'Surgeons')).toBe('(surgeon*[tiab])');
  });

  test('唯一の句を消すと空になる', () => {
    expect(removeMeshDescriptor('("Surgeons"[Mesh])', 'Surgeons')).toBe('');
    expect(removeMeshDescriptor('"Surgeons"[Mesh]', 'Surgeons')).toBe('');
  });

  test('該当が無ければ原文のまま', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(removeMeshDescriptor(expr, 'Neurosurgeons')).toBe(expr);
  });

  test('大小違いでも取り除く', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(removeMeshDescriptor(expr, 'surgeons')).toBe('(surgeon*[tiab])');
  });
});
