/**
 * 章ごとの初期状態プリセット（video/REQUIREMENTS.md §6-4）。
 *
 * `app.html?demoSeed=<name>` で名前付きプリセットを指定すると、そのプリセットに
 * 対応する Sheets/Drive の状態（`sheetStore.ts` の in-memory バックエンド）を
 * 一から作り直し、デモエントリが `startApp` の `store` オプションへ渡す `Partial<AppState>` を
 * 返す。未指定 / 不明な名前の扱いは呼び出し側（app-entry.ts）に委ねる。
 *
 * 各プリセットは可能な限り「Sheets への実書き込み」（`@/features/protocol` /
 * `@/features/seeds` / `@/features/formula` の本番リポジトリ関数をそのまま呼ぶ）で
 * 状態を作る。これにより起動時の `hydrateCurrentProject`（本番の bootstrap.ts）が
 * 通常どおり Sheets を読み直して `protocolDraft` / `blocksDraft` /
 * `currentFormulaVersionId` 等を復元してくれる。`validationResult` 等、Sheets から
 * 再読込されない実行時専用の state だけをこの差分で補う
 * （`src/app/store.ts` のコメント、`src/app/bootstrap.ts` の `hydrateCurrentProject`
 * 参照）。
 *
 * 検索式・ヒット数・捕捉率はすべて `scenario.ts` / `queryEngine.ts` 経由でコーパスから
 * 導出する（ハードコードしない。§6-2）。
 */

import type { AppState } from '@/app/store';
import { STORAGE_KEY_GEMINI } from '@/app/services';
import type { SeedPaper } from '@/domain/seedPaper';
import { appendFormulaVersion } from '@/features/formula';
import { appendProtocol, appendProtocolBlocks } from '@/features/protocol';
import { createProject } from '@/features/project';
import { createChromeStoreDeps, setCurrentProject, type CurrentProjectEntry } from '@/features/project';
import { appendSeedPaper } from '@/features/seeds';
import type { GoogleApiDeps } from '@/lib/google';
import { nowIso } from '@/utils/iso8601';
import { DEMO_EMAIL } from './identity';
import { resetDemoBackend } from './sheetStore';
import { DEMO_CORPUS_BY_PMID } from './corpus';
import {
  BLOCK_DEFS,
  COMBINATION_EXPRESSION,
  EXCLUSION_CRITERIA,
  INCLUSION_CRITERIA,
  PROTOCOL_INLINE_TEXT,
  RECOMMENDED_BOUNDARY_INCLUDE_PMID,
  RESEARCH_QUESTION,
  SEED_PMIDS,
  STUDY_DESIGN,
  buildFormulaV1,
  buildFormulaV2,
  buildValidationSummary,
} from './scenario';

/** デモプロジェクト名。架空データであることが画面上でも分かるようにする。 */
export const DEMO_PROJECT_TITLE = 'ARDS/ECMO 生存率 SR（デモ・架空データ）';

const DEMO_GEMINI_API_KEY = 'demo-gemini-api-key-not-real';
const FORMULA_V1_ID = 'v1-demo';
const FORMULA_V2_ID = 'v2-demo';
const DEMO_MODEL = 'gemini-3.5-flash';

function makeDemoGoogleDeps(): GoogleApiDeps {
  // installDemoFetch() 済みの globalThis.fetch（demoFetch）をそのまま使う。
  // 本番の createChromeGoogleApiDeps と同じ形（fetch を薄く委譲するだけ）。
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    getAccessToken: async () => 'demo-access-token',
  };
}

async function createDemoProject(deps: GoogleApiDeps): Promise<CurrentProjectEntry> {
  const result = await createProject({ projectTitle: DEMO_PROJECT_TITLE, createdBy: DEMO_EMAIL }, deps);
  const entry: CurrentProjectEntry = {
    projectId: result.meta.projectId,
    spreadsheetId: result.meta.spreadsheetId,
    driveFolderId: result.meta.driveFolderId,
    title: result.meta.projectTitle,
  };
  await setCurrentProject(entry, createChromeStoreDeps());
  return entry;
}

async function seedGeminiApiKey(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_GEMINI]: DEMO_GEMINI_API_KEY });
}

/** Protocol version=1 + ProtocolBlocks（ARDS/ECMO/RCT フィルタ）を承認済みとして書き込む。 */
async function seedApprovedProtocol(deps: GoogleApiDeps, spreadsheetId: string): Promise<void> {
  await appendProtocol(
    spreadsheetId,
    {
      version: 1,
      frameworkType: 'pico',
      researchQuestion: RESEARCH_QUESTION,
      inclusionCriteria: INCLUSION_CRITERIA,
      exclusionCriteria: EXCLUSION_CRITERIA,
      studyDesign: STUDY_DESIGN,
      blockCount: BLOCK_DEFS.length,
      combinationExpression: COMBINATION_EXPRESSION,
      sourceType: 'manual',
      sourceFilename: null,
      rawTextRef: null,
      rawTextPreview: PROTOCOL_INLINE_TEXT.slice(0, 500),
      rawTextInline: PROTOCOL_INLINE_TEXT,
      createdAt: nowIso(),
      createdBy: DEMO_EMAIL,
    },
    deps
  );
  await appendProtocolBlocks(
    spreadsheetId,
    1,
    BLOCK_DEFS.map((def, index) => ({
      blockIndex: index + 1,
      blockLabel: def.blockLabel,
      description: def.blockDescription,
      aiGenerated: true,
      note: null,
    })),
    deps
  );
}

function buildSeedPaper(pmid: string, decision: 'initial' | 'interactive-include'): SeedPaper {
  const paper = DEMO_CORPUS_BY_PMID.get(pmid);
  /* istanbul ignore if -- SEED_PMIDS / RECOMMENDED_BOUNDARY_INCLUDE_PMID は必ずコーパスに実在する */
  if (!paper) {
    throw new Error(`[demo] seeds: コーパスに存在しない PMID です: ${pmid}`);
  }
  if (decision === 'initial') {
    return {
      pmid,
      title: paper.title,
      year: paper.year,
      source: 'initial',
      ingestFormat: 'pmid_direct',
      originalDb: null,
      isValid: true,
      exclusionReason: null,
      originalPayloadRef: null,
      userDecision: null,
      decidedAt: null,
      decidedBy: null,
      note: null,
    };
  }
  return {
    pmid,
    title: paper.title,
    year: paper.year,
    source: 'interactive',
    ingestFormat: 'interactive',
    originalDb: null,
    isValid: true,
    exclusionReason: null,
    originalPayloadRef: null,
    userDecision: 'include',
    decidedAt: nowIso(),
    decidedBy: DEMO_EMAIL,
    note: '対話的シード拡張（#/expand）の境界事例候補として include（デモ）',
  };
}

/** 初期シード 5 本（source=initial）を登録する。 */
async function seedInitialSeedPapers(deps: GoogleApiDeps, spreadsheetId: string): Promise<void> {
  for (const pmid of SEED_PMIDS) {
    await appendSeedPaper(spreadsheetId, buildSeedPaper(pmid, 'initial'), deps);
  }
}

/** 対話的シード拡張で境界事例を include した状態まで進める（09 章が完了した想定）。 */
async function seedInteractiveBoundaryInclude(deps: GoogleApiDeps, spreadsheetId: string): Promise<void> {
  await appendSeedPaper(
    spreadsheetId,
    buildSeedPaper(RECOMMENDED_BOUNDARY_INCLUDE_PMID, 'interactive-include'),
    deps
  );
}

async function seedFormulaV1(deps: GoogleApiDeps, spreadsheetId: string): Promise<void> {
  await appendFormulaVersion(
    spreadsheetId,
    {
      versionId: FORMULA_V1_ID,
      parentVersionId: null,
      protocolVersion: 1,
      protocolSnapshotRef: PROTOCOL_INLINE_TEXT,
      formulaMd: buildFormulaV1().markdown,
      createdBy: 'ai_draft',
      createdAt: nowIso(),
      note: null,
      model: DEMO_MODEL,
    },
    deps
  );
}

async function seedFormulaV2(deps: GoogleApiDeps, spreadsheetId: string): Promise<void> {
  await appendFormulaVersion(
    spreadsheetId,
    {
      versionId: FORMULA_V2_ID,
      parentVersionId: FORMULA_V1_ID,
      protocolVersion: 1,
      protocolSnapshotRef: PROTOCOL_INLINE_TEXT,
      formulaMd: buildFormulaV2().markdown,
      createdBy: 'user_edit',
      createdAt: nowIso(),
      note: 'ブロック #2（ECMO）に "Extracorporeal Membrane Oxygenation"[Mesh] を追加',
      model: DEMO_MODEL,
    },
    deps
  );
}

/** 章プリセットが返す、store の初期 state に上乗せする差分。 */
export type DemoSeedState = Partial<AppState>;

interface SeedDefinition {
  /** 章の目安ラベル（デバッグ用。UI には出さない） */
  label: string;
  build: (deps: GoogleApiDeps, project: CurrentProjectEntry) => Promise<DemoSeedState>;
}

const SEED_DEFINITIONS: Record<string, SeedDefinition> = {
  '04-protocol': {
    label: '04: 研究プロトコルを入力する（未入力の状態から開始）',
    build: async () => ({}),
  },
  '05-blocks': {
    label: '05: 検索式ブロックを承認する（AI 抽出直後・未承認）',
    build: async () => ({
      protocolDraftPersisted: false,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: RESEARCH_QUESTION,
        inclusionCriteria: INCLUSION_CRITERIA,
        exclusionCriteria: EXCLUSION_CRITERIA,
        studyDesign: STUDY_DESIGN,
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: PROTOCOL_INLINE_TEXT.slice(0, 500),
        rawTextInline: PROTOCOL_INLINE_TEXT,
      },
      blocksDraft: {
        blocks: BLOCK_DEFS.map((def) => ({
          blockLabel: def.blockLabel,
          description: def.blockDescription,
          aiGenerated: true,
          note: '',
        })),
        combinationExpression: COMBINATION_EXPRESSION,
      },
    }),
  },
  '06-seeds': {
    label: '06: シード論文を登録する（ブロック承認済み・シード未登録）',
    build: async (deps, project) => {
      await seedApprovedProtocol(deps, project.spreadsheetId);
      return {};
    },
  },
  '07-draft': {
    label: '07: 検索式を生成して検証する（シード登録済み・検索式未生成）',
    build: async (deps, project) => {
      await seedApprovedProtocol(deps, project.spreadsheetId);
      await seedInitialSeedPapers(deps, project.spreadsheetId);
      return {};
    },
  },
  '08-validation': {
    label: '08: 検証結果を読む（v1 生成・検証済み、捕捉率 80%）',
    build: async (deps, project) => {
      await seedApprovedProtocol(deps, project.spreadsheetId);
      await seedInitialSeedPapers(deps, project.spreadsheetId);
      await seedFormulaV1(deps, project.spreadsheetId);
      return {
        cumulativeCostUsd: 0.0138,
        validationResult: {
          formulaVersionId: FORMULA_V1_ID,
          summary: buildValidationSummary(buildFormulaV1().markdown, SEED_PMIDS),
        },
      };
    },
  },
  '09-expand': {
    label: '09: 対話的シード拡張（v1 検証済みの状態から境界事例を取得する）',
    // 08 章と同じ状態（境界事例の取得・判定はこの章でライブに行う）。
    build: async (deps, project) => SEED_DEFINITIONS['08-validation']!.build(deps, project),
  },
  '10-edit': {
    label: '10: 検索式を編集して再検証する（境界事例 include 済み・捕捉率低下を確認できる状態）',
    build: async (deps, project) => {
      await seedApprovedProtocol(deps, project.spreadsheetId);
      await seedInitialSeedPapers(deps, project.spreadsheetId);
      await seedInteractiveBoundaryInclude(deps, project.spreadsheetId);
      await seedFormulaV1(deps, project.spreadsheetId);
      const eligible = [...SEED_PMIDS, RECOMMENDED_BOUNDARY_INCLUDE_PMID];
      return {
        cumulativeCostUsd: 0.0221,
        validationResult: {
          formulaVersionId: FORMULA_V1_ID,
          summary: buildValidationSummary(buildFormulaV1().markdown, eligible),
        },
      };
    },
  },
  '11-export': {
    label: '11/13: 変換・エクスポート／バージョン履歴（v2 まで完了・捕捉率 100%）',
    build: async (deps, project) => {
      await seedApprovedProtocol(deps, project.spreadsheetId);
      await seedInitialSeedPapers(deps, project.spreadsheetId);
      await seedInteractiveBoundaryInclude(deps, project.spreadsheetId);
      await seedFormulaV1(deps, project.spreadsheetId);
      await seedFormulaV2(deps, project.spreadsheetId);
      const eligible = [...SEED_PMIDS, RECOMMENDED_BOUNDARY_INCLUDE_PMID];
      return {
        cumulativeCostUsd: 0.0221,
        validationResult: {
          formulaVersionId: FORMULA_V2_ID,
          summary: buildValidationSummary(buildFormulaV2().markdown, eligible),
        },
      };
    },
  },
};
// 13 章（バージョン履歴・設定）は 11 章と同じ状態（v1 → v2 の履歴が並んでいればよい）。
SEED_DEFINITIONS['13-history'] = SEED_DEFINITIONS['11-export']!;

/** 定義済みプリセット名の一覧（`?demoSeed=` に指定できる値）。エラーメッセージ表示用に公開する。 */
export const DEMO_SEED_NAMES: readonly string[] = Object.keys(SEED_DEFINITIONS);

/**
 * `demoSeed` 名からプリセットを適用する。
 *
 * 1. デモバックエンド（Sheets/Drive の in-memory 状態）を空に戻す
 *    （章を切り替えたときに前章のデータを持ち越さないため）
 * 2. プロジェクトを新規作成し、`chrome.storage.local` の `currentProject` に設定
 * 3. Gemini API キー（ダミー）を `chrome.storage.local` に設定
 * 4. プリセット固有の Sheets 書き込みを行う
 * 5. store の初期 state に上乗せする `Partial<AppState>` を返す
 *
 * @throws 未知の `name` を渡した場合（シーンスクリプトの typo を早期に気づけるようにする）
 */
export async function applyDemoSeed(name: string): Promise<DemoSeedState> {
  const definition = SEED_DEFINITIONS[name];
  if (!definition) {
    throw new Error(
      `[demo] seeds: 未知の demoSeed です: "${name}"（利用可能: ${DEMO_SEED_NAMES.join(', ')}）`
    );
  }
  await resetDemoBackend();
  const deps = makeDemoGoogleDeps();
  const project = await createDemoProject(deps);
  await seedGeminiApiKey();
  return definition.build(deps, project);
}
