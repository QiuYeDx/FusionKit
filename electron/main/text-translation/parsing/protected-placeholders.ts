export type MarkdownProtectedPlaceholderKind =
  | "frontmatter"
  | "code"
  | "inline_code"
  | "html"
  | "link_destination"
  | "image_destination"
  | "autolink"
  | "definition"
  | "thematic_break"
  | "math"
  | "structure";

export interface MarkdownProtectedSpan {
  kind: MarkdownProtectedPlaceholderKind;
  start: number;
  end: number;
  source: string;
}

export interface ProtectedPlaceholder {
  token: string;
  source: string;
  start: number;
  end: number;
  kind: MarkdownProtectedPlaceholderKind;
  index: number;
}

export interface ApplyProtectedPlaceholdersOptions {
  source: string;
  spans: MarkdownProtectedSpan[];
  segmentId: string;
}

export interface ApplyProtectedPlaceholdersResult {
  text: string;
  placeholders: ProtectedPlaceholder[];
}

export interface ValidateProtectedPlaceholdersOptions {
  enforceOrder?: boolean;
}

export interface ValidateProtectedPlaceholdersResult {
  ok: boolean;
  errors: string[];
}

const PLACEHOLDER_PATTERN = /⟦FKP:([^:⟧]+):(\d{4})⟧/g;

export function applyProtectedPlaceholders(
  options: ApplyProtectedPlaceholdersOptions,
): ApplyProtectedPlaceholdersResult {
  const spans = normalizeProtectedSpans(options.source, options.spans);
  const placeholders = spans.map((span, index) => ({
    token: createProtectedPlaceholderToken(options.segmentId, index),
    source: span.source,
    start: span.start,
    end: span.end,
    kind: span.kind,
    index,
  }));

  let text = options.source;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    text =
      text.slice(0, span.start) +
      placeholders[index].token +
      text.slice(span.end);
  }

  return { text, placeholders };
}

export function restoreProtectedPlaceholders(
  text: string,
  placeholders: ProtectedPlaceholder[],
): string {
  let restored = text;
  for (const placeholder of placeholders) {
    restored = restored.split(placeholder.token).join(placeholder.source);
  }
  return restored;
}

export function validateProtectedPlaceholders(
  text: string,
  placeholders: ProtectedPlaceholder[],
  options: ValidateProtectedPlaceholdersOptions = {},
): ValidateProtectedPlaceholdersResult {
  const expectedTokens = new Set(placeholders.map((placeholder) => placeholder.token));
  const errors: string[] = [];
  const observedTokens = [...text.matchAll(PLACEHOLDER_PATTERN)].map(
    (match) => match[0],
  );

  for (const placeholder of placeholders) {
    const occurrences = countOccurrences(text, placeholder.token);
    if (occurrences !== 1) {
      errors.push(
        `Placeholder ${placeholder.token} expected once but found ${occurrences}.`,
      );
    }
  }

  for (const token of observedTokens) {
    if (!expectedTokens.has(token)) {
      errors.push(`Unknown placeholder ${token}.`);
    }
  }

  if (options.enforceOrder ?? true) {
    const expectedOrder = placeholders.map((placeholder) => placeholder.token);
    const filteredObserved = observedTokens.filter((token) =>
      expectedTokens.has(token),
    );
    if (filteredObserved.join("\0") !== expectedOrder.join("\0")) {
      errors.push("Protected placeholders are not in the expected order.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function createProtectedPlaceholderToken(
  segmentId: string,
  index: number,
): string {
  const safeSegmentId = segmentId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `⟦FKP:${safeSegmentId}:${String(index + 1).padStart(4, "0")}⟧`;
}

function normalizeProtectedSpans(
  source: string,
  spans: MarkdownProtectedSpan[],
): MarkdownProtectedSpan[] {
  const ordered = [...spans].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return right.end - left.end;
  });

  let previousEnd = -1;
  for (const span of ordered) {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end > source.length ||
      span.start >= span.end
    ) {
      throw new Error(`Invalid protected span range: ${span.start}-${span.end}`);
    }
    if (span.start < previousEnd) {
      throw new Error(`Overlapping protected span range: ${span.start}-${span.end}`);
    }
    const actualSource = source.slice(span.start, span.end);
    if (span.source !== actualSource) {
      throw new Error(`Protected span source mismatch: ${span.start}-${span.end}`);
    }
    previousEnd = span.end;
  }

  return ordered;
}

function countOccurrences(text: string, token: string): number {
  if (!token) return 0;
  return text.split(token).length - 1;
}
