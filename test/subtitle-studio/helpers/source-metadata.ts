import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';

/** Exercise real metadata-only drift without rounding/restoring content mtime. */
export function touchSourceMetadata(filePath: string) {
  const before = lstatSync(filePath, { bigint: true });
  readFileSync(filePath);
  try { chmodSync(filePath, 0o444); }
  finally { chmodSync(filePath, Number(before.mode) & 0o777); }
  const after = lstatSync(filePath, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
  expect(after.size).toBe(before.size);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
}
