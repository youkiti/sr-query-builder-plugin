import {
  normalizeCombinationExpression,
  tokenizeCombination,
  validateCombinationExpression,
  validateGrammar,
  validateParens,
  validateReferences,
} from './parse';

describe('tokenizeCombination', () => {
  test('単純な #1 AND #2 をトークン化する', () => {
    const { tokens, errors } = tokenizeCombination('#1 AND #2');
    expect(errors).toEqual([]);
    expect(tokens).toEqual([
      { kind: 'ref', id: '1', raw: '#1', position: 0 },
      { kind: 'op', op: 'AND', raw: 'AND', position: 3 },
      { kind: 'ref', id: '2', raw: '#2', position: 7 },
    ]);
  });

  test('括弧と演算子をトークン化する', () => {
    const { tokens } = tokenizeCombination('(#1 OR #2) AND NOT #3');
    expect(tokens.map((t) => t.kind)).toEqual([
      'lparen',
      'ref',
      'op',
      'ref',
      'rparen',
      'op',
      'op',
      'ref',
    ]);
  });

  test('小文字 and / not / or も認識する', () => {
    const { tokens } = tokenizeCombination('#1 and not #2');
    expect(tokens.map((t) => t.kind === 'op' ? t.op : t.kind)).toEqual([
      'ref',
      'AND',
      'NOT',
      'ref',
    ]);
  });

  test('英数字混在の id（#RCTfilter）も認識する', () => {
    const { tokens } = tokenizeCombination('#1 AND #RCTfilter');
    expect(tokens[2]).toMatchObject({ kind: 'ref', id: 'RCTfilter' });
  });

  test('未知のキーワード（XOR）はエラー', () => {
    const { errors } = tokenizeCombination('#1 XOR #2');
    expect(errors[0]?.message).toContain('XOR');
  });

  test('不正文字（@）はエラー', () => {
    const { errors } = tokenizeCombination('#1 @ #2');
    expect(errors[0]?.message).toContain('@');
  });
});

describe('validateParens', () => {
  test('対応した括弧は OK', () => {
    const { tokens } = tokenizeCombination('(#1 AND (#2 OR #3))');
    expect(validateParens(tokens)).toEqual([]);
  });

  test('閉じ括弧が無いと検出', () => {
    const { tokens } = tokenizeCombination('(#1 AND #2');
    const errors = validateParens(tokens);
    expect(errors[0]?.message).toContain('不足');
  });

  test('開き括弧無しの ) は検出', () => {
    const { tokens } = tokenizeCombination('#1 AND #2)');
    const errors = validateParens(tokens);
    expect(errors[0]?.message).toContain('対応する');
  });
});

describe('validateGrammar', () => {
  test('正しい構文はエラー無し', () => {
    const { tokens } = tokenizeCombination('#1 AND NOT #2');
    expect(validateGrammar(tokens)).toEqual([]);
  });

  test('空入力はエラー無し', () => {
    expect(validateGrammar([])).toEqual([]);
  });

  test('先頭の二項演算子（AND）はエラー', () => {
    const { tokens } = tokenizeCombination('AND #1');
    expect(validateGrammar(tokens)[0]?.message).toContain('先頭');
  });

  test('先頭の NOT は許可', () => {
    const { tokens } = tokenizeCombination('NOT #1');
    expect(validateGrammar(tokens)).toEqual([]);
  });

  test('被演算子が連続するとエラー', () => {
    const { tokens } = tokenizeCombination('#1 #2');
    const errors = validateGrammar(tokens);
    expect(errors[0]?.message).toContain('連続');
  });

  test('演算子が連続するとエラー（AND OR）', () => {
    const { tokens } = tokenizeCombination('#1 AND OR #2');
    expect(validateGrammar(tokens)[0]?.message).toContain('連続');
  });

  test('AND NOT の連続は許可', () => {
    const { tokens } = tokenizeCombination('#1 AND NOT #2');
    expect(validateGrammar(tokens)).toEqual([]);
  });

  test('末尾が演算子だとエラー', () => {
    const { tokens } = tokenizeCombination('#1 AND');
    expect(validateGrammar(tokens)[0]?.message).toContain('末尾');
  });
});

describe('validateReferences', () => {
  test('既知 id だけならエラー無し', () => {
    const { tokens } = tokenizeCombination('#1 AND #RCTfilter');
    expect(validateReferences(tokens, new Set(['1', 'RCTfilter']))).toEqual([]);
  });

  test('未定義 id を検出', () => {
    const { tokens } = tokenizeCombination('#1 AND #99');
    const errors = validateReferences(tokens, new Set(['1']));
    expect(errors[0]?.message).toContain('#99');
  });
});

describe('validateCombinationExpression', () => {
  test('全エラーを集約する', () => {
    const result = validateCombinationExpression('#1 AND (#7 OR XOR', new Set(['1']));
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('XOR'))).toBe(true);
    expect(messages.some((m) => m.includes('不足'))).toBe(true);
    expect(messages.some((m) => m.includes('#7'))).toBe(true);
  });

  test('正常な式はエラー 0', () => {
    const result = validateCombinationExpression(
      '(#1 AND #2) OR #3',
      new Set(['1', '2', '3'])
    );
    expect(result.errors).toEqual([]);
  });
});

describe('normalizeCombinationExpression', () => {
  test('連続空白を 1 つに、前後を trim', () => {
    expect(normalizeCombinationExpression('  #1   AND\n#2  ')).toBe('#1 AND #2');
  });
});
