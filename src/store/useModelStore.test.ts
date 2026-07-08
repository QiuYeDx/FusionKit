import { describe, expect, it } from "vitest";
import {
  migrateModelProfilesToV3,
  normalizeModelProfileForRuntime,
} from "./useModelStore";
import { Model, type ModelProfile } from "@/type/model";

describe("model store profile migration", () => {
  it("keeps migrated profiles on legacy Chat Completions defaults", () => {
    const migrated = migrateModelProfilesToV3({
      profiles: [
        {
          id: "profile_openai",
          name: "OpenAI",
          provider: Model.OpenAI,
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1/chat/completions",
          modelKey: "gpt-5",
          tokenPricing: {
            inputTokensPerMillion: 1,
            outputTokensPerMillion: 2,
          },
        },
      ],
      assignment: {
        agent: "profile_openai",
        taskExecution: "profile_openai",
      },
    });

    expect(migrated.profiles[0]).toMatchObject({
      apiFormat: "chat_completions",
      outputTokenParameter: "max_completion_tokens",
    });
    expect(migrated.assignment).toEqual({
      agent: "profile_openai",
      taskExecution: "profile_openai",
    });
  });

  it("uses provider defaults for new runtime profiles", () => {
    const normalized = normalizeModelProfileForRuntime({
      id: "profile_new_openai",
      name: "OpenAI",
      provider: Model.OpenAI,
      apiKey: "sk-new",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5",
      tokenPricing: {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
    } satisfies Omit<
      ModelProfile,
      "apiFormat" | "outputTokenParameter"
    >);

    expect(normalized).toMatchObject({
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
    });
  });
});
