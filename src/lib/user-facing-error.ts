export class UserFacingError extends Error {}

export function userFacingMessage(error: unknown, fallback: string) {
  return error instanceof UserFacingError ? error.message : fallback;
}
