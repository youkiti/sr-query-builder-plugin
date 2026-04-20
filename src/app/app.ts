import { createLocationOptions, startApp } from './bootstrap';
import { mountCodeMirrorFormulaEditor } from './views/formulaEditorCodeMirror';

startApp(document, {
  ...createLocationOptions(window),
  enhanceFormulaEditor: mountCodeMirrorFormulaEditor,
});
