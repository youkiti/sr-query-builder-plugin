import { EutilsError } from '../../../lib/ncbi/eutils';
import { parsePubmedFormulaMd } from '../../../lib/search-formula-md';
import { createAgentDraftTools, type AgentDraftDeps } from './tools';

const md = (lines: string) => `## PubMed/MEDLINE\n\n\`\`\`\n${lines}\n\`\`\`\n`;
const content = md('#2 treatment[tiab]\n#1 disease[tiab]');
const approval = { blockIds: ['1', '2'], filters: [{ blockId: 'RCTfilter', expression: 'trial[pt]' }],
  combinationExpression: '#1 AND #2 AND #RCTfilter' };
function setup(limits = {}) {
  const deps: jest.Mocked<AgentDraftDeps> = {
    count: jest.fn().mockResolvedValue(12),
    resolveMesh: jest.fn().mockResolvedValue(new Map([['term', { status: 'resolved', headings: ['Heading'] }]])),
    meshTrees: jest.fn().mockResolvedValue({ trees: new Map([['Heading', ['A01']]]), reasons: new Map() }),
  };
  const tools = createAgentDraftTools(approval, deps, limits);
  return { tools, deps };
}

test('書く前は案内だけを返し、check は予算を使わない', async () => {
  const { tools } = setup();
  expect(await tools.call('check')).toBe('先に write_formula で formula.md を書いてください');
  expect(tools.writeFormula(content)).toBe(`formula.md を書きました（${content.length} 文字）`);
  expect(await tools.call('check')).toBe('検査に通りました\n[終了コード 0]');
  expect(tools.state).toMatchObject({ formula: content, measurements: 0, submissions: 0 });
});

test('count は全体・概念・フィルタ・結合行を測り、測定を一度だけ数える', async () => {
  const { tools, deps } = setup();
  tools.writeFormula(content);
  expect(await tools.call('count')).toBe('全体: 12 件\n#1: 12 件\n#2: 12 件\n#RCTfilter: 12 件\n#3: 12 件\n[終了コード 0]');
  expect(deps.count.mock.calls.map(([query]) => query)).toEqual([
    '(disease[tiab]) AND (treatment[tiab]) AND (trial[pt])',
    'disease[tiab]', 'treatment[tiab]', 'trial[pt]', '(disease[tiab]) AND (treatment[tiab]) AND (trial[pt])',
  ]);
  expect(tools.state).toMatchObject({ measurements: 1, submissions: 0 });
});

test('提出は測定せず、承認順に組み立てた最新の提出を保持する', async () => {
  const { tools, deps } = setup();
  tools.writeFormula(content);
  expect(await tools.call('submit')).toBe('提出 1 を受け付けました\n[終了コード 0]');
  const accepted = tools.state.acceptedSubmission!;
  expect(parsePubmedFormulaMd(accepted.md).blocks.map((block) => block.id)).toEqual(['1', '2', 'RCTfilter', '3']);
  expect(accepted.md).toBe(md('#1 disease[tiab]\n#2 treatment[tiab]\n#RCTfilter trial[pt]\n#3 #1 AND #2 AND #RCTfilter'));
  expect(deps.count).not.toHaveBeenCalled();
  tools.writeFormula(md('#1 other[tiab]\n#2 treatment[tiab]'));
  expect(await tools.call('submit')).toContain('提出 2 を受け付けました');
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 2, acceptedSubmission: { number: 2 } });
});

test.each([
  ['#1 a', '#2: 承認済みのブロックの行がありません'],
  ['#1 a\n#2 b\n#3 c', '#3: 承認済みのブロックではありません'],
  ['#1 a\n#1 b\n#2 c', '#1: 行が重複しています'],
  ['#1 #2\n#2 c', '#1: 行の中で他の行を参照できません'],
])('承認内容との不一致を拒否する: %s', async (lines, reason) => {
  const { tools } = setup();
  tools.writeFormula(md(lines));
  expect(await tools.call('check')).toBe(`${reason}\n[終了コード 1]`);
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 0 });
  expect(await tools.call('submit')).toBe(`${reason}\n[終了コード 1]`);
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 1, acceptedSubmission: null });
});

test('検査で拒否した提出も数え、以前に受け付けた提出は保持する', async () => {
  const { tools } = setup({ maxSubmissions: 2 });
  tools.writeFormula(content);
  await tools.call('submit');
  const accepted = tools.state.acceptedSubmission;
  tools.writeFormula(md('#1 (a\n#2 b'));
  expect(await tools.call('submit')).toContain('#1: 括弧が対応していません\n[終了コード 1]');
  expect(tools.state.acceptedSubmission).toBe(accepted);
  expect(await tools.call('submit')).toBe('呼び出し回数の上限に達しています\n[終了コード 2]');
  expect(tools.state.submissions).toBe(2);
});

test.each(['AND', 'NOT'])('括弧なしの OR と %s の混在は検査不合格にする', async (operator) => {
  const { tools, deps } = setup();
  tools.writeFormula(md(`#1 aspirin[tiab] OR drug[tiab] ${operator} therapy[tiab]\n#2 disease[tiab]`));
  const reason = '#1: 括弧の無い AND / NOT と OR が同じ並びに混ざっています。括弧で囲んでください\n[終了コード 1]';
  expect(await tools.call('check')).toBe(reason);
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 0 });
  expect(await tools.call('submit')).toBe(reason);
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 1, acceptedSubmission: null });
  expect(deps.count).not.toHaveBeenCalled();
});

test.each(['(aspirin[tiab] OR drug[tiab]) AND therapy[tiab]', 'aspirin[tiab] OR drug[tiab]'])(
  '括弧で分けた行と OR だけの行を受け付け、フィルタと結合式は混在検査しない: %s', async (expression) => {
    const { deps } = setup();
    const tools = createAgentDraftTools({ ...approval,
      filters: [{ blockId: 'RCTfilter', expression: 'trial[pt] OR randomized[tiab] NOT (animals[mh] NOT (humans[mh] AND animals[mh]))' }],
      combinationExpression: '#1 OR #2 AND #RCTfilter',
    }, deps);
    tools.writeFormula(md(`#1 ${expression}\n#2 disease[tiab]`));
    expect(await tools.call('check')).toBe('検査に通りました\n[終了コード 0]');
    expect(await tools.call('submit')).toBe('提出 1 を受け付けました\n[終了コード 0]');
  }
);

test('測定上限と使えないコマンドは予算を使わない', async () => {
  const { tools } = setup({ maxMeasurements: 1 });
  expect(await tools.call('mesh', 'term')).toBe('正式な見出し: Heading\ntree number: A01\n[終了コード 0]');
  expect(await tools.call('mesh', 'term')).toBe('呼び出し回数の上限に達しています\n[終了コード 2]');
  expect(await tools.call('titles')).toBe('この版では使えないコマンドです\n[終了コード 2]');
  expect(tools.state).toMatchObject({ measurements: 1, submissions: 0 });
});

test.each([new EutilsError('構文エラー: bad', 400, true), new EutilsError('esearch in-band エラー', 200, true)])(
  'PubMed による式の拒否は測定を消費しない', async (error) => {
    const { tools, deps } = setup();
    tools.writeFormula(content);
    deps.count.mockRejectedValueOnce(error);
    expect(await tools.call('count')).toBe(`${error.message}\n[終了コード 1]`);
    expect(tools.state).toMatchObject({ measurements: 0, submissions: 0 });
  }
);

test.each([new Error('通信が失敗しました'), new Error('https://example.test/?api_key=secret'), 'secret'])(
  '通信失敗は回数を消費せず、URL・文字列例外は隠す', async (error) => {
    const { tools, deps } = setup();
    tools.writeFormula(content);
    deps.count.mockResolvedValueOnce(12).mockRejectedValueOnce(error);
    const output = await tools.call('count');
    expect(output).toContain('測定に失敗しました。回数は消費していません');
    expect(output).toContain('[終了コード 3]');
    expect(output).not.toMatch(/https|secret/);
    expect(tools.state.measurements).toBe(0);
  }
);

test('MeSH の引数なしと不明は消費せず、見出しなしは成功として数える', async () => {
  const { tools, deps } = setup();
  expect(await tools.call('mesh')).toBe('測定に失敗しました。回数は消費していません\nMeSH の語を 1 つ指定してください\n[終了コード 3]');
  deps.resolveMesh.mockResolvedValueOnce(new Map([['term', { status: 'unknown' }]]));
  expect(await tools.call('mesh', 'term')).toContain('MeSH の結果が不明です\n[終了コード 3]');
  expect(tools.state.measurements).toBe(0);
  deps.resolveMesh.mockResolvedValueOnce(new Map([['term', { status: 'missing' }]]));
  expect(await tools.call('mesh', 'term')).toBe('見出しは見つかりませんでした\n[終了コード 0]');
  expect(tools.state.measurements).toBe(1);
});

test('件数欠落は測定失敗として扱い、回数を消費しない', async () => {
  const { tools, deps } = setup();
  tools.writeFormula(content);
  deps.count.mockRejectedValueOnce(new EutilsError('esearch の件数が欠落しているか、不正な値です', 200, true));
  expect(await tools.call('count')).toBe('測定に失敗しました。回数は消費していません\nesearch の件数が欠落しているか、不正な値です\n[終了コード 3]');
  expect(tools.state).toMatchObject({ measurements: 0, submissions: 0 });
});
