import { createServer, type ServerResponse } from "node:http";

const port = 4010;
// Delay applied only to the mock's own search_memory query, so the client's
// transient tool status stays observable; ambient retrieval embeds of user
// text (every send, once an embedding provider is configured) stay instant.
const TOOL_QUERY = "mc117c-probe";
const EMBEDDING_DELAY_MS = 4_000;

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }

  // OpenAI-compatible embeddings for the MC-117C tool flow: a fixed unit
  // vector after a deliberate delay, so the client's transient tool status
  // stays observable while search_memory embeds its query.
  if (request.method === "POST" && request.url === "/v1/embeddings") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        input: string[];
        dimensions?: number;
      };
      const dimensions = body.dimensions ?? 1536;
      const vector = [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
      const delay = body.input.some((text) => text.includes(TOOL_QUERY))
        ? EMBEDDING_DELAY_MS
        : 0;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({ index, embedding: vector })),
          }),
        );
      }, delay);
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/messages") {
    response.writeHead(404);
    response.end();
    return;
  }

  if (
    request.headers["x-api-key"] !== "playwright-chat-key" ||
    !request.headers["anthropic-version"]
  ) {
    response.writeHead(401);
    response.end();
    return;
  }

  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw) as {
      system?: string | { text?: string }[];
      messages?: { content: string | { type: string; text?: string }[] }[];
      tools?: unknown[];
    };
    // Decide on the LAST message only: markers stay in a session's history
    // forever, and background jobs (title, summary) replay transcripts to
    // this mock without advertising tools. A continuation request ends with
    // the tool_result turn of the round before.
    const last = body.messages?.at(-1);
    const lastBlocks = Array.isArray(last?.content) ? last.content : null;
    const continuation =
      lastBlocks?.some((block) => block.type === "tool_result") ?? false;
    const lastText =
      typeof last?.content === "string"
        ? last.content
        : (lastBlocks?.map((block) => block.text ?? "").join("\n") ?? "");
    if (
      raw.includes("trigger-provider-failure") ||
      (continuation && raw.includes("trigger-tool-then-failure"))
    ) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"type":"error","error":{"type":"api_error"}}');
      return;
    }
    if (
      !continuation &&
      (body.tools?.length ?? 0) > 0 &&
      /trigger-tool-(call|then-failure)/.test(lastText)
    ) {
      streamEvents(response, [
        {
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_playwright",
            name: "search_memory",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ query: TOOL_QUERY }),
          },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 4 },
        },
        { type: "message_stop" },
      ]);
      return;
    }
    const system = Array.isArray(body.system)
      ? body.system.map((block) => block.text ?? "").join("\n")
      : body.system ?? "";
    const reply = continuation
      ? "Recalled and replied."
      : system.includes("Playwright system prompt")
        ? "Settings applied."
        : "Hello from mock Anthropic.";

    streamEvents(response, [
      {
        type: "message_start",
        message: { usage: { input_tokens: 7, output_tokens: 0 } },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: reply },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]);
  });
});

function streamEvents(
  response: ServerResponse,
  events: ({ type: string } & Record<string, unknown>)[],
) {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream",
    connection: "keep-alive",
  });
  let index = 0;
  const sendNext = () => {
    const event = events[index];
    if (!event) {
      response.end();
      return;
    }
    response.write(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
    index += 1;
    setTimeout(sendNext, 80);
  };
  sendNext();
}

server.listen(port, "127.0.0.1");

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
