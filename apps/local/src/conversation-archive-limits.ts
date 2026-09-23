export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_PASSAGES = 32_768;
export const MAX_VAULT_ARCHIVE_PASSAGES = 32_768;
export const MAX_PASSAGE_CHARACTERS = 8192;
export const MAX_ARCHIVE_BATCH = 8;
export const MAX_VAULT_ARCHIVES = 4096;
export const MAX_PENDING_ARCHIVES = 8;
export const MAX_VAULT_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function validArchiveText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum * 2 &&
    !/[\uD800-\uDFFF]/u.test(value) && Array.from(value).length <= maximum;
}
