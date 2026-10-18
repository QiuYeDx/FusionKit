import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_SUBTITLE_ERROR_CODES } from "@/type/localSubtitle";
import {
  LOCAL_SUBTITLE_PAGE_MESSAGE_KEYS,
  localSubtitleErrorDiagnostics,
  localSubtitleErrorGuide,
  localSubtitleErrorView,
} from "./localSubtitleErrorGuide";

const LANGUAGES = ["zh", "zh-Hant", "en", "ja"] as const;
const catalogs = Object.fromEntries(LANGUAGES.map((language) => [language, {
  subtitle: JSON.parse(readFileSync(`src/locales/${language}/subtitle.json`, "utf8")),
  common: JSON.parse(readFileSync(`src/locales/${language}/common.json`, "utf8")),
}])) as unknown as Record<(typeof LANGUAGES)[number], Record<string, unknown>>;
const lookup = (language: (typeof LANGUAGES)[number], key: string) => {
  const [namespace, path] = key.split(":") as [string, string];
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalogs[language][namespace]);
};
/** i18next's t for the Chinese catalog: a missing key comes back as the key itself. */
const zh = (key: string) => {
  const value = lookup("zh", key);
  return typeof value === "string" ? value : key;
};

describe("classic transcriber error guide", () => {
  it("gives every error code its own cause in plain words in all four languages", () => {
    for (const code of LOCAL_SUBTITLE_ERROR_CODES) {
      for (const cpuRetry of [false, true]) {
        const guide = localSubtitleErrorGuide(code, { cpuRetry });
        // Every code this version knows has wording of its own, not the generic "did not finish".
        expect(guide.generic, code).toBe(false);
        for (const language of LANGUAGES) {
          const cause = lookup(language, guide.causeKey);
          expect(typeof cause, `${language} ${code} ${guide.causeKey}`).toBe("string");
          // Plain words: no error codes or developer terms in what the user reads.
          expect(cause as string).not.toMatch(/[a-z]+_[a-z]+|Whisper|ffprobe|runtime|VAD/);
          if (guide.nextKey) expect(typeof lookup(language, guide.nextKey), `${language} ${code} ${guide.nextKey}`).toBe("string");
        }
      }
    }
  });

  it("names \"Retry on CPU\" only where that button is shown", () => {
    for (const code of LOCAL_SUBTITLE_ERROR_CODES) {
      const next = localSubtitleErrorGuide(code).nextKey;
      if (next) for (const language of LANGUAGES) expect(lookup(language, next), `${language} ${code}`).not.toMatch(/CPU 重试|CPU 重試|Retry on CPU|CPU で再試行/);
    }
    expect(localSubtitleErrorGuide("runtime_crashed", { cpuRetry: true }).nextKey).toBe("subtitle:local_transcriber.error_guide.runtime_crashed.next_cpu");
    expect(lookup("zh", localSubtitleErrorGuide("transcription_failed", { cpuRetry: true }).nextKey!)).toContain("改用 CPU 重试");
    // Codes the CPU retry does not cover keep the plain step even when asked.
    expect(localSubtitleErrorGuide("model_corrupt", { cpuRetry: true }).nextKey).toBe("subtitle:local_transcriber.error_guide.verify.next");
  });

  it("leads failed downloads to the network settings and the help, and runtime failures to the help", () => {
    expect(localSubtitleErrorGuide("model_download_failed")).toMatchObject({ actions: ["open_network_settings", "open_help"], helpSection: "download-failed" });
    expect(localSubtitleErrorGuide("model_corrupt")).toMatchObject({ actions: ["open_network_settings", "open_help"], helpSection: "download-failed" });
    expect(localSubtitleErrorGuide("runtime_crashed")).toMatchObject({ actions: ["open_help"], helpSection: "transcription-failed" });
    expect(localSubtitleErrorGuide("insufficient_disk")).toMatchObject({ helpSection: "transcription-failed" });
    expect(localSubtitleErrorGuide("output_conflict").actions).toEqual([]);
  });

  it("explains a failed hand-off to the subtitle translator and leads there", () => {
    expect(localSubtitleErrorGuide("duplicate")).toMatchObject({ causeKey: "subtitle:local_transcriber.error_guide.duplicate.cause", actions: ["open_translator"] });
    expect(localSubtitleErrorGuide("import_failed")).toMatchObject({ causeKey: "subtitle:local_transcriber.error_guide.import_failed.cause", actions: ["open_translator"] });
    expect(localSubtitleErrorGuide("start_rejected").causeKey).toBe("subtitle:local_transcriber.error_guide.not_started.cause");
    expect(localSubtitleErrorGuide("estimate_failed").causeKey).toBe("subtitle:local_transcriber.error_guide.not_started.cause");
    expect(localSubtitleErrorGuide("profile_unavailable").actions).toEqual(["open_model_settings", "open_translator"]);
    expect(localSubtitleErrorGuide("unsupported_format").actions).toEqual([]);
    expect(localSubtitleErrorGuide("owner_released").causeKey).toBe("subtitle:local_transcriber.error_guide.page_stale.cause");
  });

  it("reuses the environment, shared-resource and translation hand-off wording for their codes", () => {
    expect(localSubtitleErrorGuide("runtime_missing")).toMatchObject({
      causeKey: "subtitle:local_transcriber.environment.error.runtime_missing",
      nextKey: "subtitle:local_transcriber.environment.error.recovery",
    });
    expect(localSubtitleErrorGuide("resource_busy").causeKey).toBe("subtitle:local_transcriber.resources.shared_busy_error");
    expect(localSubtitleErrorGuide("profile_required").causeKey).toBe("subtitle:local_transcriber.post_action.error.profile_required");
    expect(localSubtitleErrorGuide("no_speech_detected").causeKey).toBe("common:transcription_empty.message");
    // A code from a newer main process, or no code at all: the generic wording.
    expect(localSubtitleErrorGuide("something_new")).toMatchObject({ causeKey: "subtitle:local_transcriber.error_guide.unknown.cause", generic: true });
    expect(localSubtitleErrorGuide(undefined)).toMatchObject({ causeKey: "subtitle:local_transcriber.error_guide.unknown.cause", generic: true });
  });

  it("keeps the developer step out of what installed builds show", () => {
    for (const language of LANGUAGES) {
      expect(lookup(language, "subtitle:local_transcriber.environment.error.recovery") as string).not.toMatch(/源码|原始碼|source|ソース/);
    }
    expect(lookup("zh", "subtitle:local_transcriber.environment.error.recovery_dev")).toContain("源码");
  });

  it("puts the original message, code, stage and field into the copyable diagnostics", () => {
    expect(localSubtitleErrorDiagnostics({ message: "Model download failed.", code: "model_download_failed", stage: "downloading", field: "url" }))
      .toBe("Model download failed.\ncode: model_download_failed\nstage: downloading\nfield: url");
    expect(localSubtitleErrorDiagnostics({ message: "x" })).toBe("x");
  });
});

describe("classic transcriber error notice wording", () => {
  it("keeps the page's own restart message for a stale page instead of advising a reinstall", () => {
    // index.tsx reports a page that still runs the old bridge with this code and its own message.
    const message = zh("subtitle:local_transcriber.error.bridge_protocol_mismatch");
    const view = localSubtitleErrorView({ code: "runtime_protocol_mismatch", message }, zh);
    expect(view.cause).toBe(message);
    expect(view.cause).toContain("重新启动 FusionKit");
    expect(view.next).toBeUndefined();
    expect(view.diagnostics).toBe(`${message}\ncode: runtime_protocol_mismatch`);
    // The same code from the environment check still gets the environment wording and next step.
    expect(localSubtitleErrorView({ code: "runtime_protocol_mismatch", message: "Runner protocol mismatch." }, zh))
      .toMatchObject({ cause: zh("subtitle:local_transcriber.environment.error.runtime_protocol_mismatch"), next: zh("subtitle:local_transcriber.environment.error.recovery") });
  });

  it("says which operation failed and why for a failed manual hand-off", () => {
    const message = zh("subtitle:local_transcriber.post_action.manual_failed");
    expect(localSubtitleErrorView({ code: "artifact_expired", message }, zh)).toMatchObject({
      headline: message,
      cause: zh("subtitle:local_transcriber.error_guide.artifact.cause"),
      next: zh("subtitle:local_transcriber.error_guide.artifact.next"),
    });
    expect(localSubtitleErrorView({ code: "duplicate", message }, zh)).toMatchObject({
      headline: message,
      cause: zh("subtitle:local_transcriber.error_guide.duplicate.cause"),
      actions: ["open_translator"],
    });
    // A code this version does not know: the page's words are the cause, with the generic next step.
    expect(localSubtitleErrorView({ code: "something_new", message }, zh)).toMatchObject({
      cause: message,
      next: zh("subtitle:local_transcriber.error_guide.unknown.next"),
      diagnostics: `${message}\ncode: something_new`,
    });
  });

  it("does not show raw English without a code; it goes to the diagnostics", () => {
    const view = localSubtitleErrorView({ message: "Error invoking remote method 'local-subtitle:create-batch': Error: boom" }, zh);
    expect(view).toMatchObject({
      cause: zh("subtitle:local_transcriber.error_guide.unknown.cause"),
      next: zh("subtitle:local_transcriber.error_guide.unknown.next"),
      diagnostics: "Error invoking remote method 'local-subtitle:create-batch': Error: boom",
    });
    expect(view.headline).toBeUndefined();
  });

  it("lets the place it is shown in give the cause and the next step, keeping the original for diagnostics", () => {
    const error = { code: "invalid_ipc_request", stage: "ipc", message: "The request was rejected." };
    const view = localSubtitleErrorView(error, zh, { cause: "无法完成本地运行环境检查。", guidance: "请先点“重新检查环境”。" });
    expect(view).toMatchObject({ cause: "无法完成本地运行环境检查。", next: "请先点“重新检查环境”。", diagnostics: "The request was rejected.\ncode: invalid_ipc_request\nstage: ipc" });
  });

  it("knows the page's own messages in every language", () => {
    for (const key of LOCAL_SUBTITLE_PAGE_MESSAGE_KEYS) {
      for (const language of LANGUAGES) expect(typeof lookup(language, key), `${language} ${key}`).toBe("string");
    }
  });
});
