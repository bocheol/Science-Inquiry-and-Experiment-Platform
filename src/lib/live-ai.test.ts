import { expect, it } from "vitest";
import { composeLiveAiInstructions } from "@/lib/live-ai";

it("keeps live answers brief and excludes all personal journals", () => {
  const instructions = composeLiveAiInstructions("팀 공개 자료");
  expect(instructions).toContain("1~3문장");
  expect(instructions).toContain("학생이 말하는 중에는 끼어들지 마세요");
  expect(instructions).toContain("개인 일지는 제공되지 않으며");
  expect(instructions).toContain("팀 공개 자료");
});
