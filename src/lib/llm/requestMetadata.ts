import type { RequestMetadata } from './LLMProvider';

/** 本文から会話・道具・スキーマ本体を除き、送信設定だけを取り出す。 */
export function requestMetadata(body: Record<string, unknown>): RequestMetadata {
  const settings = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const key of ['messages', 'system', 'tools', 'contents', 'systemInstruction']) delete settings[key];
  const config = settings['generationConfig'] as Record<string, unknown> | undefined;
  const responseSchemaSent = config?.['responseSchema'];
  if (config) delete config['responseSchema'];
  const output = settings['output_config'] as Record<string, unknown> | undefined;
  const format = output?.['format'] as Record<string, unknown> | undefined;
  if (format) delete format['schema'];
  const response = settings['response_format'] as Record<string, unknown> | undefined;
  const schema = response?.['json_schema'] as Record<string, unknown> | undefined;
  if (schema) delete schema['schema'];
  return { generationSettingsSent: settings, ...(responseSchemaSent ? { responseSchemaSent } : {}) };
}
