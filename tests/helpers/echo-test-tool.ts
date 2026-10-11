import type {
  ContinueOutcome,
  RegisteredTool,
} from "@/server/chat/tool-registry";

// The MC-117A test-only stub tool. Never registered in production; exercises
// multi-round, budget-cap, failure, and cancellation paths end-to-end.
export function makeEchoTestTool(
  overrides: Partial<RegisteredTool> = {},
): RegisteredTool {
  return {
    name: "echo_test",
    description: "Echoes the given text back. Test-only.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    effect: "read",
    gate: "test_only",
    trustClass: "local_authoritative",
    outcomeClass: "continue",
    visibility: "transient_status",
    resultTokenBudget: 800,
    persistenceEligible: false,
    failurePolicy: "recoverable_result",
    idempotency: "not_applicable",
    async execute(input): Promise<ContinueOutcome> {
      const text = typeof input.text === "string" ? input.text : "";
      return { kind: "continue", result: { content: `echo: ${text}` } };
    },
    ...overrides,
  };
}
