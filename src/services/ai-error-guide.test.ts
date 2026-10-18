import { describe, expect, it } from "vitest";
import { Model } from "@/type/model";
import { DEEPSEEK_API_KEYS_URL, DEEPSEEK_TOP_UP_URL } from "@/constants/model";
import { MODEL_ERROR_CATEGORIES } from "@/lib/model-error-category";
import { MODEL_CONNECTION_TEST_REASONS } from "@/model-setup/contract";
import {
  CONNECTION_TEST_REASON_KEYS,
  classifyModelError,
  isDeepSeekProfile,
  modelErrorActionTarget,
  modelErrorGuide,
} from "./ai-error-guide";
import zhCommon from "@/locales/zh/common.json";

const deepseek = { provider: Model.DeepSeek, baseUrl: "https://api.deepseek.com/v1" };
const openai = { provider: Model.OpenAI, baseUrl: "https://api.openai.com/v1" };

/** The shape of the AI SDK's APICallError, as the Agent receives it. */
const apiCallError = (statusCode: number | undefined, responseBody: string | undefined, message = "API call failed") =>
  Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody, isRetryable: false });

describe("model error guide", () => {
  it("classifies the Agent's own request errors", () => {
    expect(classifyModelError(apiCallError(401, JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****abcd is invalid", type: "authentication_error" } })))).toBe("auth");
    expect(classifyModelError(apiCallError(402, JSON.stringify({ error: { message: "Insufficient Balance" } })))).toBe("balance");
    expect(classifyModelError(apiCallError(400, JSON.stringify({ error: { message: "Model Not Exist" } }), "Model Not Exist"))).toBe("model_not_found");
    expect(classifyModelError(apiCallError(429, JSON.stringify({ error: { message: "quota", code: "insufficient_quota" } })))).toBe("balance");
    expect(classifyModelError(apiCallError(429, ""))).toBe("rate_limited");
    expect(classifyModelError(apiCallError(502, "<html>Bad gateway</html>"))).toBe("server");
    expect(classifyModelError(apiCallError(404, "<html>Not Found</html>"))).toBe("bad_url");
    // An empty refusal is a key problem; a bare JSON 404 a wrong address.
    expect(classifyModelError(apiCallError(401, ""))).toBe("auth");
    expect(classifyModelError(apiCallError(404, JSON.stringify({ detail: "Not Found" })))).toBe("bad_url");
    // Chromium refuses a key with Chinese or full-width characters before sending.
    expect(classifyModelError(new TypeError("Failed to execute 'fetch' on 'Window': Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point."))).toBe("auth");
    // A fetch that could not connect: the AI SDK wraps Chromium's TypeError.
    expect(classifyModelError(Object.assign(apiCallError(undefined, undefined, "Cannot connect to API: Failed to fetch"), { cause: new TypeError("Failed to fetch") }))).toBe("network");
    expect(classifyModelError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyModelError(Object.assign(new Error("Invalid JSON response"), { name: "AI_JSONParseError" }))).toBe("bad_url");
    // The retry wrapper reports its last attempt.
    expect(classifyModelError({ name: "AI_RetryError", message: "Failed after 3 attempts", lastError: apiCallError(401, "{}") })).toBe("auth");
    // Payloads that already carry a category keep it.
    expect(classifyModelError({ category: "proxy" })).toBe("proxy");
    expect(classifyModelError(new Error("Agent context budget reached; continue in a new conversation."))).toBe("unknown");
    expect(classifyModelError("plain string")).toBe("unknown");
  });

  it("gives every category a cause, a next step and the right buttons", () => {
    for (const category of MODEL_ERROR_CATEGORIES) {
      const guide = modelErrorGuide(category, openai);
      expect(guide.causeKey).toBe(`common:model_error.${category}.cause`);
      expect(guide.nextKey).toBe(`common:model_error.${category}.next`);
    }
    // Under a real request's error, keys, cost and the proxy also link to their help section.
    expect(modelErrorGuide("auth", deepseek).actions).toEqual(["open_model_settings", "open_deepseek_keys", "open_help"]);
    expect(modelErrorGuide("auth", openai).actions).toEqual(["open_model_settings", "open_help"]);
    expect(modelErrorGuide("balance", deepseek).actions).toEqual(["open_deepseek_topup", "open_help"]);
    expect(modelErrorGuide("balance", openai).actions).toEqual(["open_help"]);
    expect(modelErrorGuide("model_not_found").actions).toEqual(["open_model_settings"]);
    expect(modelErrorGuide("bad_url").actions).toEqual(["open_model_settings"]);
    expect(modelErrorGuide("network").actions).toEqual(["open_network_settings", "open_help"]);
    expect(modelErrorGuide("proxy").actions).toEqual(["open_network_settings", "open_help"]);
    expect(modelErrorGuide("rate_limited").actions).toEqual([]);
    expect(modelErrorGuide("server").actions).toEqual([]);
  });

  it("links to the help section that explains the error, but not from the profile form or the wizard", () => {
    expect(modelErrorActionTarget("open_help", "balance")).toEqual({ kind: "route", to: "/help?section=models-and-cost" });
    expect(modelErrorActionTarget("open_help", "auth")).toEqual({ kind: "route", to: "/help?section=models-and-cost" });
    expect(modelErrorActionTarget("open_help", "proxy")).toEqual({ kind: "route", to: "/help?section=proxy" });
    expect(modelErrorActionTarget("open_help", "network")).toEqual({ kind: "route", to: "/help?section=proxy" });
    expect(modelErrorActionTarget("open_help")).toEqual({ kind: "route", to: "/help" });
    // Leaving would lose what is being filled in there.
    for (const context of ["connection_test", "wizard"] as const) {
      for (const category of MODEL_ERROR_CATEGORIES) expect(modelErrorGuide(category, deepseek, context).actions).not.toContain("open_help");
    }
  });

  it("words the next step for where it is shown, so it never points to the current place", () => {
    // In the profile form the fields are right there.
    expect(modelErrorGuide("bad_url", openai, "connection_test").nextKey).toBe("common:model_error.bad_url.next_test");
    expect(modelErrorGuide("model_not_found", openai, "connection_test").nextKey).toBe("common:model_error.model_not_found.next_test");
    expect(modelErrorGuide("unknown", openai, "connection_test").nextKey).toBe("common:model_error.unknown.next_test");
    expect(modelErrorGuide("auth", openai, "connection_test").nextKey).toBe("common:model_error.auth.next");
    // The wizard uses DeepSeek's own address: a page instead of the API was intercepted on the way.
    const wizard = modelErrorGuide("bad_url", deepseek, "wizard");
    expect(wizard).toMatchObject({ causeKey: "common:model_error.bad_url.cause_wizard", nextKey: "common:model_error.bad_url.next_wizard", actions: ["open_network_settings"] });
    expect(modelErrorGuide("model_not_found", deepseek, "wizard").nextKey).toBe("common:model_error.model_not_found.next_wizard");
    expect(modelErrorGuide("unknown", deepseek, "wizard").nextKey).toBe("common:model_error.unknown.next_test");
    expect(modelErrorGuide("bad_url", deepseek).causeKey).toBe("common:model_error.bad_url.cause");
  });

  it("has wording for every reason a connection test can stop with", () => {
    const lookup = (key: string) => key.replace(/^common:/, "").split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zhCommon);
    for (const reason of MODEL_CONNECTION_TEST_REASONS) {
      const keys: { cause: string; next?: string } = CONNECTION_TEST_REASON_KEYS[reason];
      expect(typeof lookup(keys.cause)).toBe("string");
      if (keys.next) expect(typeof lookup(keys.next)).toBe("string");
    }
    for (const context of ["runtime", "connection_test", "wizard"] as const) {
      for (const category of MODEL_ERROR_CATEGORIES) {
        const guide = modelErrorGuide(category, deepseek, context);
        expect(typeof lookup(guide.causeKey)).toBe("string");
        expect(typeof lookup(guide.nextKey)).toBe("string");
      }
    }
  });

  it("opens the model and network settings tabs and DeepSeek's own pages", () => {
    expect(modelErrorActionTarget("open_model_settings")).toEqual({ kind: "route", to: "/setting?tab=model" });
    expect(modelErrorActionTarget("open_network_settings")).toEqual({ kind: "route", to: "/setting?tab=proxy" });
    expect(modelErrorActionTarget("open_deepseek_keys")).toEqual({ kind: "external", url: DEEPSEEK_API_KEYS_URL });
    expect(modelErrorActionTarget("open_deepseek_topup")).toEqual({ kind: "external", url: DEEPSEEK_TOP_UP_URL });
    expect(DEEPSEEK_API_KEYS_URL).toBe("https://platform.deepseek.com/api_keys");
    expect(DEEPSEEK_TOP_UP_URL).toBe("https://platform.deepseek.com/top_up");
  });

  it("recognises DeepSeek by provider or by its address", () => {
    expect(isDeepSeekProfile(deepseek)).toBe(true);
    expect(isDeepSeekProfile({ provider: Model.Other, baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    expect(isDeepSeekProfile({ provider: Model.Other, baseUrl: "https://deepseek.com.example.org/v1" })).toBe(false);
    expect(isDeepSeekProfile({ provider: Model.Other, baseUrl: "not a url" })).toBe(false);
    expect(isDeepSeekProfile(null)).toBe(false);
  });
});
