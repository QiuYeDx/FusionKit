export const getFilePathFromFile = (file: File): string | undefined => {
  // Electron 24+: 使用 webUtils.getPathForFile() 获取文件路径
  // 在 contextIsolation: true 的情况下，File.path 不可用
  if (typeof window !== 'undefined' && window.electronUtils?.getPathForFile) {
    try {
      const path = window.electronUtils.getPathForFile(file);
      return path || undefined;
    } catch {
      // 如果 electronUtils 不可用，尝试 fallback
    }
  }
  // Fallback: 直接访问 file.path（仅在 contextIsolation: false 时有效）
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
