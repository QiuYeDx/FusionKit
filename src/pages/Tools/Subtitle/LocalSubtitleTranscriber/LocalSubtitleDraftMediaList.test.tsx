import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { LocalSubtitleDraftMediaList } from "./LocalSubtitleDraftMediaList";
import type {
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleMediaProbeSummary,
} from "@/type/localSubtitleIpc";

describe("LocalSubtitleDraftMediaList", () => {
  it("shows the video format separately from unlabelled audio stream metadata", () => {
    const html = renderDraftMedia("episode.mp4", "und", "aac");

    expect(html).toContain("MP4 · AAC");
    expect(html).not.toContain("und · AAC");
  });

  it("does not repeat identical audio format and codec labels", () => {
    const html = renderDraftMedia("episode.mp3", undefined, "mp3");

    expect(html).toContain("MP3");
    expect(html).not.toContain("MP3 · MP3");
  });
});

function renderDraftMedia(
  displayName: string,
  language: string | undefined,
  codec: string,
): string {
  const file: LocalSubtitleAuthorizedMedia = {
    fileToken: "file-token",
    displayName,
    byteSize: 1024,
    expiresAt: 10_000,
  };
  const summary: LocalSubtitleMediaProbeSummary = {
    fileToken: file.fileToken,
    displayName,
    durationMs: 65_000,
    audioTracks: [
      {
        streamId: "stream-1",
        ordinal: 1,
        isDefault: true,
        ...(language === undefined ? {} : { language }),
        codec,
        channels: 2,
        sampleRateHz: 48_000,
      },
    ],
    autoSelectedStreamId: "stream-1",
  };

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LocalSubtitleDraftMediaList
        files={[file]}
        probes={new Map([
          [file.fileToken, { status: "ready" as const, summary }],
        ])}
        explicitAudioStreamIds={new Map()}
        disabled={false}
        probeQueuePending={false}
        onClear={() => undefined}
        onRemove={() => undefined}
        onRetryProbe={() => undefined}
        onAudioStreamChange={() => undefined}
      />
    </I18nextProvider>,
  );
}
