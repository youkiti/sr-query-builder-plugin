import type { LlmApiLogEntry } from '@/domain/llmApiLog';
import { LlmProviderError, type ChatResponse, type LLMProvider } from './LLMProvider';
import { buildPromptSummary, withLogging } from './apiLogger';

function makeProvider(impl: LLMProvider['chat']): LLMProvider {
  return {
    providerId: 'gemini',
    model: 'gemini-2.5-pro',
    chat: impl,
  };
}

interface RecordedDeps {
  uploads: Array<{ filename: string; content: string }>;
  entries: LlmApiLogEntry[];
}

function makeDeps(now = '2026-04-18T00:00:00.000Z'): {
  deps: Parameters<typeof withLogging>[2];
  recorded: RecordedDeps;
} {
  const recorded: RecordedDeps = { uploads: [], entries: [] };
  let id = 0;
  return {
    recorded,
    deps: {
      uploadJson: async ({ filename, content }) => {
        recorded.uploads.push({ filename, content });
        return { webViewLink: `https://drive/${filename}` };
      },
      appendLogEntry: async (entry) => {
        recorded.entries.push(entry);
      },
      newUuid: () => {
        id += 1;
        return `log-${id}`;
      },
      now: () => now,
    },
  };
}

describe('buildPromptSummary', () => {
  test('ロール付きで連結し、空白を畳む', () => {
    expect(
      buildPromptSummary([
        { role: 'system', content: 'You are\nhelpful.' },
        { role: 'user', content: 'Hi' },
      ])
    ).toBe('[system] You are helpful. [user] Hi');
  });

  test('500 文字超は 499 + … で打ち切られる', () => {
    const long = 'a'.repeat(600);
    const summary = buildPromptSummary([{ role: 'user', content: long }]);
    expect(summary).toHaveLength(500);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('withLogging', () => {
  test('成功時に prompt / response を Drive に保存し、ログ行を追記する', async () => {
    const response: ChatResponse = {
      text: 'ok',
      tokensIn: 5,
      tokensOut: 7,
      raw: { candidates: ['x'] },
    };
    const provider = makeProvider(async () => response);
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'draft_block', deps);

    const result = await logged.chat([{ role: 'user', content: 'q' }]);
    expect(result).toBe(response);

    expect(recorded.uploads).toHaveLength(2);
    expect(recorded.uploads[0]?.filename).toBe('log-1.prompt.json');
    expect(recorded.uploads[1]?.filename).toBe('log-1.response.json');
    const responseUpload = JSON.parse(recorded.uploads[1]!.content);
    expect(responseUpload).toEqual({ candidates: ['x'] });

    expect(recorded.entries).toHaveLength(1);
    const entry = recorded.entries[0]!;
    expect(entry.logId).toBe('log-1');
    expect(entry.provider).toBe('gemini');
    expect(entry.model).toBe('gemini-2.5-pro');
    expect(entry.purpose).toBe('draft_block');
    expect(entry.tokensIn).toBe(5);
    expect(entry.tokensOut).toBe(7);
    // gemini-2.5-pro: 入力 $1.25 / 出力 $10.00 per 1M → 5*1.25/1e6 + 7*10/1e6
    expect(entry.costEstimateUsd).toBeCloseTo(5 * 1.25e-6 + 7 * 10e-6, 12);
    expect(entry.error).toBeNull();
    expect(entry.promptRef).toBe('https://drive/log-1.prompt.json');
    expect(entry.responseRef).toBe('https://drive/log-1.response.json');
    expect(entry.promptSummary).toContain('[user] q');
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('LlmProviderError 発生時もログを残し、例外を再 throw する', async () => {
    const provider = makeProvider(async () => {
      throw new LlmProviderError('boom', 'gemini', 503, 'overloaded');
    });
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'draft_block', deps);

    await expect(logged.chat([{ role: 'user', content: 'q' }])).rejects.toBeInstanceOf(
      LlmProviderError
    );
    expect(recorded.entries).toHaveLength(1);
    expect(recorded.entries[0]?.error).toContain('status=503');
    expect(recorded.entries[0]?.tokensIn).toBeNull();
    const responseUpload = JSON.parse(recorded.uploads[1]!.content);
    expect(responseUpload).toEqual({ error: expect.stringContaining('status=503') });
  });

  test('LlmProviderError の status=null は n/a として記録される', async () => {
    const provider = makeProvider(async () => {
      throw new LlmProviderError('network', 'gemini', null, '');
    });
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'other', deps);
    await expect(logged.chat([{ role: 'user', content: 'q' }])).rejects.toBeInstanceOf(
      LlmProviderError
    );
    expect(recorded.entries[0]?.error).toContain('status=n/a');
  });

  test('Error 以外の例外も文字列化される', async () => {
    const provider = makeProvider(async () => {
      throw 'string error';
    });
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'other', deps);
    await expect(logged.chat([{ role: 'user', content: 'q' }])).rejects.toBe('string error');
    expect(recorded.entries[0]?.error).toBe('string error');
  });

  test('一般 Error も文字列化される', async () => {
    const provider = makeProvider(async () => {
      throw new Error('unhandled');
    });
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'other', deps);
    await expect(logged.chat([{ role: 'user', content: 'q' }])).rejects.toThrow('unhandled');
    expect(recorded.entries[0]?.error).toBe('unhandled');
  });

  test('未知モデルは cost_estimate_usd が null（§10）', async () => {
    const provider: LLMProvider = {
      providerId: 'gemini',
      model: 'unknown-model-x',
      chat: async () => ({ text: 'ok', tokensIn: 100, tokensOut: 50, raw: {} }),
    };
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'other', deps);
    await logged.chat([{ role: 'user', content: 'q' }]);
    expect(recorded.entries[0]?.costEstimateUsd).toBeNull();
  });

  test('トークン数が両方 null なら cost_estimate_usd も null（§10）', async () => {
    const provider = makeProvider(async () => ({
      text: 'ok',
      tokensIn: null,
      tokensOut: null,
      raw: {},
    }));
    const { deps, recorded } = makeDeps();
    const logged = withLogging(provider, 'other', deps);
    await logged.chat([{ role: 'user', content: 'q' }]);
    expect(recorded.entries[0]?.costEstimateUsd).toBeNull();
  });

  test('既定 newUuid / now を使うラッパも作れる（差し替えなし）', async () => {
    const provider = makeProvider(async () => ({
      text: 'ok',
      tokensIn: null,
      tokensOut: null,
      raw: {},
    }));
    const logged = withLogging(provider, 'other', {
      uploadJson: async () => ({ webViewLink: '' }),
      appendLogEntry: async () => undefined,
    });
    await expect(logged.chat([{ role: 'user', content: 'q' }])).resolves.toMatchObject({
      text: 'ok',
    });
  });
});
