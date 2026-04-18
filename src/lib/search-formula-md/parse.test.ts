import { FormulaParseError, parsePubmedFormulaMd } from './parse';

describe('parsePubmedFormulaMd', () => {
  test('単純な 3 ブロック構成をパースできる', () => {
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 "Diabetes Mellitus"[Mesh] OR diabetes[tiab]',
      '#2 "Metformin"[Mesh] OR metformin[tiab]',
      '#3 #1 AND #2',
      '```',
      '',
    ].join('\n');

    const result = parsePubmedFormulaMd(md);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]).toEqual({
      id: '1',
      expression: '"Diabetes Mellitus"[Mesh] OR diabetes[tiab]',
      isCombination: false,
    });
    expect(result.blocks[2]).toEqual({
      id: '3',
      expression: '#1 AND #2',
      isCombination: true,
    });
    expect(result.combinationExpression).toBe('#1 AND #2');
  });

  test('見出しが `## PubMed`（/MEDLINE なし）でもパースできる', () => {
    const md = '## PubMed\n\n```\n#1 foo\n```\n';
    expect(parsePubmedFormulaMd(md).blocks).toHaveLength(1);
  });

  test('名前付きブロック（#RCTfilter）を許可する', () => {
    const md = [
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 population[tiab]',
      '#2 intervention[tiab]',
      '#RCTfilter randomized[tiab] OR trial[tiab]',
      '#3 #1 AND #2 AND #RCTfilter',
      '```',
    ].join('\n');
    const result = parsePubmedFormulaMd(md);
    expect(result.blocks.map((b) => b.id)).toEqual(['1', '2', 'RCTfilter', '3']);
    expect(result.blocks[3]?.isCombination).toBe(true);
    expect(result.combinationExpression).toBe('#1 AND #2 AND #RCTfilter');
  });

  test('複数セクションがあっても PubMed セクションのみを対象にする', () => {
    const md = [
      '# Title',
      '',
      '## PubMed/MEDLINE',
      '',
      '```',
      '#1 pubmed_expr',
      '```',
      '',
      '## Cochrane CENTRAL',
      '',
      '```',
      '#1 central_expr',
      '```',
      '',
    ].join('\n');
    const result = parsePubmedFormulaMd(md);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.expression).toBe('pubmed_expr');
  });

  test('コードブロック内の空行は無視する', () => {
    const md = ['## PubMed', '', '```', '#1 a', '', '#2 b', '```'].join('\n');
    expect(parsePubmedFormulaMd(md).blocks).toHaveLength(2);
  });

  test('自己参照のみの行は isCombination=false', () => {
    const md = '## PubMed\n\n```\n#1 #1 OR #1\n```';
    const result = parsePubmedFormulaMd(md);
    expect(result.blocks[0]?.isCombination).toBe(false);
    expect(result.combinationExpression).toBeNull();
  });

  test('存在しないブロック ID への参照は isCombination に計上しない', () => {
    const md = '## PubMed\n\n```\n#1 "foo"[tiab] #99 legacy\n```';
    const result = parsePubmedFormulaMd(md);
    expect(result.blocks[0]?.isCombination).toBe(false);
  });

  test('空のコードブロックは blocks=[] を返す', () => {
    const md = '## PubMed\n\n```\n\n```\n';
    const result = parsePubmedFormulaMd(md);
    expect(result.blocks).toEqual([]);
    expect(result.combinationExpression).toBeNull();
  });

  test('PubMed セクションが無いと FormulaParseError', () => {
    expect(() => parsePubmedFormulaMd('## Other\n\n```\n#1 x\n```\n')).toThrow(FormulaParseError);
  });

  test('コードブロックが無いと FormulaParseError', () => {
    expect(() => parsePubmedFormulaMd('## PubMed\n\n本文だけ\n')).toThrow(FormulaParseError);
  });

  test('閉じフェンスが無いと FormulaParseError', () => {
    expect(() => parsePubmedFormulaMd('## PubMed\n\n```\n#1 foo\n')).toThrow(FormulaParseError);
  });

  test('#<id> 形式に合わない行があると FormulaParseError', () => {
    expect(() => parsePubmedFormulaMd('## PubMed\n\n```\nbroken\n```')).toThrow(FormulaParseError);
  });

  test('重複する ID は FormulaParseError', () => {
    const md = '## PubMed\n\n```\n#1 a\n#1 b\n```';
    expect(() => parsePubmedFormulaMd(md)).toThrow(/重複/);
  });

  test('FormulaParseError は name=FormulaParseError', () => {
    try {
      parsePubmedFormulaMd('no section here');
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaParseError);
      expect((e as Error).name).toBe('FormulaParseError');
      return;
    }
    throw new Error('should have thrown');
  });
});
