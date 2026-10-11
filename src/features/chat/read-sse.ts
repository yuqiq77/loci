export type ChatStreamEvent =
  | {
      event: "message";
      data: { userMessageId: string; assistantMessageId: string };
    }
  | { event: "delta"; data: { text: string } }
  | { event: "thinking"; data: { text: string } }
  | { event: "search"; data: Record<string, never> }
  | {
      event: "tool";
      data: { status: "running" | "ok" | "error"; toolName: string };
    }
  | {
      event: "usage";
      data: {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    }
  | {
      event: "done";
      data: { assistantMessageId: string; finishReason?: string };
    }
  | {
      event: "error";
      data: { code: string; message: string; retracted?: boolean };
    };

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      let event = "";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trimStart();
        }
      }
      if (event && data) {
        yield {
          event,
          data: JSON.parse(data),
        } as ChatStreamEvent;
      }
    }

    if (done) {
      break;
    }
  }
}
