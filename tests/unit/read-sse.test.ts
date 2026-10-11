import { describe, expect, it } from "vitest";

import { readSse } from "@/features/chat/read-sse";

describe("readSse", () => {
  it("parses events split across stream chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: delta\ndata: {"text":"hel'),
        );
        controller.enqueue(
          encoder.encode(
            'lo"}\n\nevent: done\ndata: {"assistantMessageId":"a"}\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = [];
    for await (const event of readSse(body)) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "delta", data: { text: "hello" } },
      {
        event: "done",
        data: { assistantMessageId: "a" },
      },
    ]);
  });

  it("parses transient tool status events (MC-117C)", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: tool\ndata: {"status":"running","toolName":"search_memory"}\n\n' +
              'event: tool\ndata: {"status":"ok","toolName":"search_memory"}\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = [];
    for await (const event of readSse(body)) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "tool", data: { status: "running", toolName: "search_memory" } },
      { event: "tool", data: { status: "ok", toolName: "search_memory" } },
    ]);
  });
});
