import { v4 as uuidV4 } from 'uuid';

/**
 * UUID v4 を新規発番する。`project_id` 等で利用。
 */
export function newUuid(): string {
  return uuidV4();
}

/**
 * UUID の先頭 8 文字を返す（Drive フォルダ名などの短縮表示用）。
 */
export function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}
