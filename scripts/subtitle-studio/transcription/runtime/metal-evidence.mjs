// Bounded backend evidence for the independently staged official macOS runtime.
export function parseMetalBackendDiagnostics(value) {
  const text = typeof value === "string"
    ? value
    : `${value?.stdout ?? ""}\n${value?.stderr ?? ""}`;
  const initializationObserved =
    /(?:ggml_metal_init|ggml_backend_metal_(?:device_)?init)/iu.test(text);
  const deviceObserved =
    /(?:found device|GPU name|using Metal backend|Metal device)/iu.test(text);
  const failureObserved = text.split(/\r?\n/u).some((line) => {
    const hasMetalContext =
      /\bggml_(?:backend_)?metal\w*\b/iu.test(line) ||
      /\bMetal (?:backend|device)\b/iu.test(line);
    if (!hasMetalContext) return false;
    return (
      /\berror\s*:|\b(?:failed|failure|unavailable|unsupported|fatal|nil)\b/iu.test(
        line,
      ) ||
      /(?:\bMetal backend\b[^\n]*\bdisabled\b|\bdisabled\b[^\n]*\bMetal backend\b)/iu.test(
        line,
      )
    );
  });
  return {
    initializationObserved,
    deviceObserved,
    failureObserved,
    backendVerified:
      initializationObserved && deviceObserved && !failureObserved,
  };
}

export function mergeMetalBackendEvidence(previous, current) {
  const initializationObserved = Boolean(
    previous?.initializationObserved || current?.initializationObserved,
  );
  const deviceObserved = Boolean(
    previous?.deviceObserved || current?.deviceObserved,
  );
  const failureObserved = Boolean(
    previous?.failureObserved || current?.failureObserved,
  );
  return {
    initializationObserved,
    deviceObserved,
    failureObserved,
    backendVerified:
      initializationObserved && deviceObserved && !failureObserved,
  };
}

