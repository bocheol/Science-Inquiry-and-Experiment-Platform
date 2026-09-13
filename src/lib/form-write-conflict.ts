import { UserFacingError } from "@/lib/user-facing-error";

export class FormWriteConflict extends UserFacingError {
  readonly status = 409;
  constructor(message = "다른 곳에서 저장한 내용이 있습니다. 최신 내용과 내 작성 내용을 비교해 주세요.") { super(message); }
}

export function sameFormValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameFormValue(value, right[index]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameFormValue(a[key], b[key]));
}
