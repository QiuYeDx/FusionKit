import path from "path";

export function normalizePathKey(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

export function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function isPathInside(candidatePath: string, parentPath: string): boolean {
  if (samePath(candidatePath, parentPath)) return false;
  const relative = path.relative(parentPath, candidatePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function rewritePathPrefix(
  candidatePath: string | undefined,
  oldPrefix: string,
  newPrefix: string
): string | undefined {
  if (!candidatePath) return candidatePath;
  if (samePath(candidatePath, oldPrefix)) return newPrefix;
  if (!isPathInside(candidatePath, oldPrefix)) return candidatePath;
  return path.join(newPrefix, path.relative(oldPrefix, candidatePath));
}

export function getPathDepth(targetPath: string): number {
  return path
    .resolve(targetPath)
    .split(path.sep)
    .filter(Boolean).length;
}

export function isValidBasename(name: string): boolean {
  if (!name.trim()) return false;
  if (name === "." || name === "..") return false;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) return false;
  return !/[. ]+$/.test(name);
}
