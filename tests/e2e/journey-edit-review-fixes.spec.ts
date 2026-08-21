/**
 * PR #92 レビュー指摘 15 件のうち「人間がブラウザで手動確認する」ことになっていた 6 項目を、
 * Playwright で実ブラウザ（dev ビルド）に対して自動確認する回帰スペック。
 *
 * 既存の app-edit.spec.ts / journey-draft-generate.spec.ts / journey-edit-save.spec.ts の
 * 書き方・フィクスチャに合わせる。外部 API（LLM / Google / NCBI）はすべて
 * `tests/e2e/fixtures/apiStubs.ts` の共通スタブで止める（実 API は叩かない）。
 *
 * 実行: `E2E_PORT=4405 npx playwright test tests/e2e/journey-edit-review-fixes.spec.ts`
 * （他 worktree との webServer 衝突を避けるため既定ポート 4400 は使わないこと）。
 */

import { test, expect, type Page } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import {
  fullStateScenario,
  FULL_APP_STATE,
  FULL_PROTOCOL_DRAFT,
} from './fixtures/scenarios/fullState';
import {
  registerSheetsStub,
  registerDriveStub,
  registerNcbiStub,
  registerGeminiStub,
  type SheetsFake,
} from './fixtures/apiStubs';
import type { AppState } from '../../src/app/store';

const EDIT_URL = '/app/app.html#/edit';

/** SHEET_HEADERS.FormulaVersions と同じ列順（src/domain/sheetsSchema.ts）。formula_md は index 4。 */
const FORMULA_MD_COLUMN_INDEX = 4;

// ---------------------------------------------------------------------------
// 項目 1: #/blocks で小文字の結合式を入力しても、生成される検索式の最終行は大文字になる
// （issue #92 B-7 / assembleFormulaMd の正規化。CLAUDE.md にも実害が大きいと明記されている経路）
// ---------------------------------------------------------------------------

const SEED_PMID = '20000001';

const EFETCH_XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>${SEED_PMID}</PMID>
<Article><ArticleTitle>ECMO for ARDS in adults</ArticleTitle>
<Journal><JournalIssue><Year>2024</Year></JournalIssue></Journal>
<Abstract><AbstractText>Randomised trial of ECMO in adult ARDS.</AbstractText></Abstract></Article>
<MeshHeadingList><MeshHeading><DescriptorName>Respiratory Distress Syndrome</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

const BLOCK_DESIGNER_RESPONSE = {
  concept_summary: 'ARDS / ECMO の概念ブロック',
  mesh_requirements: ['Respiratory Distress Syndrome'],
  freeword_requirements: ['ARDS'],
  rationale: '主要概念を MeSH とフリーワードの両輪で拾う',
};

const MESH_SUGGESTER_RESPONSE = {
  suggestions: [
    {
      descriptor: 'Respiratory Distress Syndrome',
      tag_syntax: '"Respiratory Distress Syndrome"[Mesh]',
      rationale: '主要 MeSH',
    },
  ],
};

const FREEWORD_DESIGNER_RESPONSE = {
  freewords: [{ query: '"ARDS"[tiab]', rationale: '略語での表記' }],
};

/**
 * #/draft の「生成する」を実操作で通すためのスタブ一式（journey-draft-generate.spec.ts の
 * setupDraftScenario と同じ構成。同ファイルを変更しない方針のためこちらへ複製する）。
 * studyDesign は RCT フィルタが自動付加されない値にしておき、最終行（結合式）の期待値を
 * `#1 AND #2` だけに保つ（RCT だと `AND #RCTfilter` が末尾に追記され、期待値がぶれるため）。
 */
async function setupDraftGenerationScenario(page: Page): Promise<SheetsFake> {
  const fake = await registerSheetsStub(page, {
    tabs: {
      SeedPapers: [
        ['seed_id', 'pmid', 'title', 'source', 'is_valid', 'user_decision'],
        ['seed-1', SEED_PMID, 'ECMO for ARDS in adults', 'initial', 'TRUE', 'include'],
      ],
    },
  });

  await registerDriveStub(page);

  await registerNcbiStub(page, {
    efetchXml: EFETCH_XML,
    esearch: (decodedUrl) =>
      decodedUrl.includes(SEED_PMID)
        ? { count: '1', idlist: [SEED_PMID] }
        : { count: '250', idlist: [] },
  });

  await registerGeminiStub(page, {
    responses: {
      'block-designer': BLOCK_DESIGNER_RESPONSE,
      'mesh-suggester': MESH_SUGGESTER_RESPONSE,
      'freeword-designer': FREEWORD_DESIGNER_RESPONSE,
    },
  });

  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: {
        ...FULL_APP_STATE,
        currentFormulaMarkdown: null,
        protocolDraft: { ...FULL_PROTOCOL_DRAFT, studyDesign: 'observational cohort study' },
      },
      extraStorage: { 'apiKeys.gemini': 'dummy-key' },
    })
  );

  return fake;
}

test.describe('journey-edit-review-fixes: 1. #/blocks の小文字結合式 → 生成物は大文字（B-7）', () => {
  test('「結合式を編集」へ小文字 and を入力して生成すると、formula_md の最終行が大文字 AND になる', async ({
    page,
  }) => {
    const fake = await setupDraftGenerationScenario(page);
    await page.goto('/app/app.html#/blocks');

    const combinationInput = page.locator('.blocks__combination-input');
    await expect(combinationInput).toHaveValue('#1 AND #2');
    // 順序を入れ替えつつ小文字化する: 「たまたま元と同じ文字列に戻って正規化の有無が
    // 見分けられない」事故を避けるため。
    await combinationInput.fill('#2 and #1');
    await expect(combinationInput).toHaveValue('#2 and #1');

    // ページ遷移（location.hash 変更のみ、reload はしない）。#/blocks の変更は
    // store（in-memory）に残ったまま #/draft へ引き継がれる。
    await page.evaluate(() => {
      window.location.hash = '#/draft';
    });

    const generateBtn = page.locator('.draft__actions button').first();
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();
    await expect(page.locator('.draft__formula')).toBeVisible({ timeout: 30_000 });

    // 観測点 A: #/draft の画面表示（.draft__block--combination）。
    // assembleFormulaMd が組み立てた PubmedFormula を parsePubmedFormulaMd で再パースして
    // 描画したものなので、実際の生成経路（assembleFormulaMd を直接呼ばず、ボタン操作から
    // 辿った結果）を見ていることになる。
    await expect(page.locator('.draft__block--combination .draft__block-expr')).toHaveText(
      '#2 AND #1'
    );

    // 観測点 B（傍証）: Sheets（FormulaVersions）へ実際に保存された formula_md 文字列。
    // 最終行が `#3 #2 AND #1`（大文字）になっていることを直接テキストで確認する。
    await expect
      .poll(() => (fake.tabs['FormulaVersions'] ?? []).length, {
        message: 'FormulaVersions への append を待つ',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const savedRows = fake.tabs['FormulaVersions'] ?? [];
    const appended = savedRows[savedRows.length - 1] ?? [];
    const formulaMd = String(appended[FORMULA_MD_COLUMN_INDEX] ?? '');
    // formula_md は ```` ```\n#1 ...\n#2 ...\n#3 ...\n``` ```` というコードフェンス込みの
    // 文字列なので、末尾行だけを見ると閉じフェンス（```）を拾ってしまう。`#<id> ` で
    // 始まる行だけに絞り込んでから最後の行を取る。
    const formulaLines = formulaMd.split('\n').filter((l) => /^#\S+\s/.test(l));
    const lastLine = formulaLines[formulaLines.length - 1] ?? '';
    expect(lastLine).toBe('#3 #2 AND #1');
    // 小文字 and がそのまま紛れ込んでいないことも明示的に確認する（実害の中心）。
    expect(formulaMd).not.toMatch(/#3 .*\band\b/);
  });
});

// ---------------------------------------------------------------------------
// 項目 2: #/edit の「組み合わせ方を編集」
// ---------------------------------------------------------------------------

/**
 * 循環参照テスト用 md。#3（#1 AND #2）と #4（#3 AND #Filter1）の 2 本の掛け合わせ行を持つ。
 * #3 を `#1 AND #4` に書き換えると #3 → #4 → #3 の間接循環ができる（issue #92 B-1）。
 */
const CIRCULAR_TEST_MD = `## PubMed/MEDLINE

\`\`\`
#1 "ARDS"[tiab]
#2 "ECMO"[tiab]
#Filter1 english[la]
#3 #1 AND #2
#4 #3 AND #Filter1
\`\`\`
`;

test.describe('journey-edit-review-fixes: 2. #/edit の「組み合わせ方を編集」', () => {
  test('小文字 and を入力して保存すると、読み取り表示は大文字 AND になる', async ({ page }) => {
    await injectAppStub(page, fullStateScenario({ preloadedState: FULL_APP_STATE }));
    await page.goto(EDIT_URL);

    const row3 = page.locator('.edit__block-row[data-block-id="3"]');
    await expect(row3.locator('.edit__block-current')).toHaveText('#1 AND #2');

    await row3.locator('.edit__block-combination-toggle').click();
    const input = row3.locator('.edit__block-combination-input');
    await expect(input).toBeVisible();
    // 順序も入れ替えて「保存が実際に効いたこと」と「大文字化されたこと」を同時に確認する。
    await input.fill('#2 and #1');
    await expect(row3.locator('.edit__block-combination-status')).toHaveText('✓ 構文 OK');
    await row3.locator('.edit__block-combination-save').click();

    await expect(row3.locator('.edit__block-current')).toHaveText('#2 AND #1');
  });

  test('間接循環を作る書き換えは警告が出て、保存を押しても式が変わらない', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: CIRCULAR_TEST_MD },
      })
    );
    await page.goto(EDIT_URL);

    const row3 = page.locator('.edit__block-row[data-block-id="3"]');
    await expect(row3.locator('.edit__block-current')).toHaveText('#1 AND #2');

    await row3.locator('.edit__block-combination-toggle').click();
    const input = row3.locator('.edit__block-combination-input');
    await expect(input).toBeVisible();
    // #3 → #4 → #3（#4 は "#3 AND #Filter1"）という間接循環を作る書き換え。
    await input.fill('#1 AND #4');
    await expect(row3.locator('.edit__block-combination-status')).toHaveText(
      '⚠ この組み合わせ方は参照の循環を作ります'
    );

    await row3.locator('.edit__block-combination-save').click();

    // 保存ボタンを押しても式は変わらない（読み取り表示・警告表示とも）。
    await expect(row3.locator('.edit__block-current')).toHaveText('#1 AND #2');
    await expect(row3.locator('.edit__block-combination-status')).toHaveText(
      '⚠ この組み合わせ方は参照の循環を作ります'
    );
  });
});

// ---------------------------------------------------------------------------
// 項目 3: 参照とキーワードが混在する掛け合わせ行（issue #88 対応後の退行修正）
// ---------------------------------------------------------------------------

/** #3 が「参照 + リテラル語」混在の掛け合わせ行（純粋な組み合わせ式ではない）。 */
const MIXED_COMBINATION_MD = `## PubMed/MEDLINE

\`\`\`
#1 "ARDS"[tiab]
#2 "ECMO"[tiab]
#3 #1 AND #2 AND humans[mh]
\`\`\`
`;

async function gotoMixedCombinationEdit(page: Page): Promise<void> {
  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: MIXED_COMBINATION_MD },
    })
  );
  await page.goto(EDIT_URL);
}

test.describe('journey-edit-review-fixes: 3. 参照とキーワードが混在する掛け合わせ行', () => {
  test('「組み合わせ方を編集」トグルが無い', async ({ page }) => {
    await gotoMixedCombinationEdit(page);
    const row3 = page.locator('.edit__block-row[data-block-id="3"]');
    await expect(row3.locator('.edit__block-current')).toHaveText('#1 AND #2 AND humans[mh]');
    await expect(row3.locator('.edit__block-combination-toggle')).toHaveCount(0);
  });

  test('生テキスト編集欄が実ブラウザで見えていて操作でき、保存すると式が変わる', async ({
    page,
  }) => {
    await gotoMixedCombinationEdit(page);
    const row3 = page.locator('.edit__block-row[data-block-id="3"]');
    const input = row3.locator('.edit__block-edit-input');
    // jsdom の click/querySelector は可視性を無視するため、ここは実ブラウザでしか
    // 確認する意味が無い（CLAUDE.md の #/edit 注意事項どおり toBeVisible + fill を使う）。
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('#1 AND #2 AND humans[mh]');

    const edited = '#1 AND #2 AND humans[mh] AND animals[mh:noexp]';
    await input.fill(edited);
    await row3.locator('.edit__block-edit-save').click();

    await expect(row3.locator('.edit__block-current')).toHaveText(edited);
  });

  test('#1・#2 の参照を消して保存しようとすると、ガードのエラーが出て式が変わらない', async ({
    page,
  }) => {
    await gotoMixedCombinationEdit(page);
    const row3 = page.locator('.edit__block-row[data-block-id="3"]');
    const input = row3.locator('.edit__block-edit-input');
    await expect(input).toBeVisible();

    await input.fill('humans[mh]');
    await row3.locator('.edit__block-edit-save').click();

    await expect(row3.locator('.edit__block-edit-error')).toContainText(
      '参照が失われるため適用できません'
    );
    // ガードに拒否されているので読み取り表示は元のまま。
    await expect(row3.locator('.edit__block-current')).toHaveText('#1 AND #2 AND humans[mh]');
  });
});

// ---------------------------------------------------------------------------
// 項目 4: AI 改善の指示欄（issue #92 C-3 / B-4）
// ---------------------------------------------------------------------------

const BLOCK_IMPROVEMENT: NonNullable<AppState['blockImprovement']> = {
  formulaVersionId: 'fv-20260420-01',
  blockId: '1',
  status: 'ready',
  result: {
    blockId: '1',
    currentExpression: '"ARDS"[tiab] OR "acute respiratory distress"[tiab]',
    proposedExpression: '"ARDS"[Mesh] OR "acute respiratory distress"[tiab]',
    rationale: 'MeSH を追加して感度を上げる',
  },
  error: null,
  history: [],
};

/** 「指示を追加してやり直す」（issue #90）で LLM から返す提案。 */
const REDO_IMPROVE_BLOCK_RESPONSE = {
  proposed_expression:
    '"ARDS"[Mesh] OR "acute respiratory distress"[tiab] OR "acute lung injury"[tiab]',
  rationale: '同義語 acute lung injury を追加しました。',
};

test.describe('journey-edit-review-fixes: 4. AI 改善の指示欄', () => {
  test('初回の指示欄: 開く→入力→キャンセル→再度開くと入力が残っている（issue #92 C-3）', async ({
    page,
  }) => {
    await injectAppStub(page, fullStateScenario({ preloadedState: FULL_APP_STATE }));
    await page.goto(EDIT_URL);

    const row1 = page.locator('.edit__block-row[data-block-id="1"]');
    await row1.locator('.edit__block-improve').click();
    const instructionInput = row1.locator('.edit__block-ai-instruction');
    await expect(instructionInput).toBeVisible();
    await expect(instructionInput).toHaveValue('');
    await instructionInput.fill('同義語を増やして');

    await row1.locator('.edit__block-ai-cancel').click();
    await expect(row1.locator('.edit__block-ai-instruction')).toHaveCount(0);

    // store（blockImprovementInstruction）には残っているはずなので、再度開くと復元される。
    // 描画時スナップショットのままだった旧実装ではここが空に戻っていた（C-3 の回帰）。
    await row1.locator('.edit__block-improve').click();
    await expect(row1.locator('.edit__block-ai-instruction')).toHaveValue('同義語を増やして');
  });

  test('「指示を追加してやり直す」欄: 送信して成功すると空に戻る（issue #92 B-4）', async ({
    page,
  }) => {
    await registerDriveStub(page);
    await registerGeminiStub(page, {
      responses: { 'improve-block': REDO_IMPROVE_BLOCK_RESPONSE },
    });
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT },
        extraStorage: { 'apiKeys.gemini': 'dummy-key' },
      })
    );
    await page.goto(EDIT_URL);

    const row1 = page.locator('.edit__block-row[data-block-id="1"]');
    const redoInstruction = row1.locator('.edit__block-ai-redo-instruction');
    await expect(redoInstruction).toBeVisible();
    await redoInstruction.fill('acute lung injury も同義語として追加して');
    await row1.locator('.edit__block-ai-redo-submit').click();

    await expect(row1.locator('.edit__block-rationale')).toContainText(
      'acute lung injury を追加しました',
      { timeout: 15_000 }
    );
    // 送信成功時に blockImprovementInstruction がクリアされるため、指示欄は空に戻る
    // （送信した指示がそのまま残っていると、次に送るとき同じ指示が history へ二重に積まれる）。
    await expect(row1.locator('.edit__block-ai-redo-instruction')).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// 項目 5: 「提案を編集してから採用する」の入力が背景の再描画をまたいでも消えない（issue #92 B-3）
// ---------------------------------------------------------------------------

test.describe('journey-edit-review-fixes: 5. 「提案を編集してから採用する」の入力の永続性', () => {
  test('別ブロックの生テキスト編集（onDraftChange 経由の全体再描画）をまたいでも入力が残る', async ({
    page,
  }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT },
      })
    );
    await page.goto(EDIT_URL);

    const row1 = page.locator('.edit__block-row[data-block-id="1"]');
    const manualEdit = row1.locator('.edit__block-ai-manual-edit');
    await manualEdit.locator('summary').click();
    const manualEditInput = manualEdit.locator('.edit__block-ai-manual-edit-input');
    await expect(manualEditInput).toBeVisible();
    const edited =
      '"ARDS"[Mesh] OR "acute respiratory distress"[tiab] OR "acute lung injury"[tiab]';
    await manualEditInput.fill(edited);

    // 再描画トリガー: ブロック #2 の詳細編集（生テキスト）を保存すると、bootstrap.ts の
    // onDraftChange が store.setState（setStateSilently ではない）を呼び、editView 全体が
    // container.innerHTML = '' で作り直される（journey-edit-save.spec.ts の
    // editBlockInline と同じ経路。「別ブロックの編集」を選ぶのは、#1 自身の
    // blockImprovement / currentFormulaVersionId には触れないため — もし #1 を編集すると
    // 提案パネル自体が別の理由で作り直されてしまい、「再描画をまたいでも消えない」ことの
    // 検証にならない）。
    const row2 = page.locator('.edit__block-row[data-block-id="2"]');
    await row2.locator('.edit__block-edit-toggle').click();
    const row2Input = row2.locator('.edit__block-edit-input');
    await expect(row2Input).toBeVisible();
    await row2Input.fill('"ECMO"[tiab] OR "ECLS"[tiab]');
    await row2.locator('.edit__block-edit-save').click();

    // 再描画が実際に起きたことの直接証拠: #2 の読み取り表示が更新されている
    // （editor.setMd → onDraftChange → store.setState → container 丸ごと作り直し、という
    // 経路を通らない限りここは変わらない）。
    await expect(row2.locator('.edit__block-current')).toHaveText('"ECMO"[tiab] OR "ECLS"[tiab]');

    // 再描画後も #1 の手編集 <details> は開いたまま、入力内容も保持されている
    // （blockImprovementManualEditDraft が store backed になっているため。issue #92 B-3）。
    await expect(row1.locator('.edit__block-ai-manual-edit')).toHaveAttribute('open', '');
    await expect(row1.locator('.edit__block-ai-manual-edit-input')).toHaveValue(edited);
  });
});

// ---------------------------------------------------------------------------
// 項目 6: 単一ブロックの検索式では「掛け合わせ行がありません」の警告が出ない（issue #92 B-6）
// ---------------------------------------------------------------------------

const SINGLE_BLOCK_MD = `## PubMed/MEDLINE

\`\`\`
#1 "ARDS"[tiab]
\`\`\`
`;

/** 2 ブロックあるのに掛け合わせ行が無い式（ガードが正しく発火するべきケース）。 */
const TWO_BLOCKS_NO_COMBINATION_MD = `## PubMed/MEDLINE

\`\`\`
#1 "ARDS"[tiab]
#2 "ECMO"[tiab]
\`\`\`
`;

test.describe('journey-edit-review-fixes: 6. 単一ブロック式では掛け合わせ行なし警告を出さない', () => {
  test('ブロックが 1 本だけの式では警告が出ない', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: SINGLE_BLOCK_MD },
      })
    );
    await page.goto(EDIT_URL);

    await expect(page.locator('.edit__block-row')).toHaveCount(1);
    await expect(page.locator('.edit__consistency-notice')).toHaveCount(0);
  });

  test('2 ブロック以上で掛け合わせ行が無い式では、引き続き警告が出る（ガードが効きすぎていないことの確認）', async ({
    page,
  }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: TWO_BLOCKS_NO_COMBINATION_MD },
      })
    );
    await page.goto(EDIT_URL);

    await expect(page.locator('.edit__block-row')).toHaveCount(2);
    // renderConsistencyNotices の文言は「⚠ ブロックを掛け合わせる行（例: #3 #1 AND #2）が
    // ありません。...」。括弧の例示部分を挟むため hasText は「掛け合わせる行」だけで絞る。
    // なお #2 が誰からも参照されない式でもあるため、findUnreachableBlockIds 側の別の
    // 注意（「#2 はどの行からも参照されていません」）も同時に出る想定だが、ここで確認したい
    // のは「掛け合わせ行が無い」警告の方だけなので、他の notice の有無は問わない。
    await expect(
      page.locator('.edit__consistency-notice').filter({ hasText: '掛け合わせる行' })
    ).toBeVisible();
  });
});
