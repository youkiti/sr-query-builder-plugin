/**
 * Protocol / ProtocolBlocks タブに対応する型。
 * requirements.md §3.1 参照。
 */

export type FrameworkType = 'pico' | 'peco' | 'pcc' | 'spider' | 'custom' | null;
export type ProtocolSourceType = 'manual' | 'markdown' | 'docx';

export interface Protocol {
  version: number;
  frameworkType: FrameworkType;
  researchQuestion: string;
  inclusionCriteria: string | null;
  exclusionCriteria: string | null;
  studyDesign: string | null;
  blockCount: number;
  combinationExpression: string;
  sourceType: ProtocolSourceType;
  sourceFilename: string | null;
  rawTextRef: string | null;
  rawTextPreview: string | null;
  rawTextInline: string | null;
  createdAt: string;
  createdBy: string;
}

export interface ProtocolBlock {
  version: number;
  blockIndex: number;
  blockLabel: string;
  description: string;
  aiGenerated: boolean;
  note: string | null;
}

/** 検索式ブロックは 1〜5 個まで（SPIDER フレームワークが 5 ブロックで最大） */
export const MIN_BLOCK_COUNT = 1;
export const MAX_BLOCK_COUNT = 5;
