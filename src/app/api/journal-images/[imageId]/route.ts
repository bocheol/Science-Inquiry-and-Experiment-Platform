import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getJournalImage, JournalAccessError } from "@/lib/journal-service";

export async function GET(_request: Request, context: { params: Promise<{ imageId: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const { imageId } = await context.params;
  try {
    const image = await getJournalImage(user, imageId);
    return new NextResponse(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof JournalAccessError ? error.status : 400;
    return NextResponse.json({ message: error instanceof Error ? error.message : "사진을 불러오지 못했습니다." }, { status });
  }
}
