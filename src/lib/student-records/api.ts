import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { RecordError } from "./access";

export async function recordsActor(request: Request, bind = true) {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) throw new RecordError("다시 로그인해 주세요.", 403);
  if (bind && request.headers.get("x-records-user") !== user.id) throw new RecordError("로그인 계정이 변경되었습니다. 페이지를 새로 열어 주세요.", 403);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== new URL(request.url).origin) throw new RecordError("현재 플랫폼에서 다시 요청해 주세요.", 403);
  return user;
}
export function recordApiError(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ message: error.issues[0]?.message ?? "입력을 확인해 주세요." }, { status: 400 });
  if (error instanceof RecordError || error instanceof FormWriteConflict) return NextResponse.json({ message: error.message }, { status: error.status });
  return NextResponse.json({ message: "세특 자료 처리에 실패했습니다. 입력을 보관한 뒤 다시 시도해 주세요." }, { status: 500 });
}
