import { argon2id, hash } from "argon2";

async function main(): Promise<void> {
  const password = process.env.OWNER_PASSWORD;

  if (!password) {
    throw new Error(
      "OWNER_PASSWORD is required. See README.md for the masked prompt command.",
    );
  }

  console.log((await hash(password, { type: argon2id })).replaceAll("$", "\\$"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Hashing failed.");
  process.exitCode = 1;
});
