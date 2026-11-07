import { jaMessages } from './messages';

export const ja = jaMessages;

/** 全領域の日本語キーのリテラル合併 */
export type MessageKey = keyof typeof ja;
