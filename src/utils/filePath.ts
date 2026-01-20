export const getFilePathFromFile = (file: File): string | undefined => {
  return (file as any)?.path as string | undefined;
};

export const getDirFromPath = (filePath: string): string => {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep === -1) return "";
  if (lastSep === 0) return filePath.slice(0, 1);
  if (lastSep === 2 && filePath[1] === ":") return filePath.slice(0, 3);
  return filePath.slice(0, lastSep);
};

export const getSourceDirFromFile = (file: File): string | undefined => {
  const filePath = getFilePathFromFile(file);
  if (!filePath) return undefined;
  const dir = getDirFromPath(filePath);
  return dir || undefined;
};
