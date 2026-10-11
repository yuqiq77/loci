// SSE-encodes a list of Anthropic stream events into a fetch Response, the
// shared fake-wire helper for provider tests.
export function streamResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: event\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
