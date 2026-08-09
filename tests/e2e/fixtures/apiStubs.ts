/**
 * Playwright E2E で使う、外部 API（Sheets / Drive / NCBI / Gemini）向けの共通スタブ集。
 *
 * journey-*.spec.ts で `page.route()` の出し分けロジックが複数 spec にコピペされていたのを
 * 1 箇所に集約したもの。踏んだ罠と応答形は spec 実装コードを読み直さなくて済むよう、
 * ここに残す。
 *
 * ## Sheets の range エンコーディング
 * Sheets の range は `Tab!A1:Z` を `encodeURIComponent` したものなので URL 上では `!` が
 * `%21` になる。`page.route` のハンドラ側で decode してからタブ名を判定しないとマッチしない
 * （実際に踏んだ罠）。
 *
 * append 先になるタブは、初期 `tabs` にヘッダ行を含めて渡しておくこと。`formulaRepository.ts`
 * 等は `rows.slice(1)` でヘッダ行を読み飛ばす作りなので、ヘッダ無しタブに 1 行 append しただけ
 * だとその行がヘッダ扱いで読み飛ばされて消える。
 *
 * ## NCBI の応答形
 * esearch のレスポンス形は `{esearchresult: {count: "123", idlist: ["..."]}}`（count は文字列）。
 * efetch は PubMed XML。
 *
 * ## Gemini の応答形
 * Gemini のレスポンス形は
 * `{candidates:[{content:{parts:[{text}]}}], usageMetadata:{promptTokenCount, candidatesTokenCount}}`。
 * text の中身は skill が期待する JSON 文字列。
 *
 * ## skill の判別キー
 * skill の判別キー（プロンプトに載るスキーマのキー名）: block-designer=`concept_summary` /
 * mesh-suggester=`tag_syntax` / freeword-designer=`freewords` / improve-block=`proposed_expression` /
 * expand-query-for-recall=`additions` / pick-boundary-cases=`picks`。
 *
 * ## LLM を呼ぶフローの前提
 * LLM を呼ぶフローには `injectAppStub` の `extraStorage` に `'apiKeys.gemini'` を積む必要がある。
 *
 * ## 検証テクニック
 * ヘッダ右の `#app-context` に出る `累積 $x.xxxx` の変化で「全ビュー再描画が走ったこと」を
 * 観測できる。`src/lib/llm/pricing.ts` の料金表に `gemini-3.5-flash` が載っているので、
 * スタブの usageMetadata にトークン数を与えれば累積コストが動く。再描画に耐えるかを問う
 * 回帰テストで有効。
 *
 * ## 登録順序
 * `page.route()` は `page.goto()` より前に登録すること。
 */

import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface SheetsFake {
  tabs: Record<string, string[][]>;
}

export interface SheetsStubOptions {
  /** タブ名 → 初期データ（ヘッダ行含む二次元配列）。省略したタブは values:get で { values: [] } を返す */
  tabs?: Record<string, string[][]>;
  /** append を HTTP 500 + { error: { message } } で失敗させるタブ名の配列 */
  failAppendTabs?: string[];
  /** values:append 応答を遅らせる ms（「保存中…」等の中間状態を観測するため。既定 0） */
  appendDelayMs?: number;
}

/** 戻り値の SheetsFake.tabs は append で追記された行を含めて可変（テスト側から検査できる） */
export async function registerSheetsStub(
  page: Page,
  options: SheetsStubOptions = {}
): Promise<SheetsFake> {
  const fake: SheetsFake = {
    tabs: Object.fromEntries(
      Object.entries(options.tabs ?? {}).map(([tab, rows]) => [tab, rows.map((row) => [...row])])
    ),
  };
  const failAppendTabs = new Set(options.failAppendTabs ?? []);
  const appendDelayMs = options.appendDelayMs ?? 0;

  await page.route('**/sheets.googleapis.com/**', async (route) => {
    // range は `Tab!A1:Z` / `Tab!A1` を encodeURIComponent したもの（`!` が %21）なので
    // decode してからタブ名を取り出す。
    const url = decodeURIComponent(route.request().url());
    const tab = /\/values\/([^!]+)!/.exec(url)?.[1] ?? '';

    if (url.includes(':append')) {
      if (failAppendTabs.has(tab)) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: `${tab} への追記に失敗しました（stub）` } }),
        });
        return;
      }
      if (appendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, appendDelayMs));
      }
      const body = route.request().postDataJSON() as { values?: string[][] };
      const rows = (fake.tabs[tab] ??= []);
      rows.push(...(body.values ?? []));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ values: fake.tabs[tab] ?? [] }),
    });
  });

  return fake;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

/** www.googleapis.com 宛（LLM ログ payload アップロード等）を成功で返すだけ */
export async function registerDriveStub(page: Page): Promise<void> {
  await page.route('**/www.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive.example/x' }),
    });
  });
}

// ---------------------------------------------------------------------------
// NCBI
// ---------------------------------------------------------------------------

export interface NcbiStubOptions {
  /** esearch.fcgi の応答をクエリ文字列（decodeURIComponent 済み）から動的に組み立てる。省略時は { count: '0', idlist: [] } */
  esearch?: (decodedUrl: string) => { count: string; idlist: string[] };
  /** efetch.fcgi が返す PubMed XML 文字列。省略時は空の PubmedArticleSet */
  efetchXml?: string;
  /** esummary.fcgi の応答 JSON。省略時は { result: { uids: [] } } */
  esummary?: unknown;
}

const EMPTY_EFETCH_XML = '<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>';

export async function registerNcbiStub(page: Page, options: NcbiStubOptions = {}): Promise<void> {
  await page.route('**/eutils.ncbi.nlm.nih.gov/**', async (route) => {
    const url = decodeURIComponent(route.request().url());

    if (url.includes('efetch.fcgi')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/xml',
        body: options.efetchXml ?? EMPTY_EFETCH_XML,
      });
      return;
    }

    if (url.includes('esummary.fcgi')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(options.esummary ?? { result: { uids: [] } }),
      });
      return;
    }

    // esearch.fcgi（既定は他パターンにマッチしない場合のフォールバックとしても使う）
    const result = options.esearch?.(url) ?? { count: '0', idlist: [] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ esearchresult: result }),
    });
  });
}

// ---------------------------------------------------------------------------
// Gemini (LLM)
// ---------------------------------------------------------------------------

export type GeminiSkillName =
  | 'block-designer'
  | 'mesh-suggester'
  | 'freeword-designer'
  | 'improve-block'
  | 'expand-query-for-recall'
  | 'pick-boundary-cases';

/** skill 名 → プロンプト本文に載るスキーマの判別キー。上から順に判定する。 */
const SKILL_MARKERS: ReadonlyArray<[GeminiSkillName, string]> = [
  ['block-designer', 'concept_summary'],
  ['mesh-suggester', 'tag_syntax'],
  ['freeword-designer', 'freewords'],
  ['improve-block', 'proposed_expression'],
  ['expand-query-for-recall', 'additions'],
  ['pick-boundary-cases', 'picks'],
];

/**
 * `route.request().postData()` が返す生の body（JSON.stringify 済み文字列）から、
 * GeminiProvider が組み立てた `contents[].parts[].text` と
 * `systemInstruction.parts[].text` を全部連結した「復号済みプロンプト全文」を作る。
 *
 * 生 body に対して素の部分文字列一致で skill 判別すると、(a) 自由文中の英単語
 * （"additions" 等）と衝突しうる、(b) マーカーはプロンプト中に `"picks"` のように
 * 引用符付きキーとして現れるが、生 body ではその引用符が `\"picks\"` にエスケープ
 * されていて素の marker が一致しない、という 2 つの罠がある。JSON.parse して
 * デコードしてから引用符付きで照合することでどちらも避けられる。
 */
function decodeGeminiPrompt(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as {
      contents?: Array<{ parts?: Array<{ text?: string }> }>;
      systemInstruction?: { parts?: Array<{ text?: string }> };
    };
    const texts: string[] = [];
    for (const content of parsed.contents ?? []) {
      for (const part of content.parts ?? []) {
        if (typeof part.text === 'string') texts.push(part.text);
      }
    }
    for (const part of parsed.systemInstruction?.parts ?? []) {
      if (typeof part.text === 'string') texts.push(part.text);
    }
    return texts.join('\n');
  } catch {
    // JSON.parse に失敗した場合（想定外の body 形）は生 body をそのまま返す。
    // ここで素の marker（引用符なし）に判定を緩めると自由文との誤衝突が復活してしまうため、
    // 呼び出し側（detectSkill）は失敗時も同じ `"marker"` 判定のまま通す＝「賭けに出て誤判定
    // するくらいなら判別失敗として fail closed し、診断可能な 500 で落とす」方針を取る。
    return rawBody;
  }
}

function detectSkill(decodedPrompt: string): GeminiSkillName | null {
  for (const [skill, marker] of SKILL_MARKERS) {
    if (decodedPrompt.includes(`"${marker}"`)) return skill;
  }
  return null;
}

export interface GeminiStubOptions {
  /** skill 名 → 返す JSON オブジェクト、または復号済みプロンプト全文を受け取って JSON オブジェクトを返す関数 */
  responses: Partial<Record<GeminiSkillName, unknown | ((decodedPrompt: string) => unknown)>>;
  /** usageMetadata。既定 { promptTokenCount: 300, candidatesTokenCount: 150 } */
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export async function registerGeminiStub(page: Page, options: GeminiStubOptions): Promise<void> {
  const usage = {
    promptTokenCount: options.usage?.promptTokenCount ?? 300,
    candidatesTokenCount: options.usage?.candidatesTokenCount ?? 150,
  };

  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    const rawBody = route.request().postData() ?? '';
    const decodedPrompt = decodeGeminiPrompt(rawBody);
    const skill = detectSkill(decodedPrompt);
    if (skill === null) {
      const message =
        `registerGeminiStub: プロンプト本文から skill を判別できませんでした` +
        `（判別キーが見つからない）。 prompt(先頭200文字)=${decodedPrompt.slice(0, 200)}`;
      console.error(message);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message } }),
      });
      return;
    }
    const responder = options.responses[skill];
    if (responder === undefined) {
      const message =
        `registerGeminiStub: skill "${skill}" 用の応答が responses に登録されていません。` +
        ` prompt(先頭200文字)=${decodedPrompt.slice(0, 200)}`;
      console.error(message);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message } }),
      });
      return;
    }
    const json =
      typeof responder === 'function'
        ? (responder as (decodedPrompt: string) => unknown)(decodedPrompt)
        : responder;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
        usageMetadata: usage,
      }),
    });
  });
}
