/**
 * キーボード判定と取得エラー復帰に使う、初期シード候補 5 件のシナリオ。
 * SeedPapers を空にして現式の inside 探索を使い、式設計の成否に依存せず
 * Sheets 読取 → esearch → efetch → AI 選定を通す。外部通信はすべてスタブする。
 */

import type { Page } from '@playwright/test';
import { injectAppStub } from '../appStub';
import {
  registerSheetsStub,
  registerDriveStub,
  registerNcbiStub,
  registerMeshRdfStub,
  registerGeminiStub,
} from '../apiStubs';
import { fullStateScenario, FULL_APP_STATE } from './fullState';

export const CANDIDATE_PMIDS = ['41000001', '41000002', '41000003', '41000004', '41000005'];

const efetchXml = (abstract: string): string => `<?xml version="1.0"?><PubmedArticleSet>${CANDIDATE_PMIDS.map(
  (pmid, index) => `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID>
<Article><ArticleTitle>ECMO for adult ARDS trial ${index + 1}</ArticleTitle>
<Journal><JournalIssue><Year>2024</Year></JournalIssue></Journal>
<Abstract><AbstractText>${abstract}</AbstractText></Abstract>
</Article></MedlineCitation></PubmedArticle>`
).join('')}</PubmedArticleSet>`;

export async function setupExpandCandidates(
  page: Page,
  abstract = 'A randomised trial of ECMO in adults with ARDS.'
): Promise<void> {
  await registerSheetsStub(page);
  await registerDriveStub(page);
  await registerNcbiStub(page, {
    esearch: () => ({ count: '5', idlist: CANDIDATE_PMIDS }),
    efetchXml: efetchXml(abstract),
  });
  await registerMeshRdfStub(page);
  await registerGeminiStub(page, {
    responses: {
      'pick-seed-candidates': {
        picks: CANDIDATE_PMIDS.map((pmid) => ({
          pmid,
          reason: '成人 ARDS に対する ECMO の比較試験で組入基準に合致する。',
        })),
      },
    },
  });
  await injectAppStub(page, fullStateScenario({
    preloadedState: { ...FULL_APP_STATE, expandInsideStrategy: 'current' },
    extraStorage: { 'apiKeys.gemini': 'dummy-key' },
  }));
}
