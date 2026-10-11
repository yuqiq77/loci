export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
