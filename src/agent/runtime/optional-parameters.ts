/**
 * Optional request fields that some models or OpenAI-compatible gateways reject
 * (for example reasoning models refusing `temperature`). Adapters drop a field only
 * after an explicit HTTP 400 that names it, and remember that per endpoint and model.
 */
export type OptionalModelParameter = "temperature" | "include";

const unsupportedParameters = new Map<string, Set<OptionalModelParameter>>();

export function optionalParameterKey(endpoint: string, modelKey: string): string {
  return `${endpoint}\n${modelKey}`;
}

export function getUnsupportedParameters(key: string): ReadonlySet<OptionalModelParameter> {
  return unsupportedParameters.get(key) ?? new Set();
}

export function markParameterUnsupported(key: string, name: OptionalModelParameter): void {
  unsupportedParameters.set(key, new Set([...getUnsupportedParameters(key), name]));
}

/** Test-only reset of the remembered compatibility. */
export function resetOptionalParameterCompatibility(): void {
  unsupportedParameters.clear();
}

export function rejectsOptionalParameter(
  error: { status?: number; message: string; param?: string },
  name: OptionalModelParameter,
): boolean {
  if (error.status !== 400) return false;
  if (error.param === name) return true;
  return new RegExp(`\\b${name}\\b`, "i").test(error.message)
    && /unsupported|not supported|unrecognized|unknown|not allowed|invalid|only the default/i.test(error.message);
}
