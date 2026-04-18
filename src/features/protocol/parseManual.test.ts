import { parseManualProtocol } from './parseManual';

describe('parseManualProtocol', () => {
  test('sourceType=manual、filename は空、preview は空白畳み', () => {
    const result = parseManualProtocol('RQ:\n  本文です');
    expect(result.sourceType).toBe('manual');
    expect(result.sourceFilename).toBe('');
    expect(result.plainText).toBe('RQ:\n  本文です');
    expect(result.preview).toBe('RQ: 本文です');
  });
});
