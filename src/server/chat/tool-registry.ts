import { createHash } from "node:crypto";

import { isMemoryEnabled } from "@/server/memory/embedding";

import { searchMemoryTool } from "./tools/search-memory";
import type { WireToolDefinition } from "./types";

// Tool registry contracts (MC-117A, addendum §4). A tool is a behavioral
// contract, not just name + schema. The production list below holds the
// client tools that ship (search_memory since MC-117B, behind the
// tools_enabled gate and the embedding configuration); test-only stubs are
// registered from tests and never enter it.

export type ToolEffect =
  | "read"
  | "internal_write"
  | "external_write"
  | "destructive";

// Which owner setting enables the tool. "tools_enabled" is the client-tool
// gate (MC-117B) — provider-hosted web_search stays on its own independent
// gate and never appears in this registry. "test_only" marks stubs that are
// registered from tests and never enter the production list.
export type ToolGate = "test_only" | "tools_enabled";

export type ToolTrustClass =
  | "local_authoritative"
  | "owner_data"
  | "retrieved_memory"
  | "external_untrusted";

export type ToolOutcomeClass =
  | "continue"
  | "yield"
  | "present"
  | "enqueue"
  | "terminal";

export type ToolVisibility =
  | "silent"
  | "transient_status"
  | "durable_block"
  | "owner_approval";

export type ToolFailurePolicy =
  | "recoverable_result"
  | "hard_failure"
  | "owner_visible_retry";

export type ToolIdempotency = "not_applicable" | "idempotent";

// The outcome discriminator (addendum §3). Phase A can only reach
// `continue`; the other variants exist so the discriminator is real, but
// carry an unexported symbol typed `never`, which makes them impossible to
// instantiate. Their semantics are deliberately NOT pre-frozen here.
declare const unreachableOutcome: unique symbol;

type UnreachableOutcome<Kind extends string> = {
  kind: Kind;
  readonly [unreachableOutcome]: never;
};

export type ContinueOutcome = {
  kind: "continue";
  result: { content: string; isError?: boolean };
};

export type ToolOutcome =
  | ContinueOutcome
  | UnreachableOutcome<"yield">
  | UnreachableOutcome<"present">
  | UnreachableOutcome<"enqueue">
  | UnreachableOutcome<"terminal">;

// Per-attempt execution context handed to every tool call. Concrete, not an
// abstraction: excludeMemoryIds carries the route-held IDs of memories this
// request already injected as automatic anchors (MC-117B decision 3).
export type ToolExecutionContext = {
  signal: AbortSignal;
  excludeMemoryIds: readonly string[];
};

export type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  gate: ToolGate;
  trustClass: ToolTrustClass;
  outcomeClass: ToolOutcomeClass;
  visibility: ToolVisibility;
  // Maximum estimated tokens this tool may return to the model; the loop
  // additionally clamps to its per-result and attempt-total budgets.
  resultTokenBudget: number;
  // Whether the result may feed any continuity carrier. Always false in
  // Phase A — no reader consumes tool output.
  persistenceEligible: boolean;
  failurePolicy: ToolFailurePolicy;
  idempotency: ToolIdempotency;
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolOutcome>;
};

// Deterministic serialization: object keys sorted recursively so the wire
// `tools` field — part of the provider's prompt-cache identity (D3) — and the
// schema hash cannot drift with key insertion order.
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

// The single source for both the wire definition and tool_schema_hash: the
// hash is computed over exactly the bytes the provider receives.
export function serializeToolDefinition(
  tool: RegisteredTool,
): WireToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: sortValue(tool.inputSchema) as Record<string, unknown>,
  };
}

export function toolSchemaHash(tool: RegisteredTool): string {
  return createHash("sha256")
    .update(JSON.stringify(serializeToolDefinition(tool)))
    .digest("hex");
}

// Production allowlist: exactly [search_memory] (MC-117B). The stub tool is
// registered only from tests via registerToolForTests and never enters this
// list.
const PRODUCTION_TOOLS: readonly RegisteredTool[] = [searchMemoryTool];

let testTools: RegisteredTool[] = [];

export function registerToolForTests(tool: RegisteredTool): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test-only tool registration is disabled in production.");
  }
  if (allRegisteredTools().some((existing) => existing.name === tool.name)) {
    // A duplicate name would put two definitions on the wire and let the
    // stub shadow a production tool through the snapshot's name map.
    throw new Error(`Tool ${tool.name} is already registered.`);
  }
  testTools.push(tool);
}

export function resetToolsForTests(): void {
  testTools = [];
}

function allRegisteredTools(): RegisteredTool[] {
  return [...PRODUCTION_TOOLS, ...testTools];
}

// The gated tool surface, evaluated at beginGeneration against the settings
// row read in the same transaction (the snapshot point of 117A decision 6).
// A gate is owner setting AND environment condition (addendum §4): the one
// production tool additionally requires a configured embedding provider —
// without it the toggle would advertise a tool whose every call fails,
// burning rounds and the recoverable-failure budget. Test-registered stubs
// bypass the owner gate by construction.
export function getEnabledTools(toolsEnabled: boolean): RegisteredTool[] {
  return [
    ...PRODUCTION_TOOLS.filter(
      (tool) =>
        tool.gate === "tools_enabled" && toolsEnabled && isMemoryEnabled(),
    ),
    ...testTools,
  ];
}

// Resolves the tool-name snapshot taken at beginGeneration back to registry
// entries. Resolution is gate-blind on purpose: the gate was applied at the
// snapshot, and a settings flip mid-attempt must not change the attempt's
// tool surface. Names missing from the registry are dropped, not refreshed.
export function resolveToolSnapshot(names: string[]): RegisteredTool[] {
  const byName = new Map(
    allRegisteredTools().map((tool) => [tool.name, tool]),
  );
  return names.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
}
