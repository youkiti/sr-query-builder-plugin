import { buildPreview, type ParsedProtocolFile } from './types';

/**
 * 手入力フォームから送られたプロトコル本文をパース結果形式に整える。
 * Drive 退避は行わず、Sheets の `raw_text_inline` に書き込む前提。
 */
export function parseManualProtocol(inlineText: string): ParsedProtocolFile {
  return {
    sourceType: 'manual',
    sourceFilename: '',
    plainText: inlineText,
    preview: buildPreview(inlineText),
  };
}
