import { documentVersionGet } from "@/lib/document-version-api";
export async function GET(request: Request) { return documentVersionGet(request, "compare"); }
