export function joinPath(parentPath: string, childName: string): string {
  const separator = getPathSeparator(parentPath);
  if (!parentPath) return childName;
  if (parentPath.endsWith("/") || parentPath.endsWith("\\")) {
    return `${parentPath}${childName}`;
  }
  return `${parentPath}${separator}${childName}`;
}

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? filePath;
}

export function pathDirname(filePath: string): string {
  const separator = getPathSeparator(filePath);
  const normalized = filePath.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    if (/^[A-Za-z]:[\\/][^\\/]+$/.test(filePath)) {
      return filePath.slice(0, 3);
    }
    return slashIndex === 0 ? "/" : "";
  }

  const dirname = normalized.slice(0, slashIndex);
  return separator === "\\" ? dirname.replace(/\//g, "\\") : dirname;
}

export function pathExtension(name: string): string {
  const basename = pathBasename(name);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return basename.slice(dotIndex);
}

export function pathStem(name: string): string {
  const basename = pathBasename(name);
  const extension = pathExtension(basename);
  return extension ? basename.slice(0, -extension.length) : basename;
}

export function normalizePathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

export function samePath(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function isRootLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/g, "");
  return (
    normalized === "" ||
    normalized === "/" ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized === "/Users" ||
    normalized === "/System" ||
    normalized === "/Library" ||
    normalized === "/Applications"
  );
}

function getPathSeparator(filePath: string): "/" | "\\" {
  return filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/";
}
