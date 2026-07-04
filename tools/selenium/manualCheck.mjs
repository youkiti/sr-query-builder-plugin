// 実機確認の半自動ハーネス（docs/manual-testing.md の Selenium 版）。
//
// 方針: Selenium が「操作 + 検証」を自動化し、人にしかできない箇所
// （Google ログイン / OAuth 同意 / API キー入力）だけコンソールで一時停止して
// ユーザーに委ねる。jest / Playwright（すべて stub）ではカバーできない
// 「本物の Chrome + 本物の Google API + 本物の Gemini / NCBI」の結合部を通す
// ためのツールであり、CI では実行しない。
//
// 前提（Chrome 137+ は --load-extension が使えないため、プロファイル方式を採る）:
//   1. npm run dev（dist/ を生成。.env の OAUTH_CLIENT_ID 必須）
//   2. node tools/selenium/manualCheck.mjs prepare
//      → 専用プロファイル（.selenium-profile/）の Chrome が開くので、
//        chrome://extensions でデベロッパーモード → dist/ を手動で 1 回読み込み、
//        Google アカウントにログインしておく（以後のセッションで再利用される）
//   3. node tools/selenium/manualCheck.mjs
//      → login → project → options → protocol → blocks → draft → export を順に実行
//
// 個別実行: node tools/selenium/manualCheck.mjs export
// PR #19（Methods 文案）確認: node tools/selenium/manualCheck.mjs export modelswitch editmodel
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIST_DIR = path.join(ROOT, 'dist');
const PROFILE_DIR = path.join(ROOT, '.selenium-profile');

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function log(message) {
  console.log(message);
}

function ok(message) {
  console.log(`  ✔ ${message}`);
}

function ng(message) {
  console.log(`  ✘ ${message}`);
}

/** コンソールで Enter を待つ（ログイン・同意などの手動ステップ） */
function pause(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n>>> ${message}\n>>> 済んだら Enter: `, () => {
      rl.close();
      resolve();
    });
  });
}

/** manifest.json の key（固定公開鍵）から拡張 ID を導出する（SHA-256 先頭 16 バイト → a-p） */
function computeExtensionId() {
  const manifestPath = existsSync(path.join(DIST_DIR, 'manifest.json'))
    ? path.join(DIST_DIR, 'manifest.json')
    : path.join(ROOT, 'src', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string' || manifest.key === '') {
    throw new Error('manifest.json に key がありません（拡張 ID を固定できません）');
  }
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

const EXTENSION_ID = computeExtensionId();
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup/popup.html`;
const APP_URL = `chrome-extension://${EXTENSION_ID}/app/app.html`;
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options/options.html`;

// LLM 実弾（ブロック抽出 / 検索式生成）の完了待ち上限
const LLM_TIMEOUT = 15 * 60 * 1000;
// ユーザー操作（キー入力・API キー入力など）の待ち上限
const USER_ACTION_TIMEOUT = 30 * 60 * 1000;

// S4 で保存するサンプルプロトコル（extract-protocol がこの raw text を読む）
const SAMPLE_PROTOCOL = `# 実機確認用プロトコル（サンプル）

## リサーチクエスチョン
成人の 2 型糖尿病患者において、SGLT2 阻害薬はプラセボと比較して心血管イベントを減らすか。

- P: 成人の 2 型糖尿病患者
- I: SGLT2 阻害薬
- C: プラセボまたは通常治療
- O: 主要心血管イベント（MACE）、心不全入院

## 組入基準
- ランダム化比較試験（RCT）
- 成人（18 歳以上）

## 除外基準
- 1 型糖尿病
- 動物実験
`;

/**
 * 再描画による stale element を吸収して読み直す。
 * app のビューはストア更新のたびに DOM を丸ごと作り直す（replaceChildren / innerHTML）ため、
 * 要素の取得〜読み取りの間に再描画が挟まると stale になる。読み取りを 1 つの
 * クロージャにまとめてリトライする
 */
async function retryOnStale(fn, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (i >= attempts - 1 || !message.includes('stale element')) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/** 表示中の要素を 1 つ返す（見つからなければ null） */
async function findVisible(driver, selector) {
  for (const element of await driver.findElements(By.css(selector))) {
    if (await element.isDisplayed().catch(() => false)) {
      return element;
    }
  }
  return null;
}

/**
 * 値を設定して input / change を発火する（Playwright の fill 相当）。
 * 長文の sendKeys を避けつつ、input 購読・submit 時読み取りの両方の実装に効かせる
 */
async function setValue(driver, element, value) {
  await driver.executeScript(
    'const el = arguments[0]; el.value = arguments[1];' +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "el.dispatchEvent(new Event('change', { bubbles: true }));",
    element,
    value,
  );
}

/** いずれかのセレクタが表示されるまで待ち、一致したセレクタ文字列を返す */
async function waitForAnyVisible(driver, selectors, timeoutMs, what) {
  let matched = null;
  await driver.wait(
    async () => {
      for (const selector of selectors) {
        if ((await findVisible(driver, selector)) !== null) {
          matched = selector;
          return true;
        }
      }
      return false;
    },
    timeoutMs,
    what,
  );
  return matched;
}

/** 要素のテキストを返す（stale・不在は空文字扱い） */
async function textOf(driver, selector) {
  return retryOnStale(async () => {
    const element = await findVisible(driver, selector);
    return element === null ? '' : (await element.getText()).trim();
  }).catch(() => '');
}

/** すべての一致要素のテキストを配列で返す（stale は再取得） */
async function textsOf(driver, selector) {
  return retryOnStale(async () => {
    const elements = await driver.findElements(By.css(selector));
    return Promise.all(elements.map((el) => el.getText()));
  }).catch(() => []);
}

/**
 * 既に開いている app.html のタブへ切り替え、#/home をフル読み込みして
 * bootstrap（Sheets からの hydration 込み）を通してから目的の hash へ遷移する。
 * ガード付きルート（draft / export など）を直接フル読み込みすると、hydration 前の
 * ガード判定で描画されないため、#/home を経由して store 復元を待ってから hash を変える。
 * hydration が setState を発火すると現在ルートは再描画されるので、目的ルートで
 * 前提が満たされ次第そのビューが出る
 */
async function switchToApp(driver, hash) {
  const handles = await driver.getAllWindowHandles();
  let found = false;
  for (const handle of handles) {
    await driver.switchTo().window(handle);
    if ((await driver.getCurrentUrl()).startsWith(APP_URL)) {
      found = true;
      break;
    }
  }
  if (!found) {
    // app タブが無ければ現在のタブで開く（project シーン未実行時の保険）
    await driver.switchTo().window(handles[0]);
  }
  await driver.get(`${APP_URL}#/home`);
  await driver.wait(
    async () => (await findVisible(driver, '.home__summary')) !== null,
    60000,
    '#/home が表示されません',
  );
  if (hash !== '#/home') {
    await driver.executeScript('location.hash = arguments[0];', hash);
  }
}

/**
 * beforeHandles に無い新規タブのうち、URL が prefix で始まるものが開くのを待って
 * そのハンドルを返す（切替えた状態で返る）。
 */
async function waitForWindowWithUrl(driver, beforeHandles, prefix, timeoutMs, what) {
  const checked = new Set(beforeHandles);
  let found = null;
  await driver.wait(
    async () => {
      for (const handle of await driver.getAllWindowHandles()) {
        if (checked.has(handle)) {
          continue;
        }
        checked.add(handle);
        try {
          await driver.switchTo().window(handle);
          if ((await driver.getCurrentUrl()).startsWith(prefix)) {
            found = handle;
            return true;
          }
        } catch {
          // 確認中に閉じられたタブは無視する
        }
      }
      return false;
    },
    timeoutMs,
    `${what} のタブが開きません`,
  );
  return found;
}

// ---------------------------------------------------------------------------
// シーン
// ---------------------------------------------------------------------------

async function scenePrepare(driver) {
  log('\n[prepare] 専用プロファイルの初期設定（初回のみ）');
  log(`  拡張 ID（manifest key から導出。読み込み後に一致すること）: ${EXTENSION_ID}`);
  log(`  dist: ${DIST_DIR}`);
  await driver.get('chrome://extensions');
  await pause(
    [
      '開いた Chrome で次を実施してください:',
      '  1. chrome://extensions 右上の「デベロッパーモード」を ON',
      `  2. 「パッケージ化されていない拡張機能を読み込む」で ${DIST_DIR} を選択`,
      '  3. 別タブで https://accounts.google.com を開き、確認用 Google アカウントにログイン',
      '     （OAuth 同意画面が Testing の場合はテストユーザーに登録済みのアカウント）',
    ].join('\n'),
  );
  await driver.get(POPUP_URL);
  try {
    await driver.wait(until.elementLocated(By.css('#popup-status')), 5000);
    ok(`拡張を検出しました（${EXTENSION_ID}）。プロファイルは ${PROFILE_DIR} に永続化されます`);
  } catch {
    ng('拡張が読み込まれていません。dist/ の読み込みと拡張 ID を確認してください');
    throw new Error('prepare 未完了');
  }
}

async function sceneLogin(driver) {
  log('\n[login] Popup ログイン');
  await driver.get(POPUP_URL);
  await driver.wait(until.elementLocated(By.css('#popup-status')), 10000);
  await driver.wait(
    async () =>
      (await findVisible(driver, '#popup-auth')) !== null ||
      (await findVisible(driver, '#popup-projects')) !== null,
    15000,
    'Popup の認証状態が確定しません',
  );
  if ((await findVisible(driver, '#popup-projects')) !== null) {
    ok(`ログイン済み: ${await textOf(driver, '#popup-email')}`);
    return;
  }
  await driver.findElement(By.css('#login-button')).click();
  log('  OAuth 同意画面が開きます。承認してください（最大 5 分待機）…');
  await driver.wait(
    async () => (await findVisible(driver, '#popup-projects')) !== null,
    5 * 60 * 1000,
    'ログインが完了しません（#popup-projects が表示されない）',
  );
  const email = await textOf(driver, '#popup-email');
  if (email === '' || email === '—') {
    ng('ログイン後のメールアドレスが表示されていません');
  } else {
    ok(`ログイン成功: ${email}`);
  }
  const error = await textOf(driver, '#login-error');
  if (error !== '') {
    ng(`ログインエラー表示: ${error}`);
    throw new Error('login 失敗');
  }
}

async function sceneProject(driver) {
  log('\n[project] 新規プロジェクト作成');
  await driver.get(POPUP_URL);
  await driver.wait(
    async () => (await findVisible(driver, '#popup-projects')) !== null,
    15000,
    '未ログインです。先に login シーンを実行してください',
  );
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const title = `実機確認 ${stamp}`;
  const before = await driver.getAllWindowHandles();
  await driver.findElement(By.css('#popup-create-title')).sendKeys(title);
  await driver.findElement(By.css('#popup-create-form button[type=submit]')).click();
  log(`  「${title}」を作成中（Sheets タブ + Drive フォルダ生成。1 分程度かかります）…`);
  await waitForWindowWithUrl(driver, before, APP_URL, 3 * 60 * 1000, 'メインビュー');
  await switchToApp(driver, '#/home');
  const homeText = await textOf(driver, '#app-content');
  if (homeText.includes('現在のプロジェクト:') && !homeText.includes('プロジェクトが選択されていません')) {
    ok(`プロジェクト作成 → メインビュー表示: ${homeText.split('\n')[0]}`);
  } else {
    ng('メインビューにプロジェクト名が出ません');
    throw new Error('project 失敗');
  }
}

async function sceneOptions(driver) {
  log('\n[options] Gemini API キーの保存 + モデル選択');
  await driver.get(OPTIONS_URL);
  await driver.wait(until.elementLocated(By.css('#options-status')), 10000);
  await driver.wait(async () => {
    const text = await textOf(driver, '#options-status');
    return text !== '' && !text.includes('読み込み中');
  }, 15000, 'Options の状態が確定しません');

  const modelSelect = await findVisible(driver, '#llm-model-select');
  if (modelSelect !== null) {
    const model = (await modelSelect.getAttribute('value')) ?? '';
    ok(`使用モデル（llm-model-select）: ${model === '' ? '(未選択)' : model}`);
  }

  const status = await textOf(driver, '#options-status');
  if (status.includes('保存済み') || status.includes('設定済み')) {
    ok(`API キーは保存済みです（${status}）`);
    return;
  }
  log('\n>>> 開いた Options 画面で Gemini API キーを入力し「保存」を押してください');
  log('>>> （「保存しました。」の表示を自動検知します。キーの値はログに出しません）');
  await driver.wait(async () => {
    const text = await textOf(driver, '#options-status');
    return text.includes('保存しました');
  }, USER_ACTION_TIMEOUT, 'API キーが保存されません');
  ok('Gemini API キーを保存しました');
}

async function sceneProtocol(driver) {
  log('\n[protocol] プロトコル入力 → ブロック抽出（LLM）');
  await switchToApp(driver, '#/protocol');
  const state = await waitForAnyVisible(
    driver,
    ['.protocol__form', '.protocol__readonly', '.protocol__error', '.view__placeholder'],
    30000,
    '#/protocol が表示されません',
  );
  if (state === '.view__placeholder') {
    ng(`プロトコル画面がガード状態です: ${await textOf(driver, '.view__placeholder')}`);
    throw new Error('protocol 失敗');
  }
  if (state === '.protocol__readonly') {
    ok(`既に保存済み: ${(await textOf(driver, '.protocol__summary')).replace(/\s+/g, ' ').slice(0, 80)}`);
    return;
  }
  // 手入力ラジオは既定で checked。textarea#inline に本文を入れて submit
  const manualRadio = await findVisible(driver, 'input[name=sourceMode][value=manual]');
  if (manualRadio !== null && !(await manualRadio.isSelected())) {
    await manualRadio.click();
  }
  await setValue(driver, await driver.findElement(By.css('textarea#inline')), SAMPLE_PROTOCOL);
  await driver.findElement(By.css('.protocol__submit')).click();
  log('  プロトコル保存 + ブロック抽出中（extract-protocol の LLM 実弾。数十秒かかります）…');
  const result = await waitForAnyVisible(
    driver,
    ['.protocol__readonly', '.protocol__error'],
    LLM_TIMEOUT,
    'プロトコルの保存が完了しません',
  );
  if (result === '.protocol__error') {
    ng(`保存エラー: ${await textOf(driver, '.protocol__error')}`);
    throw new Error('protocol 失敗');
  }
  ok(`保存完了（読み取り専用へ遷移）: ${(await textOf(driver, '.protocol__summary')).replace(/\s+/g, ' ').slice(0, 80)}`);
}

async function sceneBlocks(driver) {
  log('\n[blocks] ブロック承認');
  await switchToApp(driver, '#/blocks');
  const state = await waitForAnyVisible(
    driver,
    ['.blocks__list', '.blocks__error', '.view__placeholder'],
    60000,
    '#/blocks が表示されません',
  );
  if (state === '.view__placeholder') {
    ng(`ブロック画面がガード状態です: ${await textOf(driver, '.view__placeholder')}（先に protocol を実行）`);
    throw new Error('blocks 失敗');
  }
  const items = await driver.findElements(By.css('.blocks__item'));
  ok(`抽出ブロック: ${items.length} 個`);
  if (items.length === 0) {
    ng('ブロックが 0 個です（extract-protocol の結果が空）');
    throw new Error('blocks 失敗');
  }
  const approve = await driver.wait(
    until.elementLocated(By.css('.blocks__btn-primary')),
    15000,
  );
  if (!(await approve.isEnabled())) {
    ng(`承認ボタンが無効です: ${await textOf(driver, '.blocks__approve-reason')}`);
    throw new Error('blocks 失敗');
  }
  await approve.click();
  log('  承認して次へ（Protocol / ProtocolBlocks を Sheets に追記）…');
  // 承認後は #/seeds へ遷移する。遷移 or エラーを待つ
  await driver.wait(
    async () =>
      (await findVisible(driver, '.blocks__error')) !== null ||
      !(await driver.getCurrentUrl()).includes('#/blocks'),
    60000,
    '承認処理が完了しません',
  );
  const err = await textOf(driver, '.blocks__error');
  if (err !== '') {
    ng(`承認エラー: ${err}`);
    throw new Error('blocks 失敗');
  }
  ok('ブロック承認完了（次のルートへ遷移）');
}

async function sceneDraft(driver) {
  log('\n[draft] 検索式の生成 → 検証');
  await switchToApp(driver, '#/draft');
  const state = await waitForAnyVisible(
    driver,
    ['.draft__actions', '.view__placeholder'],
    30000,
    '#/draft が表示されません',
  );
  if (state === '.view__placeholder') {
    ng(`検索式画面がガード状態です: ${await textOf(driver, '.view__placeholder')}（先に blocks を承認）`);
    throw new Error('draft 失敗');
  }
  const generate = await driver.findElement(By.css('.draft__actions button'));
  await generate.click();
  log('  「生成して検証する」実行中（LLM でブロック展開 → NCBI でヒット数 → 捕捉率検証。数分かかります）…');
  // 生成完了 = 検証ステータスが出る or エラー。生成ボタンが「再生成」に戻ることでも判定
  await driver.wait(
    async () => {
      if ((await findVisible(driver, '.draft__error')) !== null) {
        return true;
      }
      if ((await findVisible(driver, '.draft__validate-status')) !== null) {
        return true;
      }
      const btn = await findVisible(driver, '.draft__actions button');
      if (btn !== null) {
        const label = (await btn.getText()).trim();
        return label.includes('再生成');
      }
      return false;
    },
    LLM_TIMEOUT,
    '生成・検証が完了しません',
  );
  const error = await textOf(driver, '.draft__error');
  if (error !== '') {
    ng(`生成・検証エラー: ${error}`);
    throw new Error('draft 失敗');
  }
  const hits = await textsOf(driver, '.draft__block-hits li');
  for (const hit of hits) {
    ok(`ヒット数: ${hit.replace(/\s+/g, ' ')}`);
  }
  const summary = await textOf(driver, '.draft__validate-status');
  if (summary !== '') {
    ok(`検証サマリ: ${summary.replace(/\s+/g, ' ')}`);
  }
  ok('検索式の生成・検証が完了しました');
}

/** #/export の Methods 文案（英語）のフルテキストを返す（無ければ空） */
async function readMethodsEnglish(driver) {
  const texts = await textsOf(driver, '.export__methods-text');
  return texts.length > 0 ? texts[0].trim() : '';
}

/** Methods 文案の中身を検証して英語テキストを返す */
async function assertMethods(driver, { expectLegacy = false } = {}) {
  const texts = await driver.findElements(By.css('.export__methods-text'));
  if (texts.length !== 2) {
    ng(`Methods 文案が 2 本（英日）ありません（${texts.length} 本）`);
    throw new Error('export 失敗');
  }
  const en = (await texts[0].getText()).trim();
  const ja = (await texts[1].getText()).trim();
  const note = await textOf(driver, '.export__methods-note');

  // 拡張バージョン（manifest.version = package.json 由来）が埋まっていること
  if (/version\s+\d+\.\d+\.\d+/.test(en)) {
    ok(`英語文にバージョンが埋め込み済み: ${en.match(/version\s+\d+\.\d+\.\d+/)[0]}`);
  } else {
    ng('英語文に version が埋まっていません');
  }

  if (expectLegacy) {
    // 旧プロジェクト（model 列導入前）: プレースホルダが残り、note が置換案内を出す
    if (en.includes('{AI model}') || ja.includes('{AI モデル名}')) {
      ok('旧バージョン: {AI model} プレースホルダが残っています（想定どおり）');
    } else {
      ng('旧バージョンなのにプレースホルダが残っていません');
    }
    if (note.includes('置き換え')) {
      ok('note に手動置換の案内が出ています');
    } else {
      ng('note に置換案内が出ていません');
    }
  } else {
    // 現行: 実際に生成に使ったモデル ID が埋まり、プレースホルダは残らない
    if (en.includes('{AI model}')) {
      ng('英語文に {AI model} プレースホルダが残っています（モデル ID 未記録の可能性）');
    } else {
      ok('英語文に {AI model} プレースホルダは残っていません');
    }
    ok(`英語文（先頭 120 字）: ${en.slice(0, 120).replace(/\s+/g, ' ')}…`);
  }
  return en;
}

async function sceneExport(driver) {
  log('\n[export] Methods 文案（PR #19）+ 4 DB 変換');
  await switchToApp(driver, '#/export');
  const state = await waitForAnyVisible(
    driver,
    ['.export__methods', '.export__actions', '.view__placeholder'],
    60000,
    '#/export が表示されません',
  );
  if (state === '.view__placeholder') {
    ng(`エクスポート画面がガード状態です: ${await textOf(driver, '.view__placeholder')}（先に draft を実行）`);
    throw new Error('export 失敗');
  }
  // 手順1: モデル ID + バージョン埋め込み
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    30000,
    'Methods 文案が表示されません',
  );
  await assertMethods(driver);

  // 手順2: コピーボタン → クリップボード
  const copyButtons = await driver.findElements(By.css('.export__methods-copy'));
  if (copyButtons.length >= 1) {
    await copyButtons[0].click();
    await driver.wait(async () => {
      const s = await textOf(driver, '.export__methods-status');
      return s.includes('コピーしました');
    }, 10000, 'コピー成功メッセージが出ません');
    ok(`コピー成功メッセージ: ${await textOf(driver, '.export__methods-status')}`);
    const clip = await driver
      .executeScript('return navigator.clipboard.readText();')
      .catch(() => null);
    if (typeof clip === 'string' && clip.length > 0) {
      ok(`クリップボードに ${clip.length} 文字入りました（先頭: ${clip.slice(0, 40).replace(/\s+/g, ' ')}…）`);
    } else {
      log('  （クリップボード読み取りは権限により取得不可。UI メッセージで確認済み）');
    }
  }
  log('  → FormulaVersions タブ末尾の model 列（手順7）は Sheets 側で目視確認してください');
}

async function sceneReload(driver) {
  log('\n[reload] リロード後にモデル ID が Sheets から復元されるか（手順3）');
  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'Methods 文案が表示されません',
  );
  const before = await readMethodsEnglish(driver);
  // フル再読み込み（新しい bootstrap → Sheets hydration）
  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'リロード後に Methods 文案が表示されません',
  );
  const after = await assertMethods(driver);
  if (after.includes('{AI model}')) {
    ng('リロード後にモデル ID が失われ、プレースホルダに戻りました');
    throw new Error('reload 失敗');
  }
  if (before === after) {
    ok('リロード前後で Methods 文案（モデル ID 込み）が一致（Sheets から復元）');
  } else {
    log('  ⚠ リロード前後でテキストに差分があります（モデル ID 部分を目視で確認してください）');
  }
}

async function sceneModelSwitch(driver) {
  log('\n[modelswitch] Options でモデル変更後も文案は「生成時のまま」か（手順4・今回の肝）');
  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'Methods 文案が表示されません',
  );
  const before = await readMethodsEnglish(driver);
  ok(`変更前の文案（先頭 80 字）: ${before.slice(0, 80).replace(/\s+/g, ' ')}…`);

  // Options で別モデルへ切替 → 保存
  await driver.get(OPTIONS_URL);
  await driver.wait(until.elementLocated(By.css('#llm-model-select')), 10000);
  const select = await driver.findElement(By.css('#llm-model-select'));
  const options = await select.findElements(By.css('option'));
  const current = (await select.getAttribute('value')) ?? '';
  let switched = null;
  for (const opt of options) {
    const value = (await opt.getAttribute('value')) ?? '';
    if (value !== '' && value !== current && !(await opt.getAttribute('disabled'))) {
      switched = value;
      break;
    }
  }
  if (switched === null) {
    log('  選択肢が 1 つしかないためモデル切替はスキップ（比較のみ実施）');
  } else {
    await setValue(driver, select, switched);
    const saveBtn = await findVisible(driver, '#save-keys');
    if (saveBtn !== null) {
      await saveBtn.click();
      await driver.wait(async () => {
        const s = await textOf(driver, '#options-status');
        return s.includes('保存しました') || s.includes('保存済み');
      }, 15000, 'モデル切替が保存されません').catch(() => undefined);
    }
    ok(`Options のモデルを ${current || '(未選択)'} → ${switched} に切替えて保存`);
  }

  // export に戻って文案が変わっていないこと（生成時のモデルのまま）
  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'Methods 文案が表示されません',
  );
  const after = await readMethodsEnglish(driver);
  if (before === after) {
    ok('Options のモデルを変えても文案は生成時のまま（PR #19 の「正確に」を確認）');
  } else {
    ng('Options 変更後に文案が変わってしまいました（生成時のモデルが固定されていない）');
    log(`    before: ${before.slice(0, 120)}`);
    log(`    after : ${after.slice(0, 120)}`);
    throw new Error('modelswitch 失敗');
  }
}

async function sceneEditModel(driver) {
  log('\n[editmodel] #/edit で手編集して保存 → 文案のモデル ID が引き継がれるか（手順5）');
  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'Methods 文案が表示されません',
  );
  const before = await readMethodsEnglish(driver);

  await switchToApp(driver, '#/edit');
  const state = await waitForAnyVisible(
    driver,
    ['.edit__actions', '.view__placeholder'],
    30000,
    '#/edit が表示されません',
  );
  if (state === '.view__placeholder') {
    ng(`編集画面がガード状態です: ${await textOf(driver, '.view__placeholder')}`);
    throw new Error('editmodel 失敗');
  }
  const note = await findVisible(driver, '.edit__note-input');
  if (note !== null) {
    await setValue(driver, note, '実機確認: モデル引き継ぎテスト');
  }
  const saveBtn = await driver.findElement(By.css('.edit__actions button'));
  await saveBtn.click();
  log('  「新バージョンとして保存」実行中…');
  await driver.wait(
    async () =>
      (await findVisible(driver, '.edit__error')) !== null ||
      (await textOf(driver, '.edit__status')).includes('保存') ||
      !(await driver.getCurrentUrl()).includes('#/edit'),
    60000,
    '保存が完了しません',
  );
  const err = await textOf(driver, '.edit__error');
  if (err !== '') {
    ng(`保存エラー: ${err}`);
    throw new Error('editmodel 失敗');
  }
  ok('手編集を新バージョンとして保存しました');

  await switchToApp(driver, '#/export');
  await driver.wait(
    async () => (await findVisible(driver, '.export__methods-text')) !== null,
    60000,
    'Methods 文案が表示されません',
  );
  const after = await assertMethods(driver);
  if (after.includes('{AI model}')) {
    ng('編集後にモデル ID がプレースホルダに戻りました（親ドラフトから引き継がれていない）');
    throw new Error('editmodel 失敗');
  }
  if (before === after) {
    ok('編集後もモデル ID が元ドラフトのまま引き継がれています');
  } else {
    log('  ⚠ 編集前後で文案に差分あり（モデル ID 部分が一致しているか目視確認してください）');
  }
}

const SCENES = {
  prepare: scenePrepare,
  login: sceneLogin,
  project: sceneProject,
  options: sceneOptions,
  protocol: sceneProtocol,
  blocks: sceneBlocks,
  draft: sceneDraft,
  export: sceneExport,
  reload: sceneReload,
  modelswitch: sceneModelSwitch,
  editmodel: sceneEditModel,
};

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = process.argv.slice(2);
  const keep = rawArgs.includes('--keep');
  // --auto: stdin を使わない（別プロセスからの起動用）。失敗時は一時停止せず
  // スクリーンショット + DOM を .selenium-profile/ へ保存して終了する
  const auto = rawArgs.includes('--auto');
  const args = rawArgs.filter((a) => !a.startsWith('--'));
  const names =
    args.length > 0
      ? args
      : ['login', 'project', 'options', 'protocol', 'blocks', 'draft', 'export'];
  for (const name of names) {
    if (!(name in SCENES)) {
      console.error(`未知のシーン: ${name}（使用可能: ${Object.keys(SCENES).join(' / ')}）`);
      process.exit(1);
    }
  }
  if (!existsSync(path.join(DIST_DIR, 'manifest.json'))) {
    console.error('dist/ がありません。先に npm run dev を実行してください');
    process.exit(1);
  }
  const distManifest = JSON.parse(readFileSync(path.join(DIST_DIR, 'manifest.json'), 'utf8'));
  if (distManifest.oauth2?.client_id?.includes('__OAUTH_CLIENT_ID__')) {
    console.error('dist/manifest.json の client_id が未設定です。.env を設定して npm run dev し直してください');
    process.exit(1);
  }

  log(`拡張 ID: ${EXTENSION_ID}`);
  log(`プロファイル: ${PROFILE_DIR}`);
  log(`実行シーン: ${names.join(' → ')}`);
  log('（このプロファイルの Chrome が既に開いている場合は先に閉じてください）');

  const options = new chrome.Options().addArguments(
    `--user-data-dir=${PROFILE_DIR}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,1000',
  );
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  let failed = false;
  try {
    for (const name of names) {
      await SCENES[name](driver);
    }
    log('\nすべてのシーンが完了しました。');
  } catch (err) {
    failed = true;
    console.error(`\n中断: ${err instanceof Error ? err.message : String(err)}`);
    console.error('結果は docs/manual-testing.md の結果メモに記録してください。');
    if (auto) {
      try {
        writeFileSync(
          path.join(PROFILE_DIR, 'last-failure.png'),
          await driver.takeScreenshot(),
          'base64',
        );
        writeFileSync(path.join(PROFILE_DIR, 'last-failure.html'), await driver.getPageSource());
        console.error(`失敗時の状態を保存しました: ${path.join(PROFILE_DIR, 'last-failure.png')} / .html`);
      } catch {
        // 取得できない状態（ブラウザごと落ちた等）は諦める
      }
    }
  } finally {
    if (!auto && (keep || failed)) {
      await pause('ブラウザを開いたままにしています。目視確認が済んだら Enter で終了します');
    }
    await driver.quit().catch(() => undefined);
  }
  process.exit(failed ? 1 : 0);
}

void main();
