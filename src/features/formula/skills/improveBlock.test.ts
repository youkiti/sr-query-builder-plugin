import type { ChatMessage, LLMProvider } from '@/lib/llm';
import { MAX_IMPROVE_HISTORY_TURNS, improveBlockExpression, type ImproveBlockTurn } from './improveBlock';

function provider(text: string): { provider: LLMProvider; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    provider: {
      providerId: 'gemini',
      model: 'test',
      chat: async (messages) => {
        calls.push([...messages]);
        return { text, tokensIn: null, tokensOut: null, raw: {} };
      },
    },
  };
}

describe('improveBlockExpression', () => {
  test('提案 expression と rationale を返す（前後空白を trim）', async () => {
    const json = JSON.stringify({
      proposed_expression: '  "diabetes mellitus"[Mesh] OR diabetic*[tiab]  ',
      rationale: '子孫 MeSH を吸収するため階層上位を採用',
    });
    const { provider: p } = provider(json);
    const result = await improveBlockExpression(
      {
        currentExpression: 'diabetes[tiab]',
        blockLabel: 'Population',
        blockDescription: '糖尿病',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    expect(result).toEqual({
      proposedExpression: '"diabetes mellitus"[Mesh] OR diabetic*[tiab]',
      rationale: '子孫 MeSH を吸収するため階層上位を採用',
    });
  });

  test('プロンプトに現式 / label / description / RQ が埋め込まれる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'metformin[tiab]',
        blockLabel: 'Intervention',
        blockDescription: '経口糖尿病薬',
        researchQuestion: 'Metformin vs sulfonylurea',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('metformin[tiab]');
    expect(userMsg).toContain('Intervention');
    expect(userMsg).toContain('経口糖尿病薬');
    expect(userMsg).toContain('Metformin vs sulfonylurea');
    expect(userMsg).not.toContain('{{CURRENT}}');
  });

  test('空の description は「(不明)」で補完される', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: '',
        blockDescription: '',
        researchQuestion: '',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(不明)');
  });

  test('欠落フィールドは空文字で埋める', async () => {
    const { provider: p } = provider('{}');
    const result = await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    expect(result).toEqual({ proposedExpression: '', rationale: '' });
  });

  test('ユーザー指示・シード論文・検証捕捉情報がプロンプトに載る', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'asthma[tiab]',
        blockLabel: 'Population',
        blockDescription: '喘息',
        researchQuestion: 'RQ',
        userInstruction: '同義語をもっと増やして',
        seedPapers: [
          {
            pmid: '111',
            title: 'Seed A',
            decision: 'include',
            meshHeadings: ['Asthma', 'Respiratory Sounds'],
            abstract: 'Wheezing is a hallmark of asthma.',
          },
          { pmid: '222', title: 'Seed B', decision: '(未判定)' },
        ],
        validation: {
          captureRate: 0.5,
          capturedPmids: ['111'],
          missedPmids: ['222'],
        },
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('同義語をもっと増やして');
    expect(userMsg).toContain('PMID 111 [include]: Seed A');
    expect(userMsg).toContain('PMID 222 [(未判定)]: Seed B');
    // MeSH・抄録のある seed では同じ項目内に添えられる
    expect(userMsg).toContain('MeSH: Asthma; Respiratory Sounds');
    expect(userMsg).toContain('抄録: Wheezing is a hallmark of asthma.');
    expect(userMsg).toContain('捕捉率: 50%');
    expect(userMsg).toContain('取りこぼし PMID: 222');
  });

  test('指示が空ならプレースホルダ、シード・検証が無ければ (なし) / (未検証)', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
        userInstruction: '   ',
        seedPapers: [],
        validation: null,
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('(特になし／おまかせで改善してよい)');
    expect(userMsg).toContain('(なし)');
    expect(userMsg).toContain('(未検証)');
  });

  test('現在のヒット数が桁区切りでプロンプトに載る', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'asthma[tiab]',
        currentHits: 12345,
        blockLabel: 'Population',
        blockDescription: '喘息',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('現在のヒット数（PubMed esearch）: 12,345 件');
  });

  test('currentHits 未指定・null なら (未計測)', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        currentHits: null,
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('現在のヒット数（PubMed esearch）: (未計測)');
  });

  test('キーワード別ヒット数が箇条書きで載り、0 件は注記される', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'asthma[tiab]',
        keywordHits: [
          { term: 'Asthma', kind: 'mesh', hits: 120000 },
          { term: 'wheeze[tiab]', kind: 'freeword', hits: 0 },
          { term: 'foo[tiab]', kind: 'freeword', hits: null },
        ],
        blockLabel: 'Population',
        blockDescription: '喘息',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('キーワード別ヒット数（単体）:');
    expect(userMsg).toContain('- Asthma [MeSH]: 120,000 件');
    expect(userMsg).toContain('- wheeze[tiab] [tiab]: 0 件 ⚠ 0件（綴り/語形を確認）');
    expect(userMsg).toContain('- foo[tiab] [tiab]: (未計測)');
  });

  test('フリーワードは Δ・削除候補/低収量・OR 合計まで載る', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: '(surgeon*[tiab] OR neurosurgeon*[tiab] OR general surgeon*[tiab])',
        keywordHits: [
          { term: 'surgeon*[tiab]', kind: 'freeword', hits: 298342, delta: 298342, status: 'normal' },
          { term: 'neurosurgeon*[tiab]', kind: 'freeword', hits: 15305, delta: 12237, status: 'normal' },
          { term: 'general surgeon*[tiab]', kind: 'freeword', hits: 5036, delta: 0, status: 'redundant' },
          { term: 'surgical fellow*[tiab]', kind: 'freeword', hits: 254, delta: 110, status: 'lowYield' },
        ],
        freewordDedupTotal: 314637,
        blockLabel: 'Population',
        blockDescription: '外科医',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('- surgeon*[tiab] [tiab]: 298,342 件・純増Δ +298,342');
    expect(userMsg).toContain('- general surgeon*[tiab] [tiab]: 5,036 件・純増Δ +0 ⚠ 他語に内包＝削除候補');
    expect(userMsg).toContain('- surgical fellow*[tiab] [tiab]: 254 件・純増Δ +110 △ ほぼ寄与なし');
    expect(userMsg).toContain('（フリーワード OR 合計・重複除去後: 314,637 件）');
  });

  test('keywordHits が無ければ (未計測)', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('キーワード別ヒット数（単体）:\n(未計測)');
  });

  test('他ブロック（siblingBlocks）が ID・ラベル・式・共有語つきで箇条書きに載る（issue #89）', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: '"Asthma"[Mesh] OR asthma*[tiab]',
        blockLabel: 'Population',
        blockDescription: '喘息',
        researchQuestion: 'RQ',
        userInstruction: '#1 と重複するキーワードを消して',
        siblingBlocks: [
          {
            id: '2',
            label: 'Outcome',
            expression: '"Asthma"[Mesh] OR hospitalization[tiab]',
            sharedTerms: [{ term: 'Asthma', kind: 'mesh' }],
          },
        ],
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('他ブロック（掛け合わせる相手）:');
    expect(userMsg).toContain('- #2 Outcome: "Asthma"[Mesh] OR hospitalization[tiab]');
    expect(userMsg).toContain('共有語: Asthma');
  });

  test('共有語が完全一致で見つからない兄弟も渡り、「(完全一致の重複なし)」と出る（issue #89 must-fix）', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'asthma[tiab]',
        blockLabel: 'Population',
        blockDescription: '喘息',
        researchQuestion: 'RQ',
        userInstruction: '#2 と重複するキーワードを消して',
        siblingBlocks: [
          // タグ違い（asthma[tw] vs asthma[tiab]）で完全一致しないため sharedTerms は空。
          { id: '2', label: 'Outcome', expression: 'asthma[tw]', sharedTerms: [] },
        ],
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('- #2 Outcome: asthma[tw]');
    expect(userMsg).toContain('共有語: (完全一致の重複なし)');
  });

  test('siblingBlocks が無ければ (渡されていない)', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression(
      {
        currentExpression: 'x',
        blockLabel: 'L',
        blockDescription: 'D',
        researchQuestion: 'RQ',
        userInstruction: '',
      },
      p
    );
    const userMsg = calls[0]!.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('他ブロック（掛け合わせる相手）:\n(渡されていない)');
  });
});

describe('improveBlockExpression の会話継続（issue #90）', () => {
  const baseInput = {
    currentExpression: 'asthma[tiab]',
    blockLabel: 'Population',
    blockDescription: '喘息',
    researchQuestion: 'RQ',
  };

  test('history 省略・空配列なら従来どおり [system, user] の 2 メッセージだけになる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    await improveBlockExpression({ ...baseInput, userInstruction: '同義語を増やして' }, p);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]![0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(calls[0]![1]!.role).toBe('user');
    expect(calls[0]![1]!.content).toContain('同義語を増やして');

    const { provider: p2, calls: calls2 } = provider(JSON.stringify({}));
    await improveBlockExpression(
      { ...baseInput, userInstruction: '同義語を増やして', history: [] },
      p2
    );
    expect(calls2[0]).toHaveLength(2);
  });

  test('history 有り: 先頭 user に最初の turn の指示が載り、以後 model/user が交互に積まれる', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    const history: ImproveBlockTurn[] = [
      { instruction: '同義語を増やして', proposedExpression: 'asthma[tiab] OR wheeze[tiab]', rationale: '同義語追加' },
    ];
    await improveBlockExpression(
      { ...baseInput, userInstruction: 'wheeze はやりすぎ、消して', history },
      p
    );
    const messages = calls[0]!;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    // 文脈テンプレートは先頭側の user に 1 度だけ載り、{{INSTRUCTION}} には最初の turn の指示が入る
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('同義語を増やして');
    expect(messages[1]!.content).not.toContain('wheeze はやりすぎ');
    // model には turn の提案が JSON として積まれる
    expect(messages[2]).toEqual({
      role: 'model',
      content: JSON.stringify({
        proposed_expression: 'asthma[tiab] OR wheeze[tiab]',
        rationale: '同義語追加',
      }),
    });
    // 最後の user には今回の userInstruction が積まれる
    expect(messages[3]).toEqual({ role: 'user', content: 'wheeze はやりすぎ、消して' });
  });

  test('history 2 turn: model/user が turn ごとに交互に積まれ、末尾に今回の指示が載る', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    const history: ImproveBlockTurn[] = [
      { instruction: '同義語を増やして', proposedExpression: 'P1', rationale: 'R1' },
      { instruction: 'MeSH も足して', proposedExpression: 'P2', rationale: 'R2' },
    ];
    await improveBlockExpression({ ...baseInput, userInstruction: 'もう十分', history }, p);
    const messages = calls[0]!;
    // system, user(turn1指示), model(turn1提案), user(turn2指示), model(turn2提案), user(今回の指示)
    expect(messages).toHaveLength(6);
    expect(messages[1]!.content).toContain('同義語を増やして');
    expect(messages[2]).toEqual({
      role: 'model',
      content: JSON.stringify({ proposed_expression: 'P1', rationale: 'R1' }),
    });
    expect(messages[3]).toEqual({ role: 'user', content: 'MeSH も足して' });
    expect(messages[4]).toEqual({
      role: 'model',
      content: JSON.stringify({ proposed_expression: 'P2', rationale: 'R2' }),
    });
    expect(messages[5]).toEqual({ role: 'user', content: 'もう十分' });
  });

  test(`history が上限（${MAX_IMPROVE_HISTORY_TURNS} turn）を超えると新しい方から残り、文脈テンプレートは残った最古の turn の指示になる`, async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    const history: ImproveBlockTurn[] = Array.from({ length: MAX_IMPROVE_HISTORY_TURNS + 2 }, (_, i) => ({
      instruction: `指示${i + 1}`,
      proposedExpression: `P${i + 1}`,
      rationale: `R${i + 1}`,
    }));
    await improveBlockExpression({ ...baseInput, userInstruction: '最終指示', history }, p);
    const messages = calls[0]!;
    // system + (user, model) × MAX_IMPROVE_HISTORY_TURNS + user(最終指示)
    expect(messages).toHaveLength(1 + MAX_IMPROVE_HISTORY_TURNS * 2 + 1);
    // 切り詰め後、残った最古の turn（history[2]。0-indexed で「指示3」）が先頭側の user に載る
    expect(messages[1]!.content).toContain('指示3');
    expect(messages[1]!.content).not.toContain('指示1');
    expect(messages[1]!.content).not.toContain('指示2');
    // 最初に切り捨てられた turn（指示1・指示2 の提案）は model メッセージとしても出てこない
    expect(messages.some((m) => m.role === 'model' && m.content.includes('"P1"'))).toBe(false);
    expect(messages.some((m) => m.role === 'model' && m.content.includes('"P2"'))).toBe(false);
    // 残った最古の turn（指示3・P3）は model として出てくる
    expect(messages.some((m) => m.role === 'model' && m.content.includes('"P3"'))).toBe(true);
    // 末尾は今回の指示
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '最終指示' });
  });

  test('指示が空文字の turn はプレースホルダに整形される（model/user とも）', async () => {
    const { provider: p, calls } = provider(JSON.stringify({}));
    const history: ImproveBlockTurn[] = [
      { instruction: '  ', proposedExpression: 'P1', rationale: 'R1' },
    ];
    await improveBlockExpression({ ...baseInput, userInstruction: '   ', history }, p);
    const messages = calls[0]!;
    expect(messages[1]!.content).toContain('(特になし／おまかせで改善してよい)');
    expect(messages[3]).toEqual({
      role: 'user',
      content: '(特になし／おまかせで改善してよい)',
    });
  });
});
