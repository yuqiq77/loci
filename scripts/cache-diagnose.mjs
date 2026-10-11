// Standalone prompt-caching diagnostic. Bypasses the app entirely and hits the
// configured provider directly, so you can tell WHICH layer is broken:
//   - provider doesn't read caches at all
//   - cache_control on `system` isn't honored (only on message blocks)
//   - prefix is just too short (< 1024 tokens)
//   - the streaming usage fields are reported in a place the app doesn't parse
//
// Run:  node scripts/cache-diagnose.mjs
// Reads CHAT_API_KEY / CHAT_BASE_URL / CHAT_MODEL from .env.local (or the env).

import { readFileSync } from "node:fs";

// --- load .env.local without printing secrets -------------------------------
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const API_KEY = process.env.CHAT_API_KEY;
const BASE_URL = (process.env.CHAT_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MODEL = process.env.CHAT_MODEL;

if (!API_KEY || !MODEL) {
  console.error("Missing CHAT_API_KEY or CHAT_MODEL. Set them in .env.local.");
  process.exit(1);
}
console.log(`endpoint: ${BASE_URL}/v1/messages`);
console.log(`model:    ${MODEL}\n`);

// A big, STATIC block that is comfortably over the 1024-token minimum so the
// breakpoint is guaranteed to be eligible. ~1 token per ~3-4 chars.
const BIG = ("You are a helpful assistant. " +
  "The following is fixed background reference text used only to pad the prompt. ")
  .repeat(120); // ~ a few thousand tokens

async function call({ label, body }) {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`  [${label}] HTTP ${res.status}: ${text.slice(0, 300)}`);
    return;
  }
  let usage;
  try {
    usage = JSON.parse(text).usage;
  } catch {
    console.log(`  [${label}] could not parse JSON: ${text.slice(0, 200)}`);
    return;
  }
  console.log(
    `  [${label}] input=${usage?.input_tokens}` +
      ` cache_write=${usage?.cache_creation_input_tokens}` +
      ` cache_read=${usage?.cache_read_input_tokens}`,
  );
}

const base = { model: MODEL, max_tokens: 16, stream: false };

// Test A: cache_control on the SYSTEM array. Two identical calls.
async function testSystem() {
  console.log("Test A — breakpoint on `system` array (sent twice, identical):");
  const body = {
    ...base,
    system: [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  await call({ label: "A1", body });
  await call({ label: "A2", body });
}

// Test B: cache_control on the first USER message content block.
async function testMessage() {
  console.log("\nTest B — breakpoint on first user message block (sent twice):");
  const body = {
    ...base,
    messages: [
      { role: "user", content: [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "hi" },
    ],
  };
  await call({ label: "B1", body });
  await call({ label: "B2", body });
}

// Test C: same as A but read raw streaming events, to see WHERE usage is
// reported (some relays only put cache_read in message_delta / message_stop).
async function testStreamUsage() {
  console.log("\nTest C — streaming: which event carries cache_read?");
  const body = {
    ...base,
    stream: true,
    system: [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  // prime the cache first
  await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ ...body, stream: false }),
  }).then((r) => r.text());

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      const ev = JSON.parse(dataLine.slice(5).trim());
      const u = ev.usage || ev.message?.usage;
      if (u && (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null)) {
        console.log(`  event="${ev.type}" usage=${JSON.stringify(u)}`);
      }
    } catch {}
  }
}

await testSystem();
await testMessage();
await testStreamUsage();
console.log("\nDone.");
