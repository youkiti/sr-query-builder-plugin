export function getExtensionVersion(): string | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) {
      return null;
    }
    const version = chrome.runtime.getManifest().version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}
