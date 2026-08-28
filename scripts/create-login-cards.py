import json
import os
import sys
from collections import defaultdict

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode import qr
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


def register_fonts():
    regular = r"C:\Windows\Fonts\malgun.ttf"
    bold = r"C:\Windows\Fonts\malgunbd.ttf"
    if not os.path.exists(regular) or not os.path.exists(bold):
        raise FileNotFoundError("맑은 고딕 글꼴을 찾지 못했습니다.")
    pdfmetrics.registerFont(TTFont("Malgun", regular))
    pdfmetrics.registerFont(TTFont("MalgunBold", bold))


def draw_qr(pdf, value, x, y, size):
    code = qr.QrCodeWidget(value)
    bounds = code.getBounds()
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    drawing = Drawing(size, size, transform=[size / width, 0, 0, size / height, 0, 0])
    drawing.add(code)
    renderPDF.draw(drawing, pdf, x, y)


def draw_card(pdf, credential, base_url, x, y, width, height):
    navy = colors.HexColor("#173B63")
    pale = colors.HexColor("#EEF5FA")
    ink = colors.HexColor("#14202B")
    muted = colors.HexColor("#52606D")

    pdf.setStrokeColor(colors.HexColor("#9FB5C7"))
    pdf.setLineWidth(0.8)
    pdf.roundRect(x, y, width, height, 8, stroke=1, fill=0)
    pdf.setFillColor(navy)
    pdf.roundRect(x, y + height - 29, width, 29, 8, stroke=0, fill=1)
    pdf.rect(x, y + height - 29, width, 8, stroke=0, fill=1)

    pdf.setFillColor(colors.white)
    pdf.setFont("MalgunBold", 11)
    pdf.drawString(x + 12, y + height - 19, "과탐실 AI 탐구 플랫폼 - 첫 로그인")

    pdf.setFillColor(ink)
    pdf.setFont("MalgunBold", 11)
    pdf.drawString(x + 13, y + height - 49, f"1학년 {credential['classNumber']}반  {credential['name']}")

    label_x = x + 13
    value_x = x + 78
    first_line = y + height - 76
    pdf.setFont("Malgun", 9)
    pdf.setFillColor(muted)
    pdf.drawString(label_x, first_line, "로그인 아이디")
    pdf.drawString(label_x, first_line - 27, "임시 비밀번호")

    pdf.setFillColor(pale)
    pdf.roundRect(value_x - 7, first_line - 7, width - 150, 20, 4, stroke=0, fill=1)
    pdf.roundRect(value_x - 7, first_line - 34, width - 150, 20, 4, stroke=0, fill=1)
    pdf.setFillColor(ink)
    pdf.setFont("MalgunBold", 12)
    pdf.drawString(value_x, first_line, credential["loginId"])
    pdf.drawString(value_x, first_line - 27, credential["temporaryPassword"])

    qr_size = 48
    draw_qr(pdf, base_url, x + width - qr_size - 12, y + 39, qr_size)
    pdf.setFillColor(muted)
    pdf.setFont("Malgun", 7.3)
    pdf.drawString(x + 13, y + 45, "1. QR 또는 아래 주소로 접속")
    pdf.drawString(x + 13, y + 31, "2. 처음 로그인하면 본인 비밀번호로 변경")
    display_url = base_url.replace("https://", "")
    pdf.setFont("Malgun", 6.4)
    pdf.drawString(x + 13, y + 15, display_url)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("사용법: create-login-cards.py credentials.json output.pdf")
    source_path, output_path = sys.argv[1], sys.argv[2]
    with open(source_path, "r", encoding="utf-8") as stream:
        payload = json.load(stream)
    issued = payload.get("issued", [])
    if not issued:
        raise ValueError("발급된 학생 계정이 없습니다.")

    register_fonts()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    grouped = defaultdict(list)
    for credential in sorted(issued, key=lambda item: (item["classNumber"], item["loginId"])):
        grouped[int(credential["classNumber"])].append(credential)

    page_width, page_height = A4
    margin_x, margin_y = 25, 25
    gap_x, gap_y = 8, 8
    card_width = (page_width - 2 * margin_x - gap_x) / 2
    card_height = (page_height - 2 * margin_y - 3 * gap_y) / 4
    pdf = canvas.Canvas(output_path, pagesize=A4, pageCompression=1)
    pdf.setTitle("2026 학생 임시 로그인 카드")
    pdf.setAuthor("과탐실 AI 탐구 플랫폼")

    page_number = 0
    for class_number in sorted(grouped):
        cards = grouped[class_number]
        for page_start in range(0, len(cards), 8):
            page_number += 1
            page_cards = cards[page_start : page_start + 8]
            for index, credential in enumerate(page_cards):
                row, col = divmod(index, 2)
                x = margin_x + col * (card_width + gap_x)
                y = page_height - margin_y - (row + 1) * card_height - row * gap_y
                draw_card(pdf, credential, payload["baseUrl"], x, y, card_width, card_height)
            pdf.setFillColor(colors.HexColor("#607080"))
            pdf.setFont("Malgun", 7)
            pdf.drawCentredString(page_width / 2, 10, f"1학년 {class_number}반 - {page_number}쪽")
            pdf.showPage()

    pdf.save()
    print(json.dumps({"students": len(issued), "pages": page_number, "output": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
