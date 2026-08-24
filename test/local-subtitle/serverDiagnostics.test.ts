import { describe, expect, it } from "vitest";
import {
  LocalSubtitleServerDiagnosticCollector,
  createLocalSubtitleServerDiagnosticCollector,
} from "../../electron/main/local-subtitle/server-diagnostics";
import { localSubtitleDiagnosticsSchema } from "@/type/localSubtitleIpc";
import { LOCAL_SUBTITLE_LIMITS } from "@/type/localSubtitle";

describe("local subtitle server diagnostics", () => {
  it("collects only sanitized stdout and stderr into the shared schema", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector({
      summary: "\u001b[31mServer failed\u001b[0m\u0000",
      metadata: {
        attempt: 2,
        maxAttempts: 3,
        httpStatus: 500,
        backend: "metal",
      },
    });

    collector.append("stdout", "\u001b[32mloading model\u001b[0m\n");
    collector.append("stderr", "bad\u0000control\tvalue\n");
    const diagnostics = collector.finish();

    expect(diagnostics).toEqual({
      summary: "Server failed",
      lines: ["[stdout] loading model", "[stderr] badcontrol value"],
      metadata: {
        attempt: 2,
        maxAttempts: 3,
        httpStatus: 500,
        backend: "metal",
      },
      truncated: false,
    });
    expect(localSubtitleDiagnosticsSchema.safeParse(diagnostics).success).toBe(
      true,
    );
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.lines)).toBe(true);
  });

  it("redacts exact private values even when values and UTF-8 bytes cross chunks", () => {
    const privatePath = "/Users/private/models/ggml-large-v3-q5_0.bin";
    const privateToken = "fusionkit-private-value-0123456789";
    const collector = new LocalSubtitleServerDiagnosticCollector({
      privateValues: [privatePath, privateToken],
    });
    const encoded = new TextEncoder().encode(
      `模型=${privatePath} token=${privateToken}\n`,
    );
    const multibyteSplit = encoded.indexOf(0xe5) + 1;
    const secretSplit = Math.floor(encoded.length / 2);

    collector.append("stderr", encoded.slice(0, multibyteSplit));
    collector.append("stderr", encoded.slice(multibyteSplit, secretSplit));
    collector.append("stderr", encoded.slice(secretSplit));
    const diagnostics = collector.finish();
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.lines).toEqual([
      "[stderr] 模型=[redacted] token=[redacted]",
    ]);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(privateToken);
    expect(serialized).not.toContain("�");
    expect(diagnostics.truncated).toBe(false);
  });

  it("redacts filesystem paths, private endpoints, credentials, and sensitive content", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector();
    const lines = [
      "model=/Users/alice/My Model/model.bin",
      String.raw`input=C:\Users\Alice\Media\sample.wav`,
      String.raw`unc=\\server\share\private\sample.wav`,
      "uri=file:///Users/alice/Media/sample.wav",
      String.raw`json={"path":"C:\\Users\\Alice\\private.wav"}`,
      "endpoint=http://127.0.0.1:43123/fusionkit-abcdef0123456789abcdef0123456789abcdef0123456789/inference",
      "private=/fusionkit-abcdef0123456789abcdef0123456789abcdef0123456789/health port=43123",
      "Authorization: Bearer sk-private-bearer-token",
      "apiKey=sk-test-12345678901234567890",
      "HTTPS_PROXY=http://proxy-user:proxy-pass@proxy.example:8080",
      "Proxy-Authorization: Basic dXNlcjpwYXNz",
      "prompt=never expose this user prompt",
      "initial_prompt=never expose this initial prompt",
      'payload={"initialPrompt":"never expose this JSON prompt"}',
      "transcript: never expose recognized speech",
      'payload={"httpBody":"never expose response body"}',
    ];
    collector.append("stderr", `${lines.join("\n")}\n`);

    const diagnostics = collector.finish();
    const output = diagnostics.lines?.join("\n") ?? "";

    for (const sensitive of [
      "/Users/alice",
      "C:\\Users",
      "server\\share",
      "127.0.0.1",
      "43123",
      "fusionkit-abcdef",
      "sk-private-bearer-token",
      "sk-test-12345678901234567890",
      "proxy-user",
      "proxy-pass",
      "dXNlcjpwYXNz",
      "never expose",
    ]) {
      expect(output).not.toContain(sensitive);
    }
    expect(output).toContain("[path]");
    expect(output).toContain("[endpoint]");
    expect(output).toContain("Authorization: [redacted]");
    expect(output).toContain("port=[redacted]");
    expect(localSubtitleDiagnosticsSchema.safeParse(diagnostics).success).toBe(
      true,
    );
  });

  it("rejects payload-like sources before their content enters the collector", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector();

    for (const source of ["httpBody", "prompt", "transcript"] as const) {
      expect(() =>
        collector.append(source as never, "private payload"),
      ).toThrow(/only stdout or stderr/u);
    }
    expect(collector.finish()).toEqual({ truncated: false });
    expect(() => collector.append("stderr", "late")).toThrow(/after finish/u);
  });

  it("retains only allowlisted scalar metadata and sanitizes its strings", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector({
      metadata: {
        exitCode: 9,
        signal: "SIGKILL",
        actual: "/private/runtime/whisper-server",
        path: "/must/not/be/accepted",
        observed: Number.NaN,
        expected: { nested: "not scalar" },
      },
    });
    const diagnostics = collector.finish();

    expect(diagnostics.metadata).toEqual({
      exitCode: 9,
      signal: "SIGKILL",
      actual: "[path]",
    });
    expect(diagnostics.metadata).not.toHaveProperty("path");
    expect(diagnostics.truncated).toBe(true);
    expect(localSubtitleDiagnosticsSchema.safeParse(diagnostics).success).toBe(
      true,
    );
  });

  it("enforces line, summary, line-count, and final UTF-8 byte bounds", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector({
      summary: "摘".repeat(3_000),
      metadata: { actual: "值".repeat(500) },
    });
    for (let index = 0; index < 400; index += 1) {
      collector.append("stderr", `${index}:${"字".repeat(2_000)}\n`);
    }
    const diagnostics = collector.finish();
    const serializedBytes = Buffer.byteLength(JSON.stringify(diagnostics), "utf8");

    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.summary?.length).toBeLessThanOrEqual(
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticSummaryChars,
    );
    expect(diagnostics.metadata?.actual?.toString().length).toBeLessThanOrEqual(
      256,
    );
    expect(diagnostics.lines?.length).toBeLessThanOrEqual(
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticLines,
    );
    expect(
      diagnostics.lines?.every(
        (line) => line.length <= LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars,
      ),
    ).toBe(true);
    expect(serializedBytes).toBeLessThanOrEqual(
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes,
    );
    expect(localSubtitleDiagnosticsSchema.safeParse(diagnostics).success).toBe(
      true,
    );
    expect(diagnostics.lines?.at(-1)).toContain("399:");
  });

  it("drops an unbounded unterminated line without retaining a partial secret", () => {
    const secret = "private-value-across-the-overflow-boundary";
    const collector = createLocalSubtitleServerDiagnosticCollector({
      privateValues: [secret],
    });
    collector.append("stderr", "x".repeat(300_000));
    collector.append("stderr", secret);
    collector.append("stderr", "\nvisible safe line\n");
    const diagnostics = collector.finish();

    expect(diagnostics.lines).toEqual(["[stderr] visible safe line"]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics.truncated).toBe(true);
  });

  it("does not split surrogate pairs when truncating a diagnostic line", () => {
    const collector = createLocalSubtitleServerDiagnosticCollector();
    collector.append("stdout", `${"a".repeat(1_014)}😀tail\n`);
    const diagnostics = collector.finish();
    const line = diagnostics.lines?.[0] ?? "";

    expect(line.length).toBeLessThanOrEqual(
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars,
    );
    expect(line.endsWith("\ud83d")).toBe(false);
    expect(line).not.toContain("�");
    expect(diagnostics.truncated).toBe(true);
    expect(localSubtitleDiagnosticsSchema.safeParse(diagnostics).success).toBe(
      true,
    );
  });
});
