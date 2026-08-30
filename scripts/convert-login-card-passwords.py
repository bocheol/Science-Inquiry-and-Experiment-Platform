import argparse
import json
import os
import re

import pdfplumber
from reportlab.lib.pagesizes import A4


INITIAL_KEYS = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"]
MEDIAL_KEYS = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"]
FINAL_KEYS = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"]


def hangul_to_dubeolsik(value):
    converted = []
    for character in value:
        code_point = ord(character)
        if not 0xAC00 <= code_point <= 0xD7A3:
            converted.append(character)
            continue

        syllable_offset = code_point - 0xAC00
        initial_index = syllable_offset // 588
        medial_index = (syllable_offset % 588) // 28
        final_index = syllable_offset % 28
        converted.append(
            INITIAL_KEYS[initial_index]
            + MEDIAL_KEYS[medial_index]
            + FINAL_KEYS[final_index]
        )
    return "".join(converted)


def card_boxes(page_width, page_height):
    margin_x, margin_y = 25, 25
    gap_x, gap_y = 8, 8
    card_width = (page_width - 2 * margin_x - gap_x) / 2
    card_height = (page_height - 2 * margin_y - 3 * gap_y) / 4
    for index in range(8):
        row, col = divmod(index, 2)
        x = margin_x + col * (card_width + gap_x)
        y = page_height - margin_y - (row + 1) * card_height - row * gap_y
        yield (x, page_height - (y + card_height), x + card_width, page_height - y)


def extract_credentials(pdf_path):
    credentials = []
    with pdfplumber.open(pdf_path) as document:
        for page in document.pages:
            for box in card_boxes(page.width, page.height):
                text = page.crop(box).extract_text() or ""
                login_match = re.search(r"\b1\d{4}\b", text)
                password_match = re.search(r"[가-힣]+\d{5}[!#?]", text)
                header_match = re.search(r"1학년\s+(\d+)반\s+([^\n]+)", text)
                if not login_match and not password_match and not header_match:
                    continue
                if not (login_match and password_match and header_match):
                    raise ValueError("로그인 카드에서 필요한 항목을 모두 읽지 못했습니다.")

                name = header_match.group(2).strip()
                credentials.append(
                    {
                        "classNumber": int(header_match.group(1)),
                        "name": name,
                        "loginId": login_match.group(0),
                        "temporaryPassword": hangul_to_dubeolsik(password_match.group(0)),
                    }
                )
    return credentials


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf")
    parser.add_argument("output_json")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--expected", type=int, required=True)
    args = parser.parse_args()

    credentials = extract_credentials(args.input_pdf)
    login_ids = [credential["loginId"] for credential in credentials]
    if len(credentials) != args.expected:
        raise ValueError("로그인 카드 수가 예상과 다릅니다.")
    if len(set(login_ids)) != len(login_ids):
        raise ValueError("로그인 카드에 중복 아이디가 있습니다.")
    if any(re.search(r"[가-힣]", credential["temporaryPassword"]) for credential in credentials):
        raise ValueError("변환된 임시 비밀번호에 한글이 남아 있습니다.")

    payload = {"baseUrl": args.base_url, "issued": credentials}
    output_dir = os.path.dirname(args.output_json)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")

    print(json.dumps({"students": len(credentials), "converted": True}))


if __name__ == "__main__":
    main()
