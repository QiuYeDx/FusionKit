import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  isOverwriteRecoveryCandidateEvent,
  LocalSubtitleOverwriteRecoveryList,
  RecoveryError,
} from "./LocalSubtitleOverwriteRecoveryPrompt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

const labels = {
  itemTitle: (code: string) => `Recovery ${code}`,
  recoveryCode: "Recovery code",
  format: "Format",
  createdAt: "Created",
  chooseDirectory: "Choose original folder",
  retry: "Retry recovery",
  working: "Recovering",
  directions: {
    finalize: "Complete replacement",
    rollback: "Restore previous file",
  },
  states: {
    not_started: "Awaiting confirmation",
    pending: "Recovery pending",
    retry_failed: "Retry required",
    settled: "Cleanup pending",
  },
} as const;

describe("LocalSubtitleOverwriteRecoveryList", () => {
  it("renders path-free recovery summaries without exposing opaque ids", () => {
    const markup = renderToStaticMarkup(
      <LocalSubtitleOverwriteRecoveryList
        items={[
          {
            recoveryId: "private-recovery-id",
            displayCode: "ABCDEF123456",
            format: "SRT",
            direction: "finalize",
            state: "pending",
            createdAt: 1_768_435_200_000,
            requiresDirectorySelection: true,
          },
        ]}
        actionRecoveryId={null}
        locale="en"
        labels={labels}
        onRecover={vi.fn()}
      />,
    );

    expect(markup).toContain("Recovery ABCDEF123456");
    expect(markup).toContain("Recovery code");
    expect(markup).toContain("Choose original folder");
    expect(markup).toMatch(
      /<button[^>]*>[\s\S]*Choose original folder[\s\S]*<\/button>/,
    );
    expect(markup).toContain("Complete replacement");
    expect(markup).not.toContain("private-recovery-id");
    expect(markup).not.toMatch(/taskId|recoveryId|outputPath|file:\/\//);
  });

  it("keeps rows shrinkable and exposes a stable working state", () => {
    const markup = renderToStaticMarkup(
      <LocalSubtitleOverwriteRecoveryList
        items={[
          {
            recoveryId: "working-recovery",
            displayCode: "123456ABCDEF",
            format: "LRC",
            direction: "rollback",
            state: "retry_failed",
            createdAt: 1_768_435_200_000,
            requiresDirectorySelection: false,
          },
        ]}
        actionRecoveryId="working-recovery"
        locale="ja"
        labels={labels}
        onRecover={vi.fn()}
      />,
    );

    expect(markup).toContain("min-w-0");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("Recovering");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("working-recovery");
  });

  it("falls back without throwing when createdAt is outside the JS Date range", () => {
    const markup = renderToStaticMarkup(
      <LocalSubtitleOverwriteRecoveryList
        items={[
          {
            recoveryId: "future-recovery",
            displayCode: "FEDCBA654321",
            format: "SRT",
            direction: "finalize",
            state: "pending",
            createdAt: Number.MAX_SAFE_INTEGER,
            requiresDirectorySelection: false,
          },
        ]}
        actionRecoveryId={null}
        locale="en"
        labels={labels}
        onRecover={vi.fn()}
      />,
    );

    expect(markup).toContain(String(Number.MAX_SAFE_INTEGER));
    expect(markup).not.toContain("future-recovery");
  });
});

describe("RecoveryError", () => {
  it.each([
    ["output_write_failed", "recovery_pending"],
    ["resource_busy", "invalid_state"],
    ["directory_authorization_required", "directory_authorization_required"],
    ["authorization_expired", "directory_authorization_required"],
  ])("maps %s to the expected user-facing recovery message", (code, key) => {
    const markup = renderToStaticMarkup(<RecoveryError code={code} />);

    expect(markup).toContain(
      `local_transcriber.overwrite_recovery.error.${key}`,
    );
    expect(markup).not.toContain("line-clamp-1");
  });
});

describe("overwrite recovery task event refresh", () => {
  it("recognizes output failures that can leave a pending recovery", () => {
    expect(isOverwriteRecoveryCandidateEvent({
      event: {
        type: "task-updated",
        task: {
          error: { code: "output_write_failed" },
          artifactResults: [],
        },
      },
    } as never)).toBe(true);
    expect(isOverwriteRecoveryCandidateEvent({
      event: {
        type: "task-updated",
        task: {
          artifactResults: [
            { status: "failed", errorCode: "output_write_failed" },
          ],
        },
      },
    } as never)).toBe(true);
    expect(isOverwriteRecoveryCandidateEvent({
      event: {
        type: "task-removed",
      },
    } as never)).toBe(false);
  });
});
