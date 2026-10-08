/** ハイフン区切りの ID を PascalCase にする（'import-documents' → 'ImportDocuments'）。 */
function pascalCase(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** ツアー ID から文言キーの共通部分を作る（'getting-started' → 'guide.tourGettingStarted'）。 */
export function tourKeyBase(tourId: string): string {
  return `guide.tour${pascalCase(tourId)}`;
}

/** ツアーの見出しの文言キーを作る。 */
export function tourTitleKey(base: string): string {
  return `${base}Title`;
}

/** ツアーの説明の文言キーを作る。 */
export function tourDescKey(base: string): string {
  return `${base}Desc`;
}

/** 手順の本文の文言キーを作る（'import-documents' → '<base>StepImportDocuments'）。 */
export function stepKey(base: string, stepId: string): string {
  return `${base}Step${pascalCase(stepId)}`;
}
