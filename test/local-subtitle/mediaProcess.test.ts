import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY,
  buildLocalSubtitleMediaEnvironment,
  runLocalSubtitleMediaProcess,
  type LocalSubtitleMediaProcessRunner,
} from "../../electron/main/local-subtitle/media-process";

describe("local subtitle native media environment", () => {
  it("builds a frozen macOS allowlist without inherited PATH or secrets", () => {
    const roots = hostRoots();
    const environment = buildLocalSubtitleMediaEnvironment({
      platform: "darwin",
      mediaDirectory: roots.media,
      tempDirectory: roots.temp,
      sourceEnvironment: {
        PATH: path.join(roots.root, "malicious-bin"),
        HOME: path.join(roots.root, "home"),
        HTTPS_PROXY: "https://user:secret@example.invalid",
        OPENAI_API_KEY: "secret",
        TMPDIR: path.join(roots.root, "untrusted-temp"),
      },
    });

    expect(environment).toEqual({
      PATH: roots.media,
      LANG: "C",
      LC_ALL: "C",
      TEMP: roots.temp,
      TMP: roots.temp,
      TMPDIR: roots.temp,
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("adds only controlled Windows system locations with target delimiters", () => {
    const roots = hostRoots();
    const systemRoot = path.join(roots.root, "Windows");
    const programFiles = path.join(roots.root, "Program Files");
    const environment = buildLocalSubtitleMediaEnvironment({
      platform: "win32",
      mediaDirectory: roots.media,
      tempDirectory: roots.temp,
      sourceEnvironment: {
        PATH: path.join(roots.root, "untrusted"),
        PATHEXT: ".BAT;.CMD",
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        ProgramFiles: programFiles,
        ProgramW6432: programFiles,
        HTTP_PROXY: "http://secret@example.invalid",
      },
    });

    expect(environment).toEqual({
      PATH: `${roots.media};${path.join(systemRoot, "System32")}`,
      LANG: "C",
      LC_ALL: "C",
      TEMP: roots.temp,
      TMP: roots.temp,
      PATHEXT: ".COM;.EXE",
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ProgramFiles: programFiles,
      ProgramW6432: programFiles,
    });
    expect(environment).not.toHaveProperty("HTTP_PROXY");
  });

  it("rejects unsafe paths without reflecting them in the error", () => {
    const secret = "relative/private-secret";
    expect(() =>
      buildLocalSubtitleMediaEnvironment({
        platform: "darwin",
        mediaDirectory: secret,
        tempDirectory: hostRoots().temp,
      }),
    ).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(secret) }),
    );
  });
});

describe("local subtitle native media process", () => {
  it("uses the exact shell-free hidden process and piped stdio contract", async () => {
    const child = new FakeChild();
    let record:
      | {
          command: string;
          args: readonly string[];
          options: SpawnOptions;
        }
      | undefined;
    const runner: LocalSubtitleMediaProcessRunner = (command, args, options) => {
      record = { command, args, options };
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.write("ready\n");
        child.close(0, null);
      });
      return child.asChildProcess();
    };
    const request = validRequest({ runner });

    const result = await runLocalSubtitleMediaProcess(request);

    expect(record).toEqual({
      command: request.command,
      args: request.args,
      options: expect.objectContaining({
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    });
    expect(result).toMatchObject({
      status: "closed",
      spawned: true,
      exitCode: 0,
      signalCode: null,
      aborted: false,
      timedOut: false,
      outputExceeded: false,
    });
    expect(result.stdout.toString("utf8")).toBe("ready\n");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    {
      label: "stdout",
      stdout: "123456789",
      stderr: "",
      stdoutMaxBytes: 5,
      stderrMaxBytes: 16,
      expectedStdout: "12345",
      expectedStderr: "",
    },
    {
      label: "stderr",
      stdout: "ok",
      stderr: "abcdefgh",
      stdoutMaxBytes: 16,
      stderrMaxBytes: 4,
      expectedStdout: "ok",
      expectedStderr: "abcd",
    },
  ])("retains bounded output and stops after the $label cap", async (fixture) => {
    const child = new FakeChild({ closeOnSignal: "SIGTERM" });
    const streamed: Uint8Array[] = [];
    const result = await runLocalSubtitleMediaProcess(
      validRequest({
        runner: fakeRunner(child, () => {
          if (fixture.stdout) child.stdout.write(fixture.stdout);
          if (fixture.stderr) child.stderr.write(fixture.stderr);
        }),
        stdoutMaxBytes: fixture.stdoutMaxBytes,
        stderrMaxBytes: fixture.stderrMaxBytes,
        onStdoutChunk: (chunk) => streamed.push(chunk),
      }),
    );

    expect(result).toMatchObject({
      status: "closed",
      outputExceeded: true,
      timedOut: false,
      aborted: false,
    });
    expect(result.stdout.toString()).toBe(fixture.expectedStdout);
    expect(result.stderr.toString()).toBe(fixture.expectedStderr);
    expect(Buffer.concat(streamed.map((chunk) => Buffer.from(chunk))).toString())
      .toBe(fixture.expectedStdout);
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("streams progress without retaining or applying the capture byte cap", async () => {
    const child = new FakeChild();
    const streamed: Uint8Array[] = [];
    const result = await runLocalSubtitleMediaProcess(
      validRequest({
        runner: fakeRunner(child, () => {
          child.stdout.write("out_time_us=1000\nprogress=continue\n");
          child.stdout.write("out_time_us=2000\nprogress=end\n");
          child.close(0, null);
        }),
        stdoutMode: "stream",
        stdoutMaxBytes: 1,
        onStdoutChunk: (chunk) => streamed.push(chunk),
      }),
    );

    expect(result).toMatchObject({
      status: "closed",
      exitCode: 0,
      outputExceeded: false,
    });
    expect(result.stdout).toHaveLength(0);
    expect(Buffer.concat(streamed.map((chunk) => Buffer.from(chunk))).toString())
      .toBe(
        "out_time_us=1000\nprogress=continue\nout_time_us=2000\nprogress=end\n",
      );
    expect(child.killSignals).toEqual([]);
  });

  it.each([
    { failureMode: "synchronous", stdoutMode: "capture" },
    { failureMode: "asynchronous", stdoutMode: "capture" },
    { failureMode: "synchronous", stdoutMode: "stream" },
    { failureMode: "asynchronous", stdoutMode: "stream" },
  ] as const)(
    "stops after a $failureMode stdout callback failure in $stdoutMode mode without an unhandled rejection",
    async ({ failureMode, stdoutMode }) => {
      const child = new FakeChild({ closeOnSignal: "SIGTERM" });
      const unhandledRejection = vi.fn();
      process.on("unhandledRejection", unhandledRejection);
      try {
        const result = await runLocalSubtitleMediaProcess(
          validRequest({
            runner: fakeRunner(child, () => {
              child.stdout.write("progress=continue\n");
            }),
            stdoutMode,
            onStdoutChunk: () => {
              if (failureMode === "synchronous") {
                throw new Error("sync callback failure");
              }
              return Promise.reject(new Error("async callback failure"));
            },
          }),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(result).toMatchObject({
          status: "closed",
          stdioErrorCode: "STDOUT_CALLBACK_FAILED",
        });
        expect(child.killSignals).toEqual(["SIGTERM"]);
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandledRejection);
      }
    },
  );

  it("rejects a pending stdout thenable immediately without awaiting it", async () => {
    const child = new FakeChild({ closeOnSignal: "SIGTERM" });
    let releaseCallbacks!: () => void;
    const callbacksPending = new Promise<void>((resolve) => {
      releaseCallbacks = resolve;
    });
    const result = await runLocalSubtitleMediaProcess(
      validRequest({
        runner: fakeRunner(child, () => {
          child.stdout.write("first\n");
        }),
        stdoutMode: "stream",
        onStdoutChunk: () => callbacksPending,
      }),
    );

    expect(result).toMatchObject({
      status: "closed",
      stdioErrorCode: "STDOUT_CALLBACK_FAILED",
    });
    expect(child.killSignals).toEqual(["SIGTERM"]);
    releaseCallbacks();
  });

  it("does not spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn<LocalSubtitleMediaProcessRunner>();

    await expect(
      runLocalSubtitleMediaProcess(validRequest({
        runner,
        signal: controller.signal,
      })),
    ).resolves.toMatchObject({
      status: "closed",
      spawned: false,
      aborted: true,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("aborts a running process and retains stderr written before close", async () => {
    const controller = new AbortController();
    const child = new FakeChild({ closeOnSignal: "SIGKILL" });
    child.onKill = (signal) => {
      if (signal === "SIGKILL") child.stderr.write("late shutdown\n");
    };
    const promise = runLocalSubtitleMediaProcess(validRequest({
      runner: fakeRunner(child, () => controller.abort()),
      signal: controller.signal,
      terminateGraceMs: 5,
      forceKillGraceMs: 20,
    }));

    const result = await promise;

    expect(result).toMatchObject({
      status: "closed",
      aborted: true,
      timedOut: false,
      signalCode: "SIGKILL",
    });
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.stderr.toString()).toContain("late shutdown");
  });

  it("retries termination when abort wins the race before spawn", async () => {
    const controller = new AbortController();
    const child = new FakeChild({ pid: undefined });
    const promise = runLocalSubtitleMediaProcess(validRequest({
      runner: () => {
        queueMicrotask(() => controller.abort());
        setTimeout(() => {
          child.pid = 42_002;
          child.emit("spawn");
        }, 0);
        return child.asChildProcess();
      },
      signal: controller.signal,
    }));

    await expect(promise).resolves.toMatchObject({
      status: "closed",
      spawned: true,
      aborted: true,
      signalCode: "SIGTERM",
    });
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("returns bounded close_unconfirmed after timeout and kill escalation", async () => {
    const child = new FakeChild({ closeOnSignal: "never" });
    const startedAt = Date.now();
    const result = await runLocalSubtitleMediaProcess(validRequest({
      runner: fakeRunner(child),
      timeoutMs: 5,
      terminateGraceMs: 5,
      forceKillGraceMs: 5,
    }));

    expect(result).toMatchObject({
      status: "close_unconfirmed",
      timedOut: true,
      aborted: false,
      exitCode: null,
      signalCode: null,
    });
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(1);
    expect(child.listenerCount("close")).toBe(1);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stdout.listenerCount("error")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("error")).toBe(1);

    let closeConfirmed = false;
    void result.closeConfirmed.then(() => {
      closeConfirmed = true;
    });
    await Promise.resolve();
    expect(closeConfirmed).toBe(false);

    child.close(null, "SIGKILL");
    await result.closeConfirmed;
    expect(closeConfirmed).toBe(true);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("error")).toBe(0);
    expect(child.stderr.listenerCount("error")).toBe(0);
  });

  it("returns path-free synchronous and asynchronous spawn errors", async () => {
    const secretPath = path.join(hostRoots().root, "private-media");
    const syncError = Object.assign(new Error(`cannot launch ${secretPath}`), {
      code: "ENOENT",
    });
    const syncResult = await runLocalSubtitleMediaProcess(validRequest({
      runner: () => {
        throw syncError;
      },
    }));
    const asyncChild = new FakeChild({ pid: undefined });
    const asyncResultPromise = runLocalSubtitleMediaProcess(validRequest({
      runner: (_command, _args, _options) => {
        queueMicrotask(() => {
          asyncChild.emit("error", syncError);
        });
        return asyncChild.asChildProcess();
      },
    }));
    const asyncResult = await asyncResultPromise;

    for (const result of [syncResult, asyncResult]) {
      expect(result).toMatchObject({
        status: "spawn_error",
        spawned: false,
        spawnErrorCode: "ENOENT",
      });
      expect(JSON.stringify(result)).not.toContain(secretPath);
    }
    await syncResult.closeConfirmed;
    let asyncCloseConfirmed = false;
    void asyncResult.closeConfirmed.then(() => {
      asyncCloseConfirmed = true;
    });
    await Promise.resolve();
    expect(asyncCloseConfirmed).toBe(false);
    expect(asyncChild.listenerCount("close")).toBe(1);
    expect(asyncChild.stdout.listenerCount("error")).toBe(1);
    asyncChild.stdout.emit("error", Object.assign(new Error("late pipe"), {
      code: "ENOTCONN",
    }));
    asyncChild.close(null, null);
    await asyncResult.closeConfirmed;
    expect(asyncCloseConfirmed).toBe(true);
    expect(asyncChild.listenerCount("close")).toBe(0);
    expect(asyncChild.stdout.listenerCount("error")).toBe(0);
  });

  it("kills a real long-lived child when its stdout exceeds the cap", async () => {
    const result = await runLocalSubtitleMediaProcess(validRequest({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)",
      ],
      stdoutMaxBytes: 32,
      timeoutMs: 5_000,
      terminateGraceMs: 100,
      forceKillGraceMs: 500,
    }));

    expect(result.status).toBe("closed");
    expect(result.outputExceeded).toBe(true);
    expect(result.stdout).toHaveLength(32);
    expect(result.signalCode).not.toBeNull();
  });

  it("times out and closes a real long-lived child", async () => {
    const result = await runLocalSubtitleMediaProcess(validRequest({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30,
      terminateGraceMs: 100,
      forceKillGraceMs: 500,
    }));

    expect(result).toMatchObject({
      status: "closed",
      spawned: true,
      timedOut: true,
      aborted: false,
      outputExceeded: false,
    });
  });

  it("keeps the exported process policy immutable", () => {
    expect(Object.isFrozen(LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY)).toBe(true);
    expect(LOCAL_SUBTITLE_MEDIA_PROCESS_POLICY.stdoutMaxBytes).toBe(
      1024 * 1024,
    );
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  readonly closeOnSignal: NodeJS.Signals | "never";
  pid: number | undefined;
  onKill: (signal: NodeJS.Signals) => void = () => undefined;
  closed = false;

  constructor(options: {
    readonly closeOnSignal?: NodeJS.Signals | "never";
    readonly pid?: number;
  } = {}) {
    super();
    this.closeOnSignal = options.closeOnSignal ?? "SIGTERM";
    this.pid = Object.prototype.hasOwnProperty.call(options, "pid")
      ? options.pid
      : 42_001;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    const normalized = typeof signal === "number" ? "SIGTERM" : signal;
    this.killSignals.push(normalized);
    this.onKill(normalized);
    if (this.closeOnSignal === normalized) {
      queueMicrotask(() => this.close(null, normalized));
    }
    return true;
  }

  close(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signalCode);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function fakeRunner(
  child: FakeChild,
  afterSpawn: () => void = () => undefined,
): LocalSubtitleMediaProcessRunner {
  return () => {
    queueMicrotask(() => {
      child.emit("spawn");
      afterSpawn();
    });
    return child.asChildProcess();
  };
}

function validRequest(
  overrides: Partial<Parameters<typeof runLocalSubtitleMediaProcess>[0]> = {},
): Parameters<typeof runLocalSubtitleMediaProcess>[0] {
  const roots = hostRoots();
  return {
    command: process.execPath,
    args: ["--version"],
    cwd: path.resolve(os.tmpdir()),
    env: { PATH: roots.media },
    timeoutMs: 1_000,
    terminateGraceMs: 20,
    forceKillGraceMs: 20,
    ...overrides,
  };
}

function hostRoots() {
  const root = path.resolve(os.tmpdir(), "fusionkit-media-process-test");
  return {
    root,
    media: path.join(root, "media"),
    temp: path.join(root, "temp"),
  };
}
