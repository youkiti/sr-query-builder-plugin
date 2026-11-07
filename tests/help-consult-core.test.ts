// 検索の重み・モデル選択と、選択および回答の送信範囲を検証する。
import type { LlmProviderId } from '../src/domain/llmApiLog';
import { BUILTIN_MODELS } from '../src/lib/llm/modelRegistry';
import { chooseConsultProvider, CONSULT_MODELS } from '../src/lib/help-consult/model';
import { buildAnswerPrompt, buildSelectionPrompt, HELP_CONSULT_PROMPT_VERSION, validateSelectedIds } from '../src/lib/help-consult/prompt';
import { searchHelpSections } from '../src/lib/help-consult/search';
import { loadHelpSections } from '../src/lib/help-consult/load';
import type { HelpSection } from '../src/lib/help-consult/types';

const sections: HelpSection[] = ['a', 'b', 'c', 'd'].map(id => ({
  id, kind: 'section', title: '見出し' + id, body: '本文' + id, when: ['困ったとき'], sectionId: 'group', sectionTitle: '章',
}));

test('全キー組合せで現在の実効モデルの社を優先し、なければ既定順に選ぶ', () => {
  const priority = ['anthropic', 'gemini', 'openrouter'] as const;
  for (let mask = 0; mask < 8; mask++) {
    const configured = priority.filter((_, index) => mask & (1 << index));
    const keys = new Set<LlmProviderId>([...configured, 'openai']);
    for (const [provider, model] of Object.entries(CONSULT_MODELS)) {
      expect(chooseConsultProvider(keys, model)).toBe(configured.find(id => id === provider) ?? configured[0] ?? null);
      expect(BUILTIN_MODELS).toContainEqual(expect.objectContaining({ id: model, provider }));
    }
    expect(chooseConsultProvider(keys)).toBe(configured[0] ?? null);
    expect(chooseConsultProvider(keys, null)).toBe(configured[0] ?? null);
  }
});

test('日本語と英語の検索は正規化し、こんなとき・見出し・本文の順に重み付けする', () => {
  const data = sections.map((section, index) => ({
    ...section, title: index === 1 ? '保存 Upload' : '', when: index === 2 ? ['保存 Upload'] : [],
    body: index === 0 ? '保存 Upload' : '',
  }));
  expect(searchHelpSections(data, '保存 ＵＰＬＯＡＤ').map(section => section.id)).toEqual(['c', 'b', 'a']);
  expect(searchHelpSections(data, 'upload', 1).map(section => section.id)).toEqual(['c']);
  for (const query of ['', '   ', '無関係', 'uploads']) {
    expect(searchHelpSections(data, query)).toEqual([]);
  }
  for (const limit of [0, -1, NaN, Infinity]) {
    expect(searchHelpSections(data, '保存', limit)).toEqual([]);
  }
});

test.each([
  ['ja', 'Word 文書を取り込む', 'faq-docx-import'],
  ['en', 'import Word docx', 'faq-docx-import'],
] as const)('実物の %s の質問で対応する小節が上位に来る', async (lang, question, id) => {
  expect(searchHelpSections(await loadHelpSections(lang), question).map(section => section.id)).toContain(id);
});

test('選択は本文を送らず、回答は選んだ見出しと本文だけを渡す', () => {
  const selection = buildSelectionPrompt(sections, '質問');
  expect(JSON.stringify(selection)).not.toContain('本文a');
  expect(JSON.parse(selection.messages[1]!.content)).toEqual({
    question: '質問',
    sections: sections.map(({ id, title, sectionTitle, when }) => ({ id, title, sectionTitle, when })),
  });
  expect(selection.responseSchema).toMatchObject({ additionalProperties: false, required: ['sectionIds'] });
  expect(HELP_CONSULT_PROMPT_VERSION).toBe('help-consult-v1');
  for (const lang of ['ja', 'en'] as const) {
    const answer = buildAnswerPrompt([sections[0]!], '質問', lang);
    const instruction = answer[0]!.content;
    expect(instruction).toContain('SR Query Builder Plugin');
    expect(instruction).not.toMatch(/https?:/);
    expect(instruction).toContain(lang === 'ja' ? '日本語で' : 'Answer in English');
    if (lang === 'en') {
      expect(instruction).not.toMatch(/[ぁ-んァ-ヶ]/);
    }
    expect(JSON.parse(answer[1]!.content)).toEqual({ question: '質問', sections: [{ title: '見出しa', body: '本文a' }] });
  }
  expect(buildAnswerPrompt(sections, '', 'ja')[0]!.content).not.toBe(buildAnswerPrompt(sections, '', 'en')[0]!.content);
});

test('未知と重複の ID を除き最大三つにする', () => {
  expect(validateSelectedIds('{"sectionIds":["unknown","b","b","a","c","d"]}', sections))
    .toEqual({ status: 'success', sectionIds: ['b', 'a', 'c'] });
  expect(validateSelectedIds({ sectionIds: [] }, sections)).toEqual({ status: 'success', sectionIds: [] });
  for (const value of ['not JSON', 'null', '{}', '{"sectionIds":"a"}', { sectionIds: [1] }, [], null]) {
    expect(validateSelectedIds(value, sections)).toEqual({ status: 'failure', kind: 'invalid_response' });
  }
});
