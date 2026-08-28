import fs from "node:fs";
import PDFDocument from "pdfkit";
import type { ExamSetData } from "@/lib/exam-service";
import { questionsForPaper } from "@/lib/exam-service";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 48;

function findKoreanFont() {
  const candidates = [
    process.env.PDF_FONT_PATH,
    "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/malgun.ttf",
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("한글 PDF 글꼴을 찾지 못했습니다.");
  return found;
}

function scopeLabel(scope: string) {
  return scope === "common" ? "전체 공통" : scope === "team" ? "팀 공통" : "개인화";
}

function useKoreanFont(doc: PDFKit.PDFDocument, fontPath: string) {
  if (fontPath.toLowerCase().endsWith(".ttc")) doc.font(fontPath, "NotoSansCJKkr-Regular");
  else doc.font(fontPath);
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height > A4_HEIGHT - MARGIN - 28) doc.addPage();
}

function renderStimulus(doc: PDFKit.PDFDocument, text: string, fontPath: string) {
  if (!text.trim()) return;
  useKoreanFont(doc, fontPath);
  doc.fontSize(9.5);
  const width = A4_WIDTH - MARGIN * 2 - 22;
  const height = doc.heightOfString(text, { width, lineGap: 2 }) + 18;
  ensureSpace(doc, height + 10);
  const y = doc.y;
  doc.roundedRect(MARGIN, y, A4_WIDTH - MARGIN * 2, height, 6).fill("#f3f6f4");
  doc.fillColor("#263a32").text(text, MARGIN + 11, y + 9, { width, lineGap: 2 });
  doc.y = y + height + 8;
}

function renderQuestion(
  doc: PDFKit.PDFDocument,
  question: ReturnType<typeof questionsForPaper>[number],
  number: number,
  fontPath: string,
  includeAnswers: boolean,
) {
  ensureSpace(doc, includeAnswers ? 170 : 120);
  useKoreanFont(doc, fontPath);
  doc.fillColor("#1f6a50").fontSize(9).text(`[${scopeLabel(question.scope)}] ${question.competency} · ${question.maxScore}점`, { lineGap: 1 });
  doc.moveDown(0.25).fillColor("#15231e").fontSize(11.5).text(`${number}. ${question.question}`, { lineGap: 3 });
  doc.moveDown(0.5);
  renderStimulus(doc, question.stimulus, fontPath);

  if (includeAnswers) {
    useKoreanFont(doc, fontPath);
    doc.fillColor("#1f6a50").fontSize(9).text("모범답안");
    doc.fillColor("#263a32").fontSize(9.5).text(question.modelAnswer, { lineGap: 2 });
    doc.moveDown(0.35).fillColor("#1f6a50").fontSize(9).text("채점 기준");
    question.scoringRubric.forEach((item) => {
      doc.fillColor("#263a32").fontSize(9).text(`• ${item.criterion} (${item.points}점)`, { indent: 6, lineGap: 1 });
    });
    doc.moveDown(0.7);
  } else {
    const lineCount = Math.min(8, Math.max(3, Math.ceil(question.maxScore / 4)));
    for (let index = 0; index < lineCount; index += 1) {
      ensureSpace(doc, 20);
      doc.moveDown(0.55).moveTo(MARGIN, doc.y).lineTo(A4_WIDTH - MARGIN, doc.y).strokeColor("#b8c3bd").lineWidth(0.5).stroke();
    }
    doc.moveDown(0.8);
  }
}

export async function buildExamPdf(data: ExamSetData, includeAnswers = false) {
  const fontPath = findKoreanFont();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
    bufferPages: true,
    autoFirstPage: false,
    info: { Title: `${data.title}${includeAnswers ? " - 교사용 답안" : ""}`, Author: "과탐실 AI 탐구 플랫폼" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  data.papers.forEach((paper) => {
    doc.addPage();
    useKoreanFont(doc, fontPath);
    doc.fillColor("#1f6a50").fontSize(10).text("과탐실 AI 탐구 플랫폼", { align: "center" });
    doc.moveDown(0.35).fillColor("#15231e").fontSize(19).text(includeAnswers ? `${data.title} - 교사용 답안` : data.title, { align: "center" });
    doc.moveDown(0.6).fontSize(10.5).text(`${paper.classNumber}반  |  ${paper.teamName}  |  학번 ${paper.loginId}  |  이름 ${paper.studentName}`, { align: "center" });
    doc.moveDown(0.8).strokeColor("#7fa595").lineWidth(1).moveTo(MARGIN, doc.y).lineTo(A4_WIDTH - MARGIN, doc.y).stroke();
    doc.moveDown(0.7);
    const questions = questionsForPaper(data, paper);
    questions.forEach((question, index) => renderQuestion(doc, question, index + 1, fontPath, includeAnswers));
    useKoreanFont(doc, fontPath);
    doc.moveDown(0.5).fillColor("#53675f").fontSize(8.5).text(`총점 ${questions.reduce((sum, question) => sum + question.maxScore, 0)}점`, { align: "right" });
  });

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    useKoreanFont(doc, fontPath);
    doc.fillColor("#74837d").fontSize(8).text(`${index + 1} / ${range.count}`, MARGIN, A4_HEIGHT - 30, {
      width: A4_WIDTH - MARGIN * 2, align: "center", lineBreak: false,
    });
  }
  doc.end();
  return done;
}
