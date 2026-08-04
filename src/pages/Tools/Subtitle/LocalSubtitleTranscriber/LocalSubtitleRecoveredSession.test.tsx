import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalSubtitleRecoveredSessionSummary } from "@/type/localSubtitle";
import { LocalSubtitleRecoveredSession } from "./LocalSubtitleRecoveredSession";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("LocalSubtitleRecoveredSession", () => {
  it("renders path-free history without task or artifact actions", () => {
    const markup = renderToStaticMarkup(
      createElement(LocalSubtitleRecoveredSession, { summary: recovered() }),
    );

    expect(markup).toContain("local-subtitle-recovered-session");
    expect(markup).toContain("media-task-1.wav");
    expect(markup).toContain("runtime_crashed");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("artifactRef");
    expect(markup).not.toContain("reveal");
    expect(markup).not.toContain("handoff");
  });

  it("does not render an empty recovered session", () => {
    expect(renderToStaticMarkup(
      createElement(LocalSubtitleRecoveredSession, {
        summary: { ...recovered(), batches: [] },
      }),
    )).toBe("");
  });
});

function recovered(): LocalSubtitleRecoveredSessionSummary {
  return {
    build: {
      engine: "whisper_cpp",
      version: "v1.9.1",
      commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
    },
    batches: [{
      batchId: "batch-1",
      status: "interrupted",
      tasks: [{
        taskId: "task-1",
        batchId: "batch-1",
        generation: 1,
        displayName: "media-task-1.wav",
        status: "interrupted",
        stage: "transcribing",
        formats: ["SRT"],
        backend: "cpu",
        artifactResults: [],
        errorCode: "runtime_crashed",
        createdAt: "2026-08-04T08:00:00.000Z",
        updatedAt: "2026-08-04T09:00:00.000Z",
      }],
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T09:00:00.000Z",
    }],
    updatedAt: "2026-08-04T09:00:00.000Z",
  };
}
