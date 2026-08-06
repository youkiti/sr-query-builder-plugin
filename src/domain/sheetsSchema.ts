/**
 * Google Sheets の 9 タブ定義。
 * requirements.md §3.1 参照。実 I/O は lib/google/sheets.ts 側で行う。
 */

export const SHEET_TABS = [
  'Meta',
  'Protocol',
  'ProtocolBlocks',
  'SeedPapers',
  'FormulaVersions',
  'ValidationLog',
  'Conversions',
  'LLMApiLog',
  'Config',
] as const;

export type SheetTabName = (typeof SHEET_TABS)[number];

/**
 * 各タブのヘッダー行（列名）定義。スプレッドシート初期化時にここから書き込む。
 * 列名は snake_case（requirements.md §3.1 に準拠）。
 */
export const SHEET_HEADERS: Record<SheetTabName, readonly string[]> = {
  Meta: [
    'project_id',
    'project_title',
    'spreadsheet_id',
    'drive_folder_id',
    'schema_version',
    'created_at',
    'created_by',
  ],
  Protocol: [
    'version',
    'framework_type',
    'research_question',
    'inclusion_criteria',
    'exclusion_criteria',
    'study_design',
    'block_count',
    'combination_expression',
    'source_type',
    'source_filename',
    'raw_text_ref',
    'raw_text_preview',
    'raw_text_inline',
    'created_at',
    'created_by',
  ],
  ProtocolBlocks: ['version', 'block_index', 'block_label', 'description', 'ai_generated', 'note'],
  SeedPapers: [
    'pmid',
    'title',
    'year',
    'source',
    'ingest_format',
    'original_db',
    'is_valid',
    'exclusion_reason',
    'original_payload_ref',
    'user_decision',
    'decided_at',
    'decided_by',
    'note',
  ],
  FormulaVersions: [
    'version_id',
    'parent_version_id',
    'protocol_version',
    'protocol_snapshot_ref',
    'formula_md',
    'created_by',
    'created_at',
    'note',
    // model は後付け列。既存シートの行データと位置互換を保つため必ず末尾に置く
    'model',
  ],
  ValidationLog: [
    'validation_id',
    'version_id',
    'check_type',
    'total_hits',
    'capture_rate',
    'captured_pmids',
    'missed_pmids',
    'detail_ref',
    'executed_at',
  ],
  Conversions: [
    'conversion_id',
    'version_id',
    'target_db',
    'converted_formula',
    'warnings',
    'exported_at',
  ],
  LLMApiLog: [
    'log_id',
    'timestamp',
    'provider',
    'model',
    'purpose',
    'prompt_ref',
    'response_ref',
    'prompt_summary',
    'tokens_in',
    'tokens_out',
    'latency_ms',
    'cost_estimate_usd',
    'error',
  ],
  Config: ['key', 'value'],
};
