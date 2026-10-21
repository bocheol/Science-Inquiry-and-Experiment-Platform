import type { SessionUser } from "@/lib/types";

export const EXPECTED_USER_HEADER = "x-expected-user-id";
/** A stale tab must never submit the previous owner's draft under a new cookie. */
export function requestMatchesUser(request: Request, user: Pick<SessionUser, "id">) {
  return request.headers.get(EXPECTED_USER_HEADER) === user.id;
}
