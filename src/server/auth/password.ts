import { verify } from "argon2";

import { getAuthEnv } from "@/server/env";

export async function verifyPassword(password: string): Promise<boolean> {
  try {
    return await verify(getAuthEnv().OWNER_PASSWORD_HASH, password);
  } catch {
    return false;
  }
}
