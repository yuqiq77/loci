import { NextRequest } from "next/server";

export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",").at(-1)?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
