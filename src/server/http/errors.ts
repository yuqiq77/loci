import { NextResponse } from "next/server";

export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  INVALID_INPUT: 400,
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MEMORY_NOT_FOUND: 404,
  GENERATION_IN_PROGRESS: 409,
  MESSAGE_NOT_RETRYABLE: 409,
  NARRATIVE_VERSION_CONFLICT: 409,
  MODEL_NOT_CONFIGURED: 400,
  PROVIDER_UNAVAILABLE: 502,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  UNAUTHORIZED: "Authentication required.",
  INVALID_INPUT: "The request was invalid.",
  SESSION_NOT_FOUND: "Session not found.",
  MESSAGE_NOT_FOUND: "Message not found.",
  MEMORY_NOT_FOUND: "Memory not found.",
  GENERATION_IN_PROGRESS: "A response is already being generated.",
  MESSAGE_NOT_RETRYABLE: "This exchange can no longer be rewritten.",
  NARRATIVE_VERSION_CONFLICT:
    "The narrative changed since it was loaded. Reload to edit the latest version.",
  MODEL_NOT_CONFIGURED: "The selected model is not configured.",
  PROVIDER_UNAVAILABLE: "The model provider is unavailable.",
  INTERNAL_ERROR: "Something went wrong.",
};

export function errorResponse(
  code: ErrorCode,
  message?: string,
): NextResponse {
  return NextResponse.json(
    { error: { code, message: message ?? DEFAULT_MESSAGE[code] } },
    { status: ERROR_STATUS[code] },
  );
}
