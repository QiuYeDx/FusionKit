import {
  LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS,
  LOCAL_SUBTITLE_LIMITS,
  type LocalSubtitleDiagnosticMetadataKey,
  type LocalSubtitleDiagnosticScalar,
  type LocalSubtitleDiagnostics,
} from "@/type/localSubtitle";

export const LOCAL_SUBTITLE_SERVER_DIAGNOSTIC_SOURCES = [
  "stdout",
  "stderr",
] as const;

export type LocalSubtitleServerDiagnosticSource =
  (typeof LOCAL_SUBTITLE_SERVER_DIAGNOSTIC_SOURCES)[number];

export interface LocalSubtitleServerDiagnosticCollectorOptions {
  /** Stable, code-owned summary. Do not pass provider or inference payloads. */
  readonly summary?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Main-only values such as endpoint tokens and resolved private paths. */
  readonly privateValues?: readonly string[];
}

interface DiagnosticStreamState {
  readonly decoder: TextDecoder;
  pendingLine: string;
  droppingOverlongLine: boolean;
}

interface RetainedLine {
  readonly value: string;
  readonly jsonBytes: number;
}

const SOURCE_PREFIXES = {
  stdout: "[stdout] ",
  stderr: "[stderr] ",
} as const;
const METADATA_STRING_MAX_CHARS = 256;
const RAW_LINE_BUFFER_BASE_CHARS =
  LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars * 16;
const RAW_LINE_BUFFER_MAX_CHARS =
  LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes * 4;
const DIAGNOSTIC_OBJECT_OVERHEAD_BYTES = 256;

const ANSI_OSC_PATTERN =
  /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\)/gu;
const ANSI_CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
const ANSI_TWO_CHARACTER_PATTERN = /\u001b[@-_]/gu;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

const SENSITIVE_CONTENT_PATTERN =
  /\b(?:http\s+body|request\s+body|response\s+body|initial[\s_-]*prompt|prompt|transcript)\s*[:=][\s\S]*$/giu;
const JSON_SENSITIVE_CONTENT_PATTERN =
  /(["'](?:httpBody|requestBody|responseBody|initialPrompt|initial_prompt|prompt|transcript)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]]*)/giu;
const BEARER_CREDENTIAL_PATTERN =
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JSON_API_KEY_PATTERN =
  /(["'](?:api[-_]?key|apiKey|authorization|proxyAuthorization|proxy[-_]?password)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/giu;
const LABELED_CREDENTIAL_PATTERN =
  /\b((?:api[-_ ]?key|apikey|authorization|openai_api_key|anthropic_api_key|proxy[-_ ]?(?:authorization|password|credential))\s*[:=]\s*)(?:Bearer\s+\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu;
const STANDALONE_API_KEY_PATTERN =
  /\b(?:sk|ek|mimo)-[A-Za-z0-9._-]{12,}\b/giu;
const PROXY_URL_CREDENTIAL_PATTERN =
  /(\b(?:https?|socks5?):\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const PROXY_BASIC_CREDENTIAL_PATTERN =
  /\bProxy-Authorization\s*:\s*Basic\s+[A-Za-z0-9+/=]+/giu;

const LOOPBACK_URL_PATTERN =
  /\bhttps?:\/\/127\.0\.0\.1(?::\d{1,5})?(?:\/[^\s"'`<>]*)?/giu;
const LOOPBACK_HOST_PATTERN = /\b127\.0\.0\.1(?::\d{1,5})?\b/gu;
const PRIVATE_REQUEST_PATH_PATTERN =
  /\/fusionkit-[A-Za-z0-9._~-]{20,}(?:\/(?:health|inference))?/gu;
const LABELED_PORT_PATTERN =
  /\bport\s*=\s*["']?\d{1,5}["']?/giu;
const ARGUMENT_PORT_PATTERN = /--port\s+\d{1,5}\b/giu;

const FILE_URL_PATTERN = /\bfile:\/\/[^\s"'`<>]+/giu;
const LABELED_PATH_PATTERN =
  /\b((?:model|input|output|media|file|path|directory|cwd|temp|tmp)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/giu;
const DOUBLE_QUOTED_PATH_PATTERN =
  /"(?:\\?\/(?:[^"\r\n]|\\.)*|[A-Za-z]:[\\/]+(?:[^"\r\n]|\\.)*|[\\/]{2,}(?:[^"\r\n]|\\.)*)"/gu;
const SINGLE_QUOTED_PATH_PATTERN =
  /'(?:\\?\/(?:[^'\r\n]|\\.)*|[A-Za-z]:[\\/]+(?:[^'\r\n]|\\.)*|[\\/]{2,}(?:[^'\r\n]|\\.)*)'/gu;
const WINDOWS_PATH_PATTERN =
  /\b[A-Za-z]:[\\/]+[^\s"'`<>|]+/gu;
const UNC_PATH_PATTERN =
  /(^|[\s=(,:;])[\\/]{2,}[^\s"'`<>|]+/gu;
const POSIX_PATH_PATTERN =
  /(^|[\s=(,:;])(?:\\?\/)[^\s"'`<>|]+/gu;

const ALLOWED_METADATA_KEYS = new Set<string>(
  LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS,
);

export class LocalSubtitleServerDiagnosticCollector {
  readonly #states: Record<
    LocalSubtitleServerDiagnosticSource,
    DiagnosticStreamState
  > = {
    stdout: createStreamState(),
    stderr: createStreamState(),
  };

  readonly #summary: string | undefined;
  readonly #metadata: Readonly<Record<string, unknown>> | undefined;
  readonly #privateValues: readonly string[];
  readonly #rawLineBufferLimit: number;
  readonly #lines: RetainedLine[] = [];
  #retainedLineBytes = 0;
  #truncated = false;
  #finished: LocalSubtitleDiagnostics | undefined;

  constructor(options: LocalSubtitleServerDiagnosticCollectorOptions = {}) {
    this.#privateValues = buildPrivateValueVariants(options.privateValues ?? []);
    const longestPrivateValue = this.#privateValues.reduce(
      (longest, value) => Math.max(longest, value.length),
      0,
    );
    this.#rawLineBufferLimit = Math.min(
      RAW_LINE_BUFFER_MAX_CHARS,
      Math.max(
        RAW_LINE_BUFFER_BASE_CHARS,
        longestPrivateValue + LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars,
      ),
    );
    this.#summary = options.summary;
    this.#metadata = options.metadata;
  }

  append(
    source: LocalSubtitleServerDiagnosticSource,
    chunk: string | Uint8Array,
  ): void {
    if (this.#finished) {
      throw new TypeError("Cannot append diagnostics after finish().");
    }
    if (!isDiagnosticSource(source)) {
      throw new TypeError("Server diagnostics accept only stdout or stderr.");
    }
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      throw new TypeError("Server diagnostic chunks must be strings or bytes.");
    }

    const state = this.#states[source];
    if (typeof chunk === "string") {
      const decoderRemainder = state.decoder.decode();
      if (decoderRemainder) this.#consumeText(source, state, decoderRemainder);
      this.#consumeText(source, state, chunk);
      return;
    }
    const decoded = state.decoder.decode(chunk, { stream: true });
    if (decoded) this.#consumeText(source, state, decoded);
  }

  finish(): LocalSubtitleDiagnostics {
    if (this.#finished) return this.#finished;

    for (const source of LOCAL_SUBTITLE_SERVER_DIAGNOSTIC_SOURCES) {
      const state = this.#states[source];
      const decoderRemainder = state.decoder.decode();
      if (decoderRemainder) this.#consumeText(source, state, decoderRemainder);
      if (state.pendingLine || state.droppingOverlongLine) {
        this.#completeLine(source, state);
      }
    }

    let summary = this.#sanitizeBoundedValue(
      this.#summary,
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticSummaryChars,
    );
    const metadata = this.#sanitizeMetadata(this.#metadata);

    let diagnostics = this.#buildDiagnostics(summary, metadata);
    while (
      serializedByteLength(diagnostics) >
        LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes &&
      this.#lines.length > 0
    ) {
      this.#dropOldestLine();
      this.#truncated = true;
      diagnostics = this.#buildDiagnostics(summary, metadata);
    }

    while (
      summary &&
      serializedByteLength(diagnostics) >
        LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes
    ) {
      const excess =
        serializedByteLength(diagnostics) -
        LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes;
      const currentBytes = Buffer.byteLength(summary, "utf8");
      const next = truncateUtf8(summary, Math.max(0, currentBytes - excess - 1));
      if (next === summary) break;
      summary = next || undefined;
      this.#truncated = true;
      diagnostics = this.#buildDiagnostics(summary, metadata);
    }

    if (
      serializedByteLength(diagnostics) >
        LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes
    ) {
      for (const key of [...LOCAL_SUBTITLE_DIAGNOSTIC_METADATA_KEYS].reverse()) {
        if (!(key in metadata)) continue;
        delete metadata[key];
        this.#truncated = true;
        diagnostics = this.#buildDiagnostics(summary, metadata);
        if (
          serializedByteLength(diagnostics) <=
          LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes
        ) {
          break;
        }
      }
    }

    this.#finished = freezeDiagnostics(this.#buildDiagnostics(summary, metadata));
    return this.#finished;
  }

  #consumeText(
    source: LocalSubtitleServerDiagnosticSource,
    state: DiagnosticStreamState,
    text: string,
  ): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      if (newline < 0) {
        this.#appendLineFragment(state, text.slice(offset));
        return;
      }
      this.#appendLineFragment(state, text.slice(offset, newline));
      this.#completeLine(source, state);
      offset = newline + 1;
    }
  }

  #appendLineFragment(state: DiagnosticStreamState, fragment: string): void {
    if (!fragment || state.droppingOverlongLine) return;
    if (state.pendingLine.length + fragment.length > this.#rawLineBufferLimit) {
      state.pendingLine = "";
      state.droppingOverlongLine = true;
      this.#truncated = true;
      return;
    }
    state.pendingLine += fragment;
  }

  #completeLine(
    source: LocalSubtitleServerDiagnosticSource,
    state: DiagnosticStreamState,
  ): void {
    if (state.droppingOverlongLine) {
      state.pendingLine = "";
      state.droppingOverlongLine = false;
      return;
    }

    const sanitized = sanitizeDiagnosticText(
      state.pendingLine,
      this.#privateValues,
    ).trim();
    state.pendingLine = "";
    if (!sanitized) return;

    const prefixed = `${SOURCE_PREFIXES[source]}${sanitized}`;
    const bounded = truncateUtf16(
      prefixed,
      LOCAL_SUBTITLE_LIMITS.maxDiagnosticLineChars,
    );
    if (bounded !== prefixed) this.#truncated = true;
    const retained = {
      value: bounded,
      jsonBytes: Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1,
    };
    this.#lines.push(retained);
    this.#retainedLineBytes += retained.jsonBytes;

    while (
      this.#lines.length > LOCAL_SUBTITLE_LIMITS.maxDiagnosticLines ||
      this.#retainedLineBytes >
        LOCAL_SUBTITLE_LIMITS.maxDiagnosticsBytes -
          DIAGNOSTIC_OBJECT_OVERHEAD_BYTES
    ) {
      this.#dropOldestLine();
      this.#truncated = true;
    }
  }

  #dropOldestLine(): void {
    const removed = this.#lines.shift();
    if (removed) this.#retainedLineBytes -= removed.jsonBytes;
  }

  #sanitizeBoundedValue(
    value: string | undefined,
    maxChars: number,
  ): string | undefined {
    if (value === undefined) return undefined;
    const sanitized = sanitizeDiagnosticText(
      value.replace(/[\r\n\t]+/gu, " "),
      this.#privateValues,
    ).trim();
    if (!sanitized) return undefined;
    const bounded = truncateUtf16(sanitized, maxChars);
    if (bounded !== sanitized) this.#truncated = true;
    return bounded;
  }

  #sanitizeMetadata(
    input: Readonly<Record<string, unknown>> | undefined,
  ): Partial<Record<LocalSubtitleDiagnosticMetadataKey, LocalSubtitleDiagnosticScalar>> {
    const metadata: Partial<
      Record<LocalSubtitleDiagnosticMetadataKey, LocalSubtitleDiagnosticScalar>
    > = {};
    if (!input) return metadata;

    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_METADATA_KEYS.has(key)) {
        this.#truncated = true;
        continue;
      }
      const metadataKey = key as LocalSubtitleDiagnosticMetadataKey;
      if (value === null || typeof value === "boolean") {
        metadata[metadataKey] = value;
        continue;
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) metadata[metadataKey] = value;
        else this.#truncated = true;
        continue;
      }
      if (typeof value === "string") {
        const sanitized = this.#sanitizeBoundedValue(
          value,
          METADATA_STRING_MAX_CHARS,
        );
        if (sanitized !== undefined) metadata[metadataKey] = sanitized;
        continue;
      }
      this.#truncated = true;
    }
    return metadata;
  }

  #buildDiagnostics(
    summary: string | undefined,
    metadata: Partial<
      Record<LocalSubtitleDiagnosticMetadataKey, LocalSubtitleDiagnosticScalar>
    >,
  ): LocalSubtitleDiagnostics {
    return {
      ...(summary === undefined ? {} : { summary }),
      ...(this.#lines.length === 0
        ? {}
        : { lines: this.#lines.map((line) => line.value) }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      truncated: this.#truncated,
    };
  }
}

export function createLocalSubtitleServerDiagnosticCollector(
  options: LocalSubtitleServerDiagnosticCollectorOptions = {},
): LocalSubtitleServerDiagnosticCollector {
  return new LocalSubtitleServerDiagnosticCollector(options);
}

function createStreamState(): DiagnosticStreamState {
  return {
    decoder: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }),
    pendingLine: "",
    droppingOverlongLine: false,
  };
}

function isDiagnosticSource(
  value: unknown,
): value is LocalSubtitleServerDiagnosticSource {
  return value === "stdout" || value === "stderr";
}

function buildPrivateValueVariants(values: readonly string[]): readonly string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    variants.add(value);
    variants.add(value.replace(/\\/gu, "\\\\"));
    variants.add(value.replace(/\//gu, "\\/"));
    const json = JSON.stringify(value);
    if (json.length >= 2) variants.add(json.slice(1, -1));
    try {
      variants.add(encodeURI(value));
      variants.add(encodeURIComponent(value));
    } catch {
      // Ill-formed surrogate input is still covered by its exact representation.
    }
  }
  return [...variants]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function sanitizeDiagnosticText(
  input: string,
  privateValues: readonly string[],
): string {
  let value = input
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_TWO_CHARACTER_PATTERN, "")
    .replace(/[\r\t]+/gu, " ")
    .replace(CONTROL_CHARACTER_PATTERN, "");

  value = value
    .replace(JSON_SENSITIVE_CONTENT_PATTERN, "$1[redacted]")
    .replace(SENSITIVE_CONTENT_PATTERN, "[sensitive content redacted]");

  for (const privateValue of privateValues) {
    value = value.split(privateValue).join("[redacted]");
  }

  value = value
    .replace(PROXY_BASIC_CREDENTIAL_PATTERN, "Proxy-Authorization: [redacted]")
    .replace(PROXY_URL_CREDENTIAL_PATTERN, "$1[credential]@")
    .replace(BEARER_CREDENTIAL_PATTERN, "Bearer [redacted]")
    .replace(JSON_API_KEY_PATTERN, "$1[redacted]")
    .replace(LABELED_CREDENTIAL_PATTERN, "$1[redacted]")
    .replace(STANDALONE_API_KEY_PATTERN, "[redacted]")
    .replace(LOOPBACK_URL_PATTERN, "[endpoint]")
    .replace(LOOPBACK_HOST_PATTERN, "[endpoint]")
    .replace(PRIVATE_REQUEST_PATH_PATTERN, "[private-path]")
    .replace(LABELED_PORT_PATTERN, "port=[redacted]")
    .replace(ARGUMENT_PORT_PATTERN, "--port [redacted]")
    .replace(FILE_URL_PATTERN, "[path]")
    .replace(LABELED_PATH_PATTERN, "$1[path]")
    .replace(DOUBLE_QUOTED_PATH_PATTERN, '"[path]"')
    .replace(SINGLE_QUOTED_PATH_PATTERN, "'[path]'")
    .replace(WINDOWS_PATH_PATTERN, "[path]")
    .replace(UNC_PATH_PATTERN, "$1[path]")
    .replace(POSIX_PATH_PATTERN, "$1[path]");

  return value;
}

function truncateUtf16(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function serializedByteLength(value: LocalSubtitleDiagnostics): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function freezeDiagnostics(
  diagnostics: LocalSubtitleDiagnostics,
): LocalSubtitleDiagnostics {
  if (diagnostics.lines) Object.freeze(diagnostics.lines);
  if (diagnostics.metadata) Object.freeze(diagnostics.metadata);
  return Object.freeze(diagnostics);
}
