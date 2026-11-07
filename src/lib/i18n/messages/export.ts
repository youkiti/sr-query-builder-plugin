// exportView.ts、methodsText.ts の文言を置く。
import type { TranslatedMessages } from './types';

export const exportJa = {} as const;

export const exportEn: TranslatedMessages<typeof exportJa> = {};
