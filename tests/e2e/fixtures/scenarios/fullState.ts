/**
 * 全 11 ルートの guard を通過するフル state 版シナリオ。
 * Phase A smoke-of-smoke と、Phase B で guard 依存の低い view を検証するときの起点。
 */

import type { AppState } from '../../../../src/app/store';
import { PROJECT_FIXTURE, scenarioWithProject, type AppScenario } from '../appStub';

export const FULL_PROTOCOL_DRAFT: NonNullable<AppState['protocolDraft']> = {
  frameworkType: 'pico',
  researchQuestion: '成人 ARDS に対する ECMO の生存率への効果',
  inclusionCriteria: '成人, ARDS 診断, ECMO 導入',
  exclusionCriteria: '小児, 症例報告',
  studyDesign: 'RCT',
  sourceType: 'manual',
  sourceFilename: null,
  rawTextRef: null,
  rawTextPreview: 'PICO: Population=ARDS 成人 ...',
  rawTextInline: 'PICO: Population=ARDS 成人 / Intervention=ECMO / Control=従来治療 / Outcome=生存率',
};

export const FULL_BLOCKS_DRAFT: NonNullable<AppState['blocksDraft']> = {
  blocks: [
    {
      blockLabel: 'P (Population)',
      description: 'ARDS',
      aiGenerated: false,
      note: '',
    },
    {
      blockLabel: 'I (Intervention)',
      description: 'ECMO',
      aiGenerated: false,
      note: '',
    },
  ],
  combinationExpression: '#1 AND #2',
};

export const FULL_FORMULA_MARKDOWN = `## PubMed/MEDLINE

\`\`\`
#1 "ARDS"[tiab] OR "acute respiratory distress"[tiab]
#2 "ECMO"[tiab] OR "extracorporeal membrane oxygenation"[tiab]
#3 #1 AND #2
\`\`\`
`;

export const FULL_APP_STATE: Partial<AppState> = {
  project: PROJECT_FIXTURE,
  cumulativeCostUsd: 0.12,
  protocolDraft: FULL_PROTOCOL_DRAFT,
  blocksDraft: FULL_BLOCKS_DRAFT,
  currentProtocolVersion: 1,
  currentFormulaVersionId: 'fv-20260420-01',
  currentFormulaMarkdown: FULL_FORMULA_MARKDOWN,
};

/** 全ルート遷移可能なシナリオ */
export function fullStateScenario(overrides: Partial<AppScenario> = {}): AppScenario {
  return scenarioWithProject({
    preloadedState: FULL_APP_STATE,
    ...overrides,
  });
}
