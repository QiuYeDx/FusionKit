import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statSync, type Stats } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_POLICY,
  LocalSubtitleServerContractError,
  type LocalSubtitleServerInferenceRequest,
} from "../../electron/main/local-subtitle/server-contract";
import {
  LocalSubtitleServerHttpClient,
  type LocalSubtitleServerHttpClientDependencies,
  type LocalSubtitleServerHttpEndpoint,
} from "../../electron/main/local-subtitle/server-http-client";

const PRIVATE_PATH = `/fusionkit-${"a".repeat(48)}`;
let tempDirectory: string;
let windowPath: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-server-http-client-test-"),
  );
  windowPath = path.join(tempDirectory, "private-source-name.wav");
  await writeFile(windowPath, Buffer.from("RIFF-private-test-window", "utf8"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("LocalSubtitleServerHttpClient", () => {
  it("accepts only the exact private loopback endpoint", () => {
    expect(
      () =>
        new LocalSubtitleServerHttpClient({
          host: "localhost",
          port: 1234,
          privatePath: PRIVATE_PATH,
        } as never),
    ).toThrow(LocalSubtitleServerContractError);
    expect(
      () =>
        new LocalSubtitleServerHttpClient({
          host: "127.0.0.1",
          port: 1234,
          privatePath: "/fusionkit-short",
        }),
    ).toThrow(LocalSubtitleServerContractError);
    expect(
      () =>
        new LocalSubtitleServerHttpClient({
          host: "127.0.0.1",
          port: 1234,
          privatePath: PRIVATE_PATH,
          endpoint: "leak",
        } as never),
    ).toThrow(LocalSubtitleServerContractError);
  });

  it("uses the exact private health route and accepts strict reusable JSON", async () => {
    let observedMethod: string | undefined;
    let observedUrl: string | undefined;
    let observedRequestBytes = 0;
    const server = await startServer((request, response) => {
      observedMethod = request.method;
      observedUrl = request.url;
      request.on("data", (chunk) => {
        observedRequestBytes += chunk.length;
      });
      request.on("end", () => {
        sendJson(response, { status: "ok" }, {
          "Content-Type": "application/json; charset=utf-8",
        });
      });
    });

    try {
      const result = await clientFor(server.port).health();
      expect(result).toEqual({ sessionDisposition: "reusable" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(observedMethod).toBe("GET");
      expect(observedUrl).toBe(`${PRIVATE_PATH}/health`);
      expect(observedRequestBytes).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("keeps a startup readiness 503 reusable without exposing its body", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, { secret: "PRIVATE_RESPONSE_BODY" }, {}, 503);
    });
    try {
      const client = clientFor(server.port);
      const error = await captureContractError(client.probeReadiness());
      expect(error.code).toBe("http_error");
      expect(error.httpStatus).toBe(503);
      expect(error.sessionDisposition).toBe("reusable");
      expect(error.message).not.toContain("PRIVATE_RESPONSE_BODY");
      expect(client.sessionDisposition).toBe("reusable");
    } finally {
      await server.close();
    }
  });

  it.each([
    {
      name: "content type",
      headers: { "Content-Type": "text/plain" },
      body: Buffer.from('{"status":"ok"}'),
    },
    {
      name: "content encoding",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: Buffer.from('{"status":"ok"}'),
    },
    {
      name: "fatal UTF-8",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from([0xc3, 0x28]),
    },
  ])("rejects invalid health $name as a restart-required protocol error", async ({
    headers,
    body,
  }) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        ...headers,
        "Content-Length": String(body.length),
      });
      response.end(body);
    });
    try {
      const error = await captureContractError(clientFor(server.port).health());
      expect(error.sessionDisposition).toBe("restart_required");
      expect(error.localSubtitleCode).toBe("runtime_protocol_mismatch");
    } finally {
      await server.close();
    }
  });

  it("enforces both declared and actual 4 KiB health response limits", async () => {
    let requestCount = 0;
    const server = await startServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(
            LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxHealthResponseBytes + 1,
          ),
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      response.write(
        Buffer.alloc(
          LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxHealthResponseBytes + 1,
          0x20,
        ),
      );
      response.end();
    });

    try {
      expect((await captureContractError(clientFor(server.port).health())).code).toBe(
        "response_too_large",
      );
      expect((await captureContractError(clientFor(server.port).health())).code).toBe(
        "response_too_large",
      );
    } finally {
      await server.close();
    }
  });

  it("applies the strict health JSON schema after transport validation", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, { status: "ok", endpoint: PRIVATE_PATH });
    });
    try {
      const error = await captureContractError(clientFor(server.port).health());
      expect(error.code).toBe("invalid_response");
      expect(error.sessionDisposition).toBe("restart_required");
    } finally {
      await server.close();
    }
  });

  it("uses an absolute readiness deadline without tainting a starting client", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      const interval = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(interval));
    });
    try {
      const client = clientFor(server.port, { healthMs: 35 });
      const error = await captureContractError(client.probeReadiness());
      expect(error.code).toBe("timeout");
      expect(error.sessionDisposition).toBe("reusable");
    } finally {
      await server.close();
    }
  });

  it("taints a ready client after a runtime health failure", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, { status: "starting" }, {}, 503);
    });
    try {
      const client = clientFor(server.port);
      const error = await captureContractError(client.health());
      expect(error).toMatchObject({
        code: "http_error",
        httpStatus: 503,
        sessionDisposition: "restart_required",
      });
      expect(client.sessionDisposition).toBe("restart_required");
      await expect(client.probeReadiness()).rejects.toMatchObject({
        sessionDisposition: "restart_required",
      });
    } finally {
      await server.close();
    }
  });

  it("streams only fixed inference fields and the fixed window.wav filename", async () => {
    let requestBody = Buffer.alloc(0);
    let declaredLength = 0;
    let observedUrl: string | undefined;
    const server = await startServer(async (request, response) => {
      observedUrl = request.url;
      declaredLength = Number(request.headers["content-length"]);
      requestBody = await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const result = await clientFor(server.port).inference(
        validRequest(windowPath, { requestGeneration: 17 }),
      );
      const text = requestBody.toString("utf8");
      const names = [
        ...text.matchAll(
          /Content-Disposition: form-data; name="([^"]+)"/gu,
        ),
      ]
        .map((match) => match[1])
        .sort();
      expect(observedUrl).toBe(`${PRIVATE_PATH}/inference`);
      expect(declaredLength).toBe(requestBody.length);
      expect(requestBody.length).toBeLessThanOrEqual(
        LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxInferenceUploadBytes,
      );
      expect(text).toContain('name="file"; filename="window.wav"');
      expect(text).not.toContain(path.basename(windowPath));
      expect(names).toEqual([
        "beam_size",
        "file",
        "language",
        "no_language_probabilities",
        "no_timestamps",
        "prompt",
        "response_format",
        "temperature",
        "temperature_inc",
        "token_timestamps",
        "translate",
        "vad",
        "vad_min_silence_duration_ms",
      ]);
      expect(text).toContain("\r\nfalse\r\n");
      expect(result.requestGeneration).toBe(17);
      expect(result.sessionDisposition).toBe("reusable");
    } finally {
      await server.close();
    }
  });

  it("rejects an expected window identity mismatch before any network request", async () => {
    let requestCount = 0;
    const server = await startServer(async (request, response) => {
      requestCount += 1;
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const expectedFileIdentity = fileIdentity(statSync(windowPath));
      const error = await captureContractError(
        client.inference(
          validRequest(windowPath, {
            expectedFileIdentity: Object.freeze({
              ...expectedFileIdentity,
              ino: expectedFileIdentity.ino + 1,
            }),
          }),
        ),
      );

      expect(error).toMatchObject({
        code: "invalid_configuration",
        sessionDisposition: "reusable",
      });
      expect(requestCount).toBe(0);
      await expect(
        client.inference(
          validRequest(windowPath, { requestGeneration: 2 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 2 });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("claims the single-active inference ticket before the first await", async () => {
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let uploadObserved!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      uploadObserved = resolve;
    });
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      uploadObserved();
      await responseGate;
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const first = client.inference(validRequest(windowPath));
      const second = client.inference(
        validRequest(windowPath, { requestGeneration: 2 }),
      );
      const busy = await captureContractError(second);
      expect(busy.code).toBe("busy");
      expect(busy.sessionDisposition).toBe("reusable");
      await uploadGate;
      await expect(client.health()).rejects.toMatchObject({
        code: "busy",
        sessionDisposition: "reusable",
      });
      releaseResponse();
      await expect(first).resolves.toMatchObject({ requestGeneration: 1 });
    } finally {
      releaseResponse();
      await server.close();
    }
  });

  it("serializes readiness, runtime health, and inference operations", async () => {
    let releaseHealth!: () => void;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    let healthStarted!: () => void;
    const healthStart = new Promise<void>((resolve) => {
      healthStarted = resolve;
    });
    const server = await startServer(async (request, response) => {
      if (request.url?.endsWith("/health")) {
        healthStarted();
        await healthGate;
        sendJson(response, { status: "ok" });
        return;
      }
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const health = client.health();
      await healthStart;
      await expect(client.probeReadiness()).rejects.toMatchObject({ code: "busy" });
      await expect(
        client.inference(validRequest(windowPath)),
      ).rejects.toMatchObject({ code: "busy" });
      releaseHealth();
      await expect(health).resolves.toEqual({ sessionDisposition: "reusable" });
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      releaseHealth();
      await server.close();
    }
  });

  it("rejects relative, directory, and oversized uploads and releases their tickets", async () => {
    const directoryPath = path.join(tempDirectory, "window-directory");
    await mkdir(directoryPath);
    const oversizedPath = path.join(tempDirectory, "oversized.wav");
    const emptyPath = path.join(tempDirectory, "empty.wav");
    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(
      oversizedPath,
      Buffer.alloc(
        LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxInferenceUploadBytes,
        0,
      ),
    );
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      await expect(
        client.inference(validRequest("relative-window.wav")),
      ).rejects.toThrow(/absolute/u);
      await expect(
        client.inference(validRequest(directoryPath)),
      ).rejects.toThrow(/regular file/u);
      await expect(
        client.inference(validRequest(oversizedPath)),
      ).rejects.toThrow(/upload exceeds/u);
      await expect(
        client.inference(validRequest(emptyPath)),
      ).rejects.toThrow(/identity/u);
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 4 })),
      ).resolves.toMatchObject({ requestGeneration: 4 });
    } finally {
      await server.close();
    }
  });

  it("rejects a successful response that arrives before upload completion", async () => {
    const largeWindowPath = path.join(tempDirectory, "large-window.wav");
    await writeFile(largeWindowPath, Buffer.alloc(1_000_000, 0x31));
    const server = await startServer((_request, response) => {
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const error = await captureContractError(
        client.inference(validRequest(largeWindowPath)),
      );
      expect(error).toMatchObject({
        code: "invalid_response",
        sessionDisposition: "restart_required",
      });
      expect(error.message).toMatch(/before the upload completed/u);
    } finally {
      await server.close();
    }
  });

  it("holds one file identity for the complete streaming upload", async () => {
    const changingPath = path.join(tempDirectory, "changing-window.wav");
    await writeFile(changingPath, Buffer.alloc(1_000_000, 0x31));
    let uploadStarted!: () => void;
    const uploadStart = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    let mutationFinished!: () => void;
    const mutation = new Promise<void>((resolve) => {
      mutationFinished = resolve;
    });
    const server = await startServer((request, response) => {
      let observed = false;
      request.on("data", () => {
        if (observed) return;
        observed = true;
        request.pause();
        uploadStarted();
        void mutation.then(() => request.resume());
      });
      request.on("end", () => sendJson(response, validVerboseJson()));
    });

    try {
      const client = clientFor(server.port);
      const pending = captureContractError(
        client.inference(validRequest(changingPath)),
      );
      await uploadStart;
      await writeFile(changingPath, Buffer.alloc(1_000_000, 0x32));
      mutationFinished();

      const error = await pending;
      expect(error.code).toBe("invalid_response");
      expect(error.sessionDisposition).toBe("restart_required");
      expect(client.sessionDisposition).toBe("restart_required");
    } finally {
      mutationFinished();
      await server.close();
    }
  });

  it("does not expose a non-200 inference body and taints the client", async () => {
    let requestCount = 0;
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      requestCount += 1;
      if (requestCount === 1) {
        sendJson(response, { error: "PRIVATE_TRANSCRIPT_BODY" }, {}, 500);
      } else {
        sendJson(response, validVerboseJson());
      }
    });

    try {
      const client = clientFor(server.port);
      const error = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(error.code).toBe("http_error");
      expect(error.sessionDisposition).toBe("restart_required");
      expect(error.message).not.toContain("PRIVATE_TRANSCRIPT_BODY");
      expect(client.sessionDisposition).toBe("restart_required");
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
      await expect(
        clientFor(server.port).inference(
          validRequest(windowPath, { requestGeneration: 2 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      await server.close();
    }
  });

  it("rejects a declared inference response above 64 MiB before reading it", async () => {
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(
          LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxInferenceResponseBytes + 1,
        ),
      });
      response.end();
    });

    try {
      const error = await captureContractError(
        clientFor(server.port).inference(validRequest(windowPath)),
      );
      expect(error.code).toBe("response_too_large");
      expect(error.sessionDisposition).toBe("restart_required");
    } finally {
      await server.close();
    }
  });

  it("uses an absolute inference deadline and requires a new client", async () => {
    let requestCount = 0;
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      requestCount += 1;
      if (requestCount === 1) return;
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port, { inferenceMs: 35 });
      const timeout = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(timeout.code).toBe("timeout");
      expect(timeout.sessionDisposition).toBe("restart_required");
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
      await expect(
        clientFor(server.port, { inferenceMs: 35 }).inference(
          validRequest(windowPath, { requestGeneration: 2 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      await server.close();
    }
  });

  it("handles pre-abort and mid-request abort without retaining the ticket", async () => {
    let requestCount = 0;
    let firstUploadObserved!: () => void;
    const firstUpload = new Promise<void>((resolve) => {
      firstUploadObserved = resolve;
    });
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      requestCount += 1;
      if (requestCount === 1) {
        firstUploadObserved();
        return;
      }
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const preAborted = new AbortController();
      preAborted.abort();
      const preError = await captureContractError(
        client.inference(
          validRequest(windowPath, {
            signal: preAborted.signal,
          }),
        ),
      );
      expect(preError.code).toBe("aborted");
      expect(preError.sessionDisposition).toBe("reusable");
      expect(client.sessionDisposition).toBe("reusable");

      const midAbort = new AbortController();
      const pending = client.inference(
        validRequest(windowPath, {
          requestGeneration: 2,
          signal: midAbort.signal,
        }),
      );
      await firstUpload;
      midAbort.abort();
      const midError = await captureContractError(pending);
      expect(midError.code).toBe("aborted");
      expect(midError.sessionDisposition).toBe("restart_required");

      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 3 })),
      ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
      await expect(
        clientFor(server.port).inference(
          validRequest(windowPath, { requestGeneration: 3 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 3 });
    } finally {
      await server.close();
    }
  });

  it("keeps the client reusable when abort wins during file open", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openStarted!: () => void;
    const openStart = new Promise<void>((resolve) => {
      openStarted = resolve;
    });
    let lateHandleClosed!: () => void;
    const lateHandleClose = new Promise<void>((resolve) => {
      lateHandleClosed = resolve;
    });
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port, {}, {
        openFile: async (filePath, flags) => {
          openStarted();
          await openGate;
          return open(filePath, flags);
        },
        closeFile: async (fileHandle) => {
          await fileHandle.close();
          lateHandleClosed();
        },
      });
      const controller = new AbortController();
      const pending = client.inference(
        validRequest(windowPath, { signal: controller.signal }),
      );
      await openStart;
      controller.abort();

      const error = await captureContractError(pending);
      expect(error).toMatchObject({
        code: "aborted",
        sessionDisposition: "reusable",
      });
      expect(client.sessionDisposition).toBe("reusable");
      releaseOpen();
      await lateHandleClose;
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      releaseOpen();
      await server.close();
    }
  });

  it("bounds a stuck file open and closes its late handle", async () => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let lateHandleClosed!: () => void;
    const lateHandleClose = new Promise<void>((resolve) => {
      lateHandleClosed = resolve;
    });
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port, { inferenceMs: 50 }, {
        openFile: async (filePath, flags) => {
          await openGate;
          return open(filePath, flags);
        },
        closeFile: async (fileHandle) => {
          await fileHandle.close();
          lateHandleClosed();
        },
      });
      const startedAt = Date.now();
      const error = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(error).toMatchObject({
        code: "timeout",
        sessionDisposition: "reusable",
      });
      expect(client.sessionDisposition).toBe("reusable");
      releaseOpen();
      await lateHandleClose;
    } finally {
      releaseOpen();
      await server.close();
    }
  });

  it("taints the client when the upload file handle cannot be closed", async () => {
    let leakedHandle: FileHandle | undefined;
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port, {}, {
        closeFile: async (fileHandle) => {
          leakedHandle = fileHandle;
          throw new Error("injected close failure");
        },
      });
      const error = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(error).toMatchObject({
        code: "transport_failed",
        sessionDisposition: "restart_required",
      });
      expect(client.sessionDisposition).toBe("restart_required");
    } finally {
      await leakedHandle?.close();
      await server.close();
    }
  });

  it("bounds a hanging file close by the inference absolute deadline", async () => {
    let releaseClose!: () => void;
    let closeFinished: Promise<void> | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port, { inferenceMs: 100 }, {
        closeFile: (fileHandle) => {
          closeFinished = closeGate.then(() => fileHandle.close());
          return closeFinished;
        },
      });
      const startedAt = Date.now();
      const error = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(error).toMatchObject({
        code: "transport_failed",
        sessionDisposition: "restart_required",
      });
      releaseClose();
      await closeFinished;
    } finally {
      releaseClose();
      await closeFinished?.catch(() => undefined);
      await server.close();
    }
  });

  it("classifies a transport disconnect as restart-required and releases the ticket", async () => {
    let requestCount = 0;
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      requestCount += 1;
      if (requestCount === 1) {
        request.socket.destroy();
        return;
      }
      sendJson(response, validVerboseJson());
    });

    try {
      const client = clientFor(server.port);
      const error = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(error.code).toBe("transport_failed");
      expect(error.sessionDisposition).toBe("restart_required");
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
      await expect(
        clientFor(server.port).inference(
          validRequest(windowPath, { requestGeneration: 2 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      await server.close();
    }
  });

  it("applies the strict inference schema and releases only its own ticket", async () => {
    let requestCount = 0;
    const server = await startServer(async (request, response) => {
      await readRequestBody(request);
      requestCount += 1;
      sendJson(
        response,
        requestCount === 1
          ? { ...validVerboseJson(), privateEndpoint: PRIVATE_PATH }
          : validVerboseJson(),
      );
    });

    try {
      const client = clientFor(server.port);
      const protocolError = await captureContractError(
        client.inference(validRequest(windowPath)),
      );
      expect(protocolError.code).toBe("invalid_response");
      expect(protocolError.sessionDisposition).toBe("restart_required");
      await expect(
        client.inference(validRequest(windowPath, { requestGeneration: 2 })),
      ).rejects.toMatchObject({ sessionDisposition: "restart_required" });
      await expect(
        clientFor(server.port).inference(
          validRequest(windowPath, { requestGeneration: 2 }),
        ),
      ).resolves.toMatchObject({ requestGeneration: 2 });
    } finally {
      await server.close();
    }
  });
});

function clientFor(
  port: number,
  deadlines: { healthMs?: number; inferenceMs?: number } = {},
  dependencies: LocalSubtitleServerHttpClientDependencies = {},
): LocalSubtitleServerHttpClient {
  return new LocalSubtitleServerHttpClient(endpoint(port), deadlines, dependencies);
}

function endpoint(port: number): LocalSubtitleServerHttpEndpoint {
  return {
    host: "127.0.0.1",
    port,
    privatePath: PRIVATE_PATH,
  };
}

function validRequest(
  filePath: string,
  overrides: Partial<LocalSubtitleServerInferenceRequest> = {},
): LocalSubtitleServerInferenceRequest {
  return {
    requestGeneration: 1,
    filePath,
    expectedFileIdentity: expectedFileIdentity(filePath),
    language: "ja",
    taskMode: "transcribe",
    beamSize: 5,
    temperature: 0,
    vadEnabled: true,
    vadMinSilenceMs: 500,
    initialPrompt: "FusionKit",
    ...overrides,
  };
}

function expectedFileIdentity(filePath: string) {
  try {
    return fileIdentity(statSync(filePath));
  } catch {
    return Object.freeze({
      dev: 0,
      ino: 0,
      size: 1,
      mtimeMs: 0,
      ctimeMs: 0,
    });
  }
}

function fileIdentity(stats: Stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function validVerboseJson() {
  return {
    task: "transcribe",
    language: "japanese",
    duration: 0.25,
    text: "hello",
    segments: [
      {
        id: 0,
        text: "hello",
        start: 0,
        end: 0.25,
        tokens: [1],
        words: [{ word: "hello", probability: 0.9 }],
        temperature: 0,
        avg_logprob: -0.1,
        no_speech_prob: 0.01,
      },
    ],
  };
}

async function captureContractError(
  promise: Promise<unknown>,
): Promise<LocalSubtitleServerContractError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSubtitleServerContractError);
    return error as LocalSubtitleServerContractError;
  }
  throw new Error("Expected a LocalSubtitleServerContractError.");
}

function sendJson(
  response: ServerResponse,
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(bytes.length),
    ...headers,
  });
  response.end(bytes);
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake server did not bind a TCP port.");
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
