import type { LocalSubtitleError } from "@/type/localSubtitle";

export interface LocalSubtitleDisplayError {
  readonly code?: string;
  readonly message: string;
}

export function LocalSubtitleErrorNotice({
  error,
  guidance,
}: {
  error: LocalSubtitleDisplayError | LocalSubtitleError;
  guidance?: string;
}) {
  return (
    <div
      data-testid="local-subtitle-error"
      className="w-full min-w-0 max-w-full overflow-hidden rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs"
    >
      <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {error.message}
      </div>
      {error.code ? (
        <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          code: {error.code}
        </div>
      ) : null}
      {guidance ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
          {guidance}
        </div>
      ) : null}
    </div>
  );
}
