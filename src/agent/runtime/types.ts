export interface AgentRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AgentRuntimeStreamPart =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "tool-input-start";
      id: string;
      toolName: string;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      responseItemId?: string;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      type: "finish-step";
      usage?: AgentRuntimeUsage;
    }
  | {
      type: "error";
      error: unknown;
    };

export interface AgentRuntimeTurnResult {
  fullStream: AsyncIterable<AgentRuntimeStreamPart>;
  usage: Promise<AgentRuntimeUsage | undefined>;
}
