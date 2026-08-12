import {
  addMeshDescriptor,
  dedupeOperands,
  hasMeshDescriptor,
  operandMeshDescriptor,
  removeMeshDescriptor,
  replaceMeshDescriptor,
  sortOperandsMeshFirst,
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

describe('dedupeOperands', () => {
  test('OR で二重化した MeSH 句を初出だけ残して掃除する', () => {
    const expr =
      '("Surgeons"[Mesh] OR surgeon*[tiab] OR "Oral and Maxillofacial Surgeons"[Mesh] OR "Neurosurgeons"[Mesh] OR "Oral and Maxillofacial Surgeons"[Mesh])';
    expect(dedupeOperands(expr)).toBe(
      '("Surgeons"[Mesh] OR surgeon*[tiab] OR "Oral and Maxillofacial Surgeons"[Mesh] OR "Neurosurgeons"[Mesh])'
    );
  });

  test('重複フリーワードも除去する（初出を残す）', () => {
    expect(dedupeOperands('surgeon*[tiab] OR cough[tiab] OR surgeon*[tiab]')).toBe(
      'surgeon*[tiab] OR cough[tiab]'
    );
  });

  test('MeSH は descriptor で判定（引用符・タグ表記の差を吸収）', () => {
    // "Surgeons"[Mesh] と Surgeons[mh] は同一 descriptor → 後者を落とす
    expect(dedupeOperands('"Surgeons"[Mesh] OR Surgeons[mh]')).toBe('"Surgeons"[Mesh]');
  });

  test('フリーワードのタグ違いは別物として残す', () => {
    expect(dedupeOperands('x[tiab] OR x[tw]')).toBe('x[tiab] OR x[tw]');
  });

  test('重複が無ければ原文のまま', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(dedupeOperands(expr)).toBe(expr);
  });

  test('全部が同一なら 1 つに畳む', () => {
    expect(dedupeOperands('("A"[Mesh] OR "A"[Mesh] OR "A"[Mesh])')).toBe('("A"[Mesh])');
  });
});

describe('sortOperandsMeshFirst', () => {
  test('MeSH を前・フリーワードを後に並べ替え、各グループ内の順序は保つ', () => {
    const expr = '(surgeon*[tiab] OR "Surgeons"[Mesh] OR cough[tiab] OR "Neurosurgeons"[Mesh])';
    expect(sortOperandsMeshFirst(expr)).toBe(
      '("Surgeons"[Mesh] OR "Neurosurgeons"[Mesh] OR surgeon*[tiab] OR cough[tiab])'
    );
  });

  test('括弧なしでも並べ替える', () => {
    expect(sortOperandsMeshFirst('a[tiab] OR "B"[Mesh]')).toBe('"B"[Mesh] OR a[tiab]');
  });

  test('既に MeSH 先頭なら原文のまま', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(sortOperandsMeshFirst(expr)).toBe(expr);
  });

  test('最上位に AND/NOT を含む式は順序が意味を持つので並べ替えない', () => {
    expect(sortOperandsMeshFirst('a[tiab] AND "B"[Mesh]')).toBe('a[tiab] AND "B"[Mesh]');
    const expr2 = '("B"[Mesh] OR a[tiab]) NOT c[tiab]';
    expect(sortOperandsMeshFirst(expr2)).toBe(expr2);
  });

  test('句が 1 つ以下なら原文のまま', () => {
    expect(sortOperandsMeshFirst('"B"[Mesh]')).toBe('"B"[Mesh]');
    expect(sortOperandsMeshFirst('')).toBe('');
  });
});

describe('replaceMeshDescriptor', () => {
  test('下位への置換（絞り込み）: 起点語を同じ位置で差し替え、他は保持', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', 'Neurosurgeons')).toBe(
      '("Neurosurgeons"[Mesh] OR surgeon*[tiab])'
    );
  });

  test('上位への置換（広げる）も同じ仕組み', () => {
    const expr = '("Surgeons"[Mesh] OR surgeon*[tiab])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', 'Physicians')).toBe(
      '("Physicians"[Mesh] OR surgeon*[tiab])'
    );
  });

  test('差し替え先が既にあれば二重化せず起点だけ消す', () => {
    const expr = '("Surgeons"[Mesh] OR "Neurosurgeons"[Mesh] OR surgeon*[tiab])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', 'Neurosurgeons')).toBe(
      '("Neurosurgeons"[Mesh] OR surgeon*[tiab])'
    );
  });

  test('起点が式に無ければ OR 追加にフォールバック', () => {
    const expr = '(surgeon*[tiab])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', 'Neurosurgeons')).toBe(
      '(surgeon*[tiab] OR "Neurosurgeons"[Mesh])'
    );
  });

  test('起点と差し替え先が同じなら原文のまま', () => {
    const expr = '("Surgeons"[Mesh])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', 'surgeons')).toBe(expr);
  });

  test('空ラベルは無視', () => {
    const expr = '("Surgeons"[Mesh])';
    expect(replaceMeshDescriptor(expr, 'Surgeons', '  ')).toBe(expr);
  });
});
