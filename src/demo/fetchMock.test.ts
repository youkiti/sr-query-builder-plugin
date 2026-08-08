import {
  demoFetch,
  installDemoFetch,
  resolveDemoLatencyFactor,
  setDemoLatencyFactor,
} from './fetchMock';
import { resetDemoBackend } from './sheetStore';

beforeEach(async () => {
  await resetDemoBackend();
});

// 人工レイテンシは既定 0（無効）。テストで有効化したら必ず戻す。
afterEach(() => {
  setDemoLatencyFactor(0);
});

describe('demoFetch', () => {
  it('未対応の URL には明示的なエラーを投げる（黙って実ネットワークに出ない）', async () => {
    await expect(demoFetch('https://example.com/unexpected')).rejects.toThrow(
      /未対応の fetch 先/
    );
  });

  it('OpenRouter 宛はデモ非対応である旨のエラーを投げる', async () => {
    await expect(
      demoFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' })
    ).rejects.toThrow(/OpenRouter/);
  });

  it('Sheets API 宛は sheetStore に委譲される', async () => {
    const res = await demoFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({ properties: { title: 'x' }, sheets: [{ properties: { title: 'A' } }] }),
    });
    const json = (await res.json()) as { spreadsheetId: string };
    expect(json.spreadsheetId).toBeTruthy();
  });

  it('NCBI E-utilities 宛は eutilsMock に委譲される', async () => {
    const res = await demoFetch(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=90000001%5Buid%5D&retmode=json&retmax=1'
    );
    const json = (await res.json()) as { esearchresult: { count: string } };
    expect(json.esearchresult.count).toBe('1');
  });

  it('Gemini 宛は llmFixtures に委譲される（未対応 system prompt は明示的にエラー）', async () => {
    await expect(
      demoFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=x', {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      })
    ).rejects.toThrow(/skill を判定できません/);
  });
});

describe('installDemoFetch', () => {
  it('globalThis.fetch を demoFetch に差し替える', () => {
    const original = globalThis.fetch;
    installDemoFetch();
    expect(globalThis.fetch).not.toBe(original);
    globalThis.fetch = original;
  });
});

describe('resolveDemoLatencyFactor', () => {
  it('demoLatency 未指定なら等倍（1）', () => {
    expect(resolveDemoLatencyFactor('')).toBe(1);
    expect(resolveDemoLatencyFactor('?demoSeed=07-draft')).toBe(1);
  });

  it('demoLatency=0 は無効化として 0 を返す', () => {
    expect(resolveDemoLatencyFactor('?demoLatency=0')).toBe(0);
  });

  it('倍率を指定できる', () => {
    expect(resolveDemoLatencyFactor('?demoSeed=07-draft&demoLatency=1.5')).toBe(1.5);
  });

  it('数値として読めない値・負値は等倍にフォールバックする', () => {
    expect(resolveDemoLatencyFactor('?demoLatency=abc')).toBe(1);
    expect(resolveDemoLatencyFactor('?demoLatency=-2')).toBe(1);
    expect(resolveDemoLatencyFactor('?demoLatency=')).toBe(1);
  });
});

describe('人工レイテンシ', () => {
  it('既定（倍率 0）では待たずに応答する', async () => {
    const startedAt = Date.now();
    await demoFetch(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=90000001%5Buid%5D&retmode=json&retmax=1'
    );
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it('倍率を設定すると E-utilities 応答が遅延する', async () => {
    setDemoLatencyFactor(1);
    const startedAt = Date.now();
    await demoFetch(
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=90000001%5Buid%5D&retmode=json&retmax=1'
    );
    // LATENCY_MS.eutils = 250ms。タイマー精度のぶん少し緩めに見る
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });
});
