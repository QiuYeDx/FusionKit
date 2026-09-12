import { constants as fsConstants, type ReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  LOCAL_SUBTITLE_SERVER_HTTP_POLICY,
  LocalSubtitleServerContractError,
  createLocalSubtitleServerInferenceFields,
  invalidLocalSubtitleServerConfiguration,
  invalidLocalSubtitleServerResponse,
  parseLocalSubtitleServerHealth,
  parseLocalSubtitleServerVerboseJson,
  validateLocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerExpectedFileIdentity,
  type LocalSubtitleServerInferenceFields,
  type LocalSubtitleServerInferenceRequest,
  type LocalSubtitleServerInferenceResponse,
  type LocalSubtitleServerSessionDisposition,
} from "./server-contract";
import {
  localSubtitleFileIdentityForHandle,
  sameLocalSubtitleFileIdentity,
  snapshotLocalSubtitleFileIdentity,
} from "./filesystem-object-identity";

export interface LocalSubtitleServerHttpEndpoint {
  readonly host: typeof LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host;
  readonly port: number;
  readonly privatePath: string;
}

export interface LocalSubtitleServerHealthResponse {
  readonly sessionDisposition: "reusable";
}

export interface LocalSubtitleServerHttpClientDeadlineOverrides {
  readonly healthMs?: number;
  readonly inferenceMs?: number;
}

export interface LocalSubtitleServerHttpClientDependencies {
  readonly openFile?: (filePath: string, flags: number) => Promise<FileHandle>;
  readonly closeFile?: (fileHandle: FileHandle) => Promise<void>;
}

interface MultipartUpload {
  readonly prefix: Buffer;
  readonly suffix: Buffer;
  readonly fileHandle: FileHandle;
  readonly fileIdentity: LocalSubtitleServerWindowIdentity;
  readonly fileBytes: number;
  readonly contentLength: number;
  readonly contentType: string;
}

type LocalSubtitleServerWindowIdentity =
  LocalSubtitleServerExpectedFileIdentity;

interface JsonExchangeOptions {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly deadlineMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
  readonly upload?: MultipartUpload;
  readonly errorContext: "health" | "inference";
}

type DeadlineOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly cause: unknown }
  | { readonly status: "aborted" }
  | { readonly status: "timeout" };

const PRIVATE_PATH_PATTERN = /^\/fusionkit-[a-f0-9]{48}$/u;

export class LocalSubtitleServerHttpClient {
  readonly #endpoint: LocalSubtitleServerHttpEndpoint;
  readonly #healthDeadlineMs: number;
  readonly #inferenceDeadlineMs: number;
  readonly #openFile: NonNullable<
    LocalSubtitleServerHttpClientDependencies["openFile"]
  >;
  readonly #closeFile: NonNullable<
    LocalSubtitleServerHttpClientDependencies["closeFile"]
  >;
  #activeRequestTicket: symbol | undefined;
  #restartRequired = false;

  constructor(
    endpoint: LocalSubtitleServerHttpEndpoint,
    deadlineOverrides: LocalSubtitleServerHttpClientDeadlineOverrides = {},
    dependencies: LocalSubtitleServerHttpClientDependencies = {},
  ) {
    this.#endpoint = validateEndpoint(endpoint);
    this.#healthDeadlineMs = resolveDeadline(
      deadlineOverrides.healthMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.healthRequestTimeoutMs,
      "health",
    );
    this.#inferenceDeadlineMs = resolveDeadline(
      deadlineOverrides.inferenceMs,
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.inferenceRequestTimeoutMs,
      "inference",
    );
    if (
      (dependencies.openFile !== undefined &&
        typeof dependencies.openFile !== "function") ||
      (dependencies.closeFile !== undefined &&
        typeof dependencies.closeFile !== "function")
    ) {
      throw invalidLocalSubtitleServerConfiguration(
        "The local inference HTTP client dependencies are invalid.",
      );
    }
    this.#openFile = dependencies.openFile ?? open;
    this.#closeFile =
      dependencies.closeFile ?? ((fileHandle) => fileHandle.close());
  }

  async health(signal?: AbortSignal): Promise<LocalSubtitleServerHealthResponse> {
    return this.#requestHealth("runtime", signal);
  }

  async probeReadiness(
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerHealthResponse> {
    return this.#requestHealth("readiness", signal);
  }

  async #requestHealth(
    phase: "readiness" | "runtime",
    signal?: AbortSignal,
  ): Promise<LocalSubtitleServerHealthResponse> {
    this.#assertReusable();
    const ticket = this.#claimRequestTicket();
    try {
      const body = await this.#requestJson({
        method: "GET",
        path: `${this.#endpoint.privatePath}${LOCAL_SUBTITLE_SERVER_HTTP_POLICY.healthPath}`,
        deadlineMs: this.#healthDeadlineMs,
        maxResponseBytes: LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxHealthResponseBytes,
        signal,
        errorContext: "health",
      });
      parseLocalSubtitleServerHealth(body);
      this.#assertSuccessfulTicket(ticket);
      return Object.freeze({ sessionDisposition: "reusable" });
    } catch (error) {
      const classified = phase === "runtime"
        ? requireRestartAfterRuntimeHealthFailure(error)
        : error;
      this.#recordDisposition(classified);
      throw classified;
    } finally {
      this.#releaseRequestTicket(ticket);
    }
  }

  get sessionDisposition(): LocalSubtitleServerSessionDisposition {
    return this.#restartRequired ? "restart_required" : "reusable";
  }

  async inference(
    request: LocalSubtitleServerInferenceRequest,
  ): Promise<LocalSubtitleServerInferenceResponse> {
    this.#assertReusable();
    validateLocalSubtitleServerInferenceRequest(request);
    const expectedFileIdentity = snapshotLocalSubtitleFileIdentity(
      request.expectedFileIdentity,
    );
    if (!expectedFileIdentity) {
      throw invalidLocalSubtitleServerConfiguration(
        "The normalized inference window identity is invalid.",
      );
    }
    const ticket = this.#claimRequestTicket();
    const absoluteDeadline = Date.now() + this.#inferenceDeadlineMs;
    let fileHandle: FileHandle | undefined;
    let response: LocalSubtitleServerInferenceResponse | undefined;
    let operationError: unknown;

    try {
      if (request.signal?.aborted) {
        throw abortedError("inference", false);
      }
      if (!path.isAbsolute(request.filePath)) {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window path must be absolute.",
        );
      }

      let openPromise: Promise<FileHandle>;
      try {
        openPromise = Promise.resolve(this.#openFile(
          request.filePath,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        ));
      } catch {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window is unavailable.",
        );
      }
      const openOutcome = await settleBeforeDeadline(
        openPromise,
        absoluteDeadline,
        request.signal,
        (lateFileHandle) => this.#closeLateFileHandle(lateFileHandle),
      );
      if (openOutcome.status === "aborted") {
        throw abortedError("inference", false);
      }
      if (openOutcome.status === "timeout") {
        throw timeoutError("inference", false);
      }
      if (openOutcome.status === "rejected") {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window is unavailable.",
        );
      }
      fileHandle = openOutcome.value;

      const statOutcome = await settleBeforeDeadline(
        Promise.all([
          fileHandle.stat(),
          localSubtitleFileIdentityForHandle(fileHandle),
        ]),
        absoluteDeadline,
        request.signal,
      );
      if (statOutcome.status === "aborted") {
        throw abortedError("inference", false);
      }
      if (statOutcome.status === "timeout") {
        throw timeoutError("inference", false);
      }
      if (statOutcome.status === "rejected") {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window identity is unavailable.",
        );
      }
      const [fileStat, openedFileIdentity] = statOutcome.value;
      if (request.signal?.aborted) {
        throw abortedError("inference", false);
      }
      if (!fileStat.isFile()) {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window must be a regular file.",
        );
      }
      if (
        !sameLocalSubtitleFileIdentity(
          expectedFileIdentity,
          openedFileIdentity,
        )
      ) {
        throw invalidLocalSubtitleServerConfiguration(
          "The normalized inference window does not match its expected identity.",
        );
      }

      const fields = createLocalSubtitleServerInferenceFields(request);
      const upload = createMultipartUpload(
        fileHandle,
        openedFileIdentity,
        fields,
      );
      const remainingRequestMs = absoluteDeadline - Date.now();
      if (remainingRequestMs < 1) {
        throw timeoutError("inference", false);
      }
      const body = await this.#requestJson({
        method: "POST",
        path: `${this.#endpoint.privatePath}${LOCAL_SUBTITLE_SERVER_HTTP_POLICY.inferencePath}`,
        deadlineMs: remainingRequestMs,
        maxResponseBytes:
          LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxInferenceResponseBytes,
        signal: request.signal,
        upload,
        errorContext: "inference",
      });
      const result = parseLocalSubtitleServerVerboseJson(body, {
        timingMode: request.timingMode,
        taskMode: request.taskMode,
        vadEnabled: request.vadEnabled,
      });
      this.#assertSuccessfulTicket(ticket);
      response = Object.freeze({
        requestGeneration: request.requestGeneration,
        sessionDisposition: "reusable" as const,
        result,
      });
    } catch (error) {
      operationError = error;
      this.#recordDisposition(error);
    } finally {
      if (fileHandle) {
        const closeError = await this.#closeFileBeforeDeadline(
          fileHandle,
          absoluteDeadline,
        );
        if (closeError) {
          this.#recordDisposition(closeError);
          if (
            operationError === undefined ||
            (operationError instanceof LocalSubtitleServerContractError &&
              operationError.sessionDisposition === "reusable")
          ) {
            operationError = closeError;
          }
        }
      }
      this.#releaseRequestTicket(ticket);
    }

    if (operationError !== undefined) throw operationError;
    if (!response) {
      throw invalidLocalSubtitleServerResponse(
        "The local inference request settled without a response.",
      );
    }
    return response;
  }

  #assertReusable(): void {
    if (!this.#restartRequired) return;
    throw serverError(
      "transport_failed",
      "The local inference process must be replaced before another request.",
      "runtime_unresponsive",
      "restart_required",
    );
  }

  #recordDisposition(error: unknown): void {
    if (
      error instanceof LocalSubtitleServerContractError &&
      error.sessionDisposition === "restart_required"
    ) {
      this.#restartRequired = true;
    }
  }

  #claimRequestTicket(): symbol {
    if (this.#activeRequestTicket !== undefined) {
      throw serverError(
        "busy",
        "The official local inference server already has an active operation.",
        "resource_busy",
        "reusable",
      );
    }
    const ticket = Symbol("local-subtitle-server-request");
    this.#activeRequestTicket = ticket;
    return ticket;
  }

  #releaseRequestTicket(ticket: symbol): void {
    if (this.#activeRequestTicket === ticket) {
      this.#activeRequestTicket = undefined;
    }
  }

  #assertSuccessfulTicket(ticket: symbol): void {
    if (this.#activeRequestTicket !== ticket || this.#restartRequired) {
      throw serverError(
        "transport_failed",
        "The local inference operation crossed a stale process boundary.",
        "runtime_unresponsive",
        "restart_required",
      );
    }
  }

  async #closeFileBeforeDeadline(
    fileHandle: FileHandle,
    absoluteDeadline: number,
  ): Promise<LocalSubtitleServerContractError | undefined> {
    let closePromise: Promise<void>;
    try {
      closePromise = Promise.resolve(this.#closeFile(fileHandle));
    } catch (cause) {
      return fileCleanupError(cause);
    }

    const remainingMs = Math.min(
      LOCAL_SUBTITLE_SERVER_HTTP_POLICY.fileHandleCloseTimeoutMs,
      absoluteDeadline - Date.now(),
    );
    if (remainingMs < 1) {
      void closePromise.catch(() => undefined);
      return fileCleanupError();
    }

    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      closePromise.then(
        () => ({ status: "closed" as const }),
        (cause: unknown) => ({ status: "failed" as const, cause }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome.status === "closed") return undefined;
    if (outcome.status === "timeout") {
      void closePromise.catch(() => undefined);
      return fileCleanupError();
    }
    return fileCleanupError(outcome.cause);
  }

  #closeLateFileHandle(fileHandle: FileHandle): void {
    try {
      void Promise.resolve(this.#closeFile(fileHandle)).catch(() => {
        this.#restartRequired = true;
      });
    } catch {
      this.#restartRequired = true;
    }
  }

  #requestJson(options: JsonExchangeOptions): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let fileStream: ReadStream | undefined;
      let settled = false;
      let uploadComplete = options.upload === undefined;
      let detachAbort = () => {};

      const deadline = setTimeout(() => {
        fail(
          serverError(
            "timeout",
            `The local inference ${options.errorContext} request exceeded its absolute deadline.`,
            "runtime_unresponsive",
            options.errorContext === "health" ? "reusable" : "restart_required",
          ),
        );
      }, options.deadlineMs);
      deadline.unref?.();

      const cleanup = () => {
        clearTimeout(deadline);
        detachAbort();
      };
      const fail = (error: LocalSubtitleServerContractError) => {
        if (settled) return;
        settled = true;
        cleanup();
        fileStream?.destroy();
        response?.destroy();
        request?.destroy();
        reject(error);
      };
      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      if (options.signal?.aborted) {
        fail(abortedError(options.errorContext, false));
        return;
      }
      if (options.signal) {
        const onAbort = () =>
          fail(abortedError(options.errorContext, request !== undefined));
        options.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }

      try {
        request = httpRequest(
          {
            host: this.#endpoint.host,
            port: this.#endpoint.port,
            method: options.method,
            path: options.path,
            agent: false,
            headers: options.upload
              ? {
                  Accept: "application/json",
                  Connection: "close",
                  "Content-Type": options.upload.contentType,
                  "Content-Length": String(options.upload.contentLength),
                }
              : {
                  Accept: "application/json",
                  Connection: "close",
                  "Content-Length": "0",
                },
          },
          (incoming) => {
            response = incoming;
            if (!uploadComplete) {
              const error = incoming.statusCode === 200
                ? invalidLocalSubtitleServerResponse(
                    "The local inference server responded before the upload completed.",
                  )
                : httpStatusError(options.errorContext, incoming.statusCode);
              fail(error);
              return;
            }
            if (incoming.statusCode !== 200) {
              fail(httpStatusError(options.errorContext, incoming.statusCode));
              return;
            }

            let declaredLength: number | undefined;
            try {
              validateJsonResponseHeaders(incoming);
              declaredLength = parseResponseContentLength(
                incoming.headers["content-length"],
                options.maxResponseBytes,
              );
            } catch (error) {
              fail(asContractError(error));
              return;
            }

            const chunks: Buffer[] = [];
            let actualBytes = 0;
            incoming.on("data", (chunk: Buffer) => {
              if (settled) return;
              actualBytes += chunk.length;
              if (actualBytes > options.maxResponseBytes) {
                fail(responseTooLargeError());
                return;
              }
              if (
                declaredLength !== undefined &&
                actualBytes > declaredLength
              ) {
                fail(
                  invalidLocalSubtitleServerResponse(
                    "The local inference response exceeded its declared Content-Length.",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            incoming.once("aborted", () => {
              fail(transportError(options.errorContext));
            });
            incoming.once("error", () => {
              fail(transportError(options.errorContext));
            });
            incoming.once("end", () => {
              if (settled) return;
              if (
                !incoming.complete ||
                (declaredLength !== undefined && actualBytes !== declaredLength)
              ) {
                fail(
                  invalidLocalSubtitleServerResponse(
                    "The local inference response byte length is invalid.",
                  ),
                );
                return;
              }
              let text: string;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(
                  Buffer.concat(chunks, actualBytes),
                );
              } catch {
                fail(
                  invalidLocalSubtitleServerResponse(
                    "The local inference response is not valid UTF-8.",
                  ),
                );
                return;
              }
              try {
                succeed(JSON.parse(text));
              } catch {
                fail(
                  invalidLocalSubtitleServerResponse(
                    "The local inference response is not valid JSON.",
                  ),
                );
              }
            });
          },
        );
      } catch {
        fail(transportError(options.errorContext));
        return;
      }

      request.once("error", () => {
        fail(transportError(options.errorContext));
      });

      if (!options.upload) {
        request.end();
        return;
      }

      const upload = options.upload;
      let actualBodyBytes = 0;
      let actualFileBytes = 0;
      const writeBodyChunk = (chunk: Buffer): boolean => {
        if (actualBodyBytes + chunk.length > upload.contentLength) {
          fail(
            invalidLocalSubtitleServerResponse(
              "The local inference upload exceeded its declared Content-Length.",
            ),
          );
          return false;
        }
        actualBodyBytes += chunk.length;
        try {
          return request!.write(chunk);
        } catch {
          fail(transportError(options.errorContext));
          return false;
        }
      };

      const prefixAccepted = writeBodyChunk(upload.prefix);
      if (settled) return;
      fileStream = upload.fileHandle.createReadStream({ autoClose: false });
      fileStream.pause();
      fileStream.on("data", (chunk: string | Buffer) => {
        if (settled) return;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (actualFileBytes + bytes.length > upload.fileBytes) {
          fail(
            invalidLocalSubtitleServerResponse(
              "The normalized inference window changed while it was uploaded.",
            ),
          );
          return;
        }
        actualFileBytes += bytes.length;
        if (!writeBodyChunk(bytes) && !settled) {
          fileStream?.pause();
          request?.once("drain", () => fileStream?.resume());
        }
      });
      fileStream.once("error", () => {
        fail(transportError(options.errorContext));
      });
      fileStream.once("end", () => {
        void finishUpload().catch(() => {
          fail(
            invalidLocalSubtitleServerResponse(
              "The normalized inference window identity changed while it was uploaded.",
            ),
          );
        });
      });
      const finishUpload = async () => {
        if (settled) return;
        if (actualFileBytes !== upload.fileBytes) {
          fail(
            invalidLocalSubtitleServerResponse(
              "The normalized inference window changed while it was uploaded.",
            ),
          );
          return;
        }
        const finalIdentity = await localSubtitleFileIdentityForHandle(
          upload.fileHandle,
        );
        if (!sameLocalSubtitleFileIdentity(upload.fileIdentity, finalIdentity)) {
          fail(
            invalidLocalSubtitleServerResponse(
              "The normalized inference window identity changed while it was uploaded.",
            ),
          );
          return;
        }
        writeBodyChunk(upload.suffix);
        if (settled) return;
        if (actualBodyBytes !== upload.contentLength) {
          fail(
            invalidLocalSubtitleServerResponse(
              "The local inference upload byte length is invalid.",
            ),
          );
          return;
        }
        uploadComplete = true;
        try {
          request?.end();
        } catch {
          fail(transportError(options.errorContext));
        }
      };
      request.once("close", () => {
        if (!uploadComplete) fileStream?.destroy();
      });
      if (prefixAccepted) fileStream.resume();
      else request.once("drain", () => fileStream?.resume());
    });
  }
}

function settleBeforeDeadline<T>(
  operation: Promise<T>,
  absoluteDeadline: number,
  signal?: AbortSignal,
  onLateFulfilled?: (value: T) => void,
): Promise<DeadlineOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => finish({ status: "aborted" });
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome: DeadlineOutcome<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const handleLateValue = (value: T) => {
      if (!onLateFulfilled) return;
      try {
        onLateFulfilled(value);
      } catch {
        // The late cleanup callback owns its own failure disposition.
      }
    };

    operation.then(
      (value) => {
        if (settled) handleLateValue(value);
        else finish({ status: "fulfilled", value });
      },
      (cause: unknown) => {
        if (!settled) finish({ status: "rejected", cause });
      },
    );

    if (signal?.aborted) {
      finish({ status: "aborted" });
      return;
    }
    const remainingMs = absoluteDeadline - Date.now();
    if (remainingMs < 1) {
      finish({ status: "timeout" });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish({ status: "timeout" }), remainingMs);
  });
}

function validateEndpoint(
  endpoint: LocalSubtitleServerHttpEndpoint,
): LocalSubtitleServerHttpEndpoint {
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    endpoint.host !== LOCAL_SUBTITLE_SERVER_HTTP_POLICY.host ||
    !Number.isSafeInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    typeof endpoint.privatePath !== "string" ||
    !PRIVATE_PATH_PATTERN.test(endpoint.privatePath) ||
    Object.keys(endpoint).sort().join(",") !== "host,port,privatePath"
  ) {
    throw invalidLocalSubtitleServerConfiguration(
      "The official server endpoint is invalid.",
    );
  }
  return Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    privatePath: endpoint.privatePath,
  });
}

function resolveDeadline(
  override: number | undefined,
  maximum: number,
  label: string,
): number {
  if (override === undefined) return maximum;
  if (
    !Number.isSafeInteger(override) ||
    override < 1 ||
    override > maximum
  ) {
    throw invalidLocalSubtitleServerConfiguration(
      `The ${label} deadline override is invalid.`,
    );
  }
  return override;
}

function createMultipartUpload(
  fileHandle: FileHandle,
  fileIdentity: LocalSubtitleServerWindowIdentity,
  fields: LocalSubtitleServerInferenceFields,
): MultipartUpload {
  const fileBytes = fileIdentity.size;
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 1) {
    throw invalidLocalSubtitleServerConfiguration(
      "The normalized inference window must be a non-empty file.",
    );
  }
  const boundary = createSafeMultipartBoundary(Object.values(fields));
  const fieldText = Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
    )
    .join("");
  const fileHeader =
    `--${boundary}\r\n` +
    "Content-Disposition: form-data; name=\"file\"; " +
    `filename="${LOCAL_SUBTITLE_SERVER_HTTP_POLICY.fixedUploadFileName}"\r\n` +
    "Content-Type: audio/wav\r\n\r\n";
  const prefix = Buffer.from(`${fieldText}${fileHeader}`, "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const contentLength = prefix.length + fileBytes + suffix.length;
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > LOCAL_SUBTITLE_SERVER_HTTP_POLICY.maxInferenceUploadBytes
  ) {
    throw invalidLocalSubtitleServerConfiguration(
      "The normalized inference upload exceeds the contract limit.",
    );
  }
  return {
    prefix,
    suffix,
    fileHandle,
    fileIdentity,
    fileBytes,
    contentLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function createSafeMultipartBoundary(values: readonly string[]): string {
  for (;;) {
    const boundary = `fusionkit-${randomBytes(24).toString("hex")}`;
    if (values.every((value) => !value.includes(boundary))) return boundary;
  }
}

function validateJsonResponseHeaders(response: IncomingMessage): void {
  if (response.headers["content-encoding"] !== undefined) {
    throw invalidLocalSubtitleServerResponse(
      "The local inference response must not use content encoding.",
    );
  }
  const contentType = response.headers["content-type"];
  if (typeof contentType !== "string") {
    throw invalidLocalSubtitleServerResponse(
      "The local inference response Content-Type is invalid.",
    );
  }
  const [mediaType, ...parameters] = contentType
    .split(";")
    .map((part) => part.trim().toLowerCase());
  if (
    mediaType !== "application/json" ||
    parameters.some((parameter) => parameter !== "charset=utf-8")
  ) {
    throw invalidLocalSubtitleServerResponse(
      "The local inference response Content-Type is invalid.",
    );
  }
}

function parseResponseContentLength(
  value: string | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw invalidLocalSubtitleServerResponse(
      "The local inference response Content-Length is invalid.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidLocalSubtitleServerResponse(
      "The local inference response Content-Length is invalid.",
    );
  }
  if (parsed > maximum) throw responseTooLargeError();
  return parsed;
}

function asContractError(error: unknown): LocalSubtitleServerContractError {
  return error instanceof LocalSubtitleServerContractError
    ? error
    : invalidLocalSubtitleServerResponse(
        "The local inference response headers are invalid.",
      );
}

function abortedError(
  context: "health" | "inference",
  requestStarted = true,
) {
  return serverError(
    "aborted",
    `The local inference ${context} request was aborted.`,
    "transcription_failed",
    context === "inference" && requestStarted ? "restart_required" : "reusable",
  );
}

function timeoutError(
  context: "health" | "inference",
  requestStarted = true,
) {
  return serverError(
    "timeout",
    `The local inference ${context} request exceeded its absolute deadline.`,
    "runtime_unresponsive",
    context === "inference" && requestStarted
      ? "restart_required"
      : "reusable",
  );
}

function requireRestartAfterRuntimeHealthFailure(
  error: unknown,
): LocalSubtitleServerContractError {
  if (
    error instanceof LocalSubtitleServerContractError &&
    error.sessionDisposition === "restart_required"
  ) {
    return error;
  }
  if (error instanceof LocalSubtitleServerContractError) {
    return serverError(
      error.code,
      error.message,
      error.localSubtitleCode,
      "restart_required",
      error.httpStatus,
      error,
    );
  }
  return serverError(
    "transport_failed",
    "The local inference runtime health check failed.",
    "runtime_unresponsive",
    "restart_required",
    undefined,
    error,
  );
}

function fileCleanupError(cause?: unknown): LocalSubtitleServerContractError {
  return serverError(
    "transport_failed",
    "The normalized inference window could not be released before the deadline.",
    "runtime_unresponsive",
    "restart_required",
    undefined,
    cause,
  );
}

function transportError(context: "health" | "inference") {
  return serverError(
    "transport_failed",
    `The local inference ${context} transport failed.`,
    context === "health" ? "runtime_unresponsive" : "runtime_crashed",
    context === "health" ? "reusable" : "restart_required",
  );
}

function httpStatusError(
  context: "health" | "inference",
  status: number | undefined,
) {
  return serverError(
    "http_error",
    `The local inference ${context} request returned an unexpected HTTP status.`,
    context === "health" ? "runtime_unresponsive" : "transcription_failed",
    context === "health" && status === 503 ? "reusable" : "restart_required",
    status,
  );
}

function responseTooLargeError() {
  return serverError(
    "response_too_large",
    "The local inference response exceeds the contract limit.",
    "runtime_protocol_mismatch",
    "restart_required",
  );
}

function serverError(
  code: ConstructorParameters<typeof LocalSubtitleServerContractError>[0],
  message: string,
  localSubtitleCode: ConstructorParameters<
    typeof LocalSubtitleServerContractError
  >[2]["localSubtitleCode"],
  sessionDisposition: LocalSubtitleServerSessionDisposition,
  httpStatus?: number,
  cause?: unknown,
): LocalSubtitleServerContractError {
  return new LocalSubtitleServerContractError(code, message, {
    localSubtitleCode,
    sessionDisposition,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(cause === undefined ? {} : { cause }),
  });
}
