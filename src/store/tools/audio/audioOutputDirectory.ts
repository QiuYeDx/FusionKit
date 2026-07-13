export interface AudioOutputDirectoryAuthorization {
  outputDirToken: string;
  directoryName: string;
  expiresAt: number;
}

export function normalizeAudioOutputDirectoryLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "";
  return normalized.split(/[\\/]/).pop() ?? "";
}

export function isAudioOutputDirectoryAuthorizationValid(
  authorization: AudioOutputDirectoryAuthorization | null,
  directoryName: string,
  now = Date.now(),
): authorization is AudioOutputDirectoryAuthorization {
  return Boolean(
    authorization &&
      authorization.outputDirToken &&
      Number.isFinite(authorization.expiresAt) &&
      authorization.expiresAt > now &&
      authorization.directoryName === directoryName,
  );
}
