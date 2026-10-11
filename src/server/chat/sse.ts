const encoder = new TextEncoder();

export function encodeSse(event: string, data: unknown): Uint8Array {
  return encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}
