from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "manuals"
URL = "https://science-inquiry-platform-974188506094.asia-northeast3.run.app"

pdfmetrics.registerFont(TTFont("Malgun", r"C:\Windows\Fonts\malgun.ttf"))
pdfmetrics.registerFont(TTFont("Malgun-Bold", r"C:\Windows\Fonts\malgunbd.ttf"))

GREEN = colors.HexColor("#146B55")
GREEN_DARK = colors.HexColor("#0E4F40")
GREEN_SOFT = colors.HexColor("#EAF5F0")
BLUE_SOFT = colors.HexColor("#EDF3FA")
GOLD_SOFT = colors.HexColor("#FFF6D8")
INK = colors.HexColor("#1E2D28")
MUTED = colors.HexColor("#5F7069")
LINE = colors.HexColor("#CBD8D2")


def styles():
    return {
        "kicker": ParagraphStyle("kicker", fontName="Malgun-Bold", fontSize=8.5, leading=10, textColor=GREEN, spaceAfter=2),
        "title": ParagraphStyle("title", fontName="Malgun-Bold", fontSize=21, leading=25, textColor=GREEN_DARK, spaceAfter=4),
        "subtitle": ParagraphStyle("subtitle", fontName="Malgun", fontSize=9.5, leading=13, textColor=MUTED, spaceAfter=8),
        "h1": ParagraphStyle("h1", fontName="Malgun-Bold", fontSize=13, leading=16, textColor=GREEN, spaceBefore=5, spaceAfter=4, keepWithNext=True),
        "step": ParagraphStyle("step", fontName="Malgun-Bold", fontSize=10.3, leading=13, textColor=GREEN_DARK, spaceBefore=4, spaceAfter=2, keepWithNext=True),
        "body": ParagraphStyle("body", fontName="Malgun", fontSize=8.5, leading=11.4, textColor=INK, spaceAfter=2.2),
        "bullet": ParagraphStyle("bullet", fontName="Malgun", fontSize=8.3, leading=11.1, textColor=INK, leftIndent=11, firstLineIndent=-7, bulletIndent=1, spaceAfter=1.8),
        "small": ParagraphStyle("small", fontName="Malgun", fontSize=7.7, leading=10, textColor=MUTED),
        "table_header": ParagraphStyle("table_header", fontName="Malgun-Bold", fontSize=7.8, leading=9.5, textColor=GREEN_DARK),
        "table": ParagraphStyle("table", fontName="Malgun", fontSize=7.6, leading=9.5, textColor=INK),
        "note_title": ParagraphStyle("note_title", fontName="Malgun-Bold", fontSize=8.3, leading=10, textColor=GREEN_DARK, spaceAfter=1.5),
        "note": ParagraphStyle("note", fontName="Malgun", fontSize=7.9, leading=10.3, textColor=INK),
        "url": ParagraphStyle("url", fontName="Malgun", fontSize=8.0, leading=10.2, textColor=INK),
    }


S = styles()


class GuideDoc(BaseDocTemplate):
    def __init__(self, path, audience):
        super().__init__(path, pagesize=A4, leftMargin=15*mm, rightMargin=15*mm, topMargin=15*mm, bottomMargin=14*mm,
                         title=f"과탐실 AI 탐구 플랫폼 {audience} 빠른 안내서", author="상당고등학교 과학과")
        self.audience = audience
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main")
        self.addPageTemplates(PageTemplate(id="guide", frames=frame, onPage=self.draw_page))

    def draw_page(self, canvas, doc):
        canvas.saveState()
        canvas.setFont("Malgun-Bold", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(15*mm, A4[1] - 8.5*mm, f"과탐실 AI 탐구 플랫폼  |  {self.audience} 빠른 안내")
        canvas.setFont("Malgun", 7.5)
        canvas.drawRightString(A4[0] - 15*mm, 7.5*mm, f"{doc.page}쪽")
        canvas.restoreState()


def p(text, style="body"):
    return Paragraph(text, S[style])


def title_block(audience, subtitle):
    data = [
        p("2026학년도 통합과학 팀 탐구", "kicker"),
        p(f"{audience} 빠른 안내서", "title"),
        p(subtitle, "subtitle"),
    ]
    url_box = Table([[p(f"<b>접속 주소</b>　<a href='{URL}' color='#146B55'><u>{URL}</u></a><br/><font color='#5F7069'>태블릿·노트북의 Chrome 또는 기본 브라우저에서 접속하세요.</font>", "url")]], colWidths=[180*mm])
    url_box.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), GREEN_SOFT), ("BOX", (0,0), (-1,-1), 0.7, colors.HexColor("#B9D9CB")),
        ("LEFTPADDING", (0,0), (-1,-1), 8), ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,-1), 6), ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]))
    data += [url_box, Spacer(1, 4)]
    return data


def bullet(text):
    return Paragraph(text, S["bullet"], bulletText="•")


def step(number, title, intro=""):
    suffix = f"　<font name='Malgun' color='#5F7069' size='8'>{intro}</font>" if intro else ""
    return p(f"{number}. {title}{suffix}", "step")


def note(title, body, fill=GOLD_SOFT, border=colors.HexColor("#E6CE72")):
    table = Table([[p(title, "note_title")], [p(body, "note")]], colWidths=[180*mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), fill), ("BOX", (0,0), (-1,-1), 0.6, border),
        ("LEFTPADDING", (0,0), (-1,-1), 8), ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,0), 5), ("BOTTOMPADDING", (0,0), (-1,0), 1),
        ("TOPPADDING", (0,1), (-1,1), 1), ("BOTTOMPADDING", (0,1), (-1,1), 6),
    ]))
    return table


def status_table(rows):
    data = [[p("화면 상태", "table_header"), p("뜻과 다음 행동", "table_header")]]
    data += [[p(label, "table_header"), p(detail, "table")] for label, detail in rows]
    table = Table(data, colWidths=[39*mm, 141*mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), BLUE_SOFT), ("GRID", (0,0), (-1,-1), 0.45, LINE),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING", (0,0), (-1,-1), 6), ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("TOPPADDING", (0,0), (-1,-1), 4), ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    return table


def teacher_story():
    story = title_block("교사용", "팀 편성 → 학생 시작 → 탐구 계획서 검토를 수업 전에 빠르게 확인합니다.")
    story += [p("수업 전 5분 점검", "h1")]
    story += [bullet(x) for x in [
        "교사 아이디로 로그인하고 대시보드가 열리는지 확인합니다.",
        "학생 로그인 카드를 준비하고, 태블릿이 학교 WiFi에 연결되는지 확인합니다.",
        "학급별 팀과 팀장이 맞는지 확인한 뒤 학생에게 접속 주소를 안내합니다.",
    ]]
    story += [step(1, "교사 로그인", "처음 받은 임시 비밀번호는 반드시 변경합니다.")]
    story += [bullet(x) for x in [
        "로그인 화면에서 교사 아이디와 비밀번호를 입력합니다.",
        "최초 로그인이라면 8자 이상, 글자와 숫자가 포함된 새 비밀번호로 바꿉니다.",
        "교사 계정은 4명 모두 1~9반을 함께 관리할 수 있습니다.",
    ]]
    story += [step(2, "팀 편성 및 팀장 지정")]
    story += [bullet(x) for x in [
        "교사 대시보드 → ‘팀 편성’에서 학급을 선택합니다.",
        "필요하면 ‘+ 팀 추가’를 누르고, 학생 행의 ‘현재 팀’ 목록에서 팀을 배정합니다.",
        "팀원 한 명을 ‘팀장’으로 지정합니다. 기본은 4인 1팀이며 인원 변동도 가능합니다.",
        "학생 이동·제거 기록은 삭제되지 않고 교사용 이력으로 남습니다.",
    ]]
    story += [Spacer(1, 2), note("주의", "운영 화면에서 시험용 팀을 만들거나 실제 학생 자료를 삭제하지 마세요. 팀을 잘못 배정했다면 해당 학생의 ‘현재 팀’을 올바른 팀으로 다시 선택합니다."), PageBreak()]
    story += [p("계획서 진행 확인과 승인", "h1"), step(3, "학생 진행 상황 확인")]
    story += [bullet(x) for x in [
        "대시보드의 ‘학급별 탐구 진척’에서 학급·팀, 탐구 주제, 계획서 상태를 확인합니다.",
        "팀 행의 ‘팀 확인’을 누르면 AI 대화, 계획서, 준비물 신청을 함께 볼 수 있습니다.",
    ]]
    story += [status_table([
        ("작성 중", "학생 팀이 계획서를 작성하고 있습니다."),
        ("승인 대기", "학생이 제출했습니다. 내용을 검토해 주세요."),
        ("수정 요청", "교사 피드백에 따라 학생 팀이 수정합니다."),
        ("재승인 필요", "승인 뒤 학생이 내용을 바꾸어 다시 검토해야 합니다."),
        ("승인됨", "계획이 확정되어 학생 개인 실험 일지가 열립니다."),
    ]), step(4, "계획서 검토")]
    story += [bullet(x) for x in [
        "팀 상세의 ‘탐구 계획서’에서 주제, 동기·목적, 이론적 배경과 출처, 방법·변인, 일정, 기대효과, 참고문헌을 확인합니다.",
        "바로 진행해도 되면 ‘계획서 승인’을, 보완이 필요하면 구체적인 피드백을 적고 ‘수정 요청’을 누릅니다.",
        "승인 뒤 상태를 바꿀 때는 ‘승인 상태 변경’을 누르고 화면에 표시된 ‘반 + 팀명’을 정확히 입력해야 합니다.",
    ]]
    story += [step(5, "수업 중 자주 생기는 문제")]
    story += [bullet(x) for x in [
        "학생 비밀번호 분실: 팀 편성 표의 ‘비밀번호 초기화’로 새 임시 비밀번호를 발급합니다.",
        "학생이 팀 화면을 못 봄: 현재 팀 배정과 계정 상태를 먼저 확인합니다.",
        "AI 답변 생성 중 입력이 안 됨: 정상적인 순차 처리입니다. 답변이 끝날 때까지 기다립니다.",
        "저장·전송 오류: 학생이 작성 내용을 지우지 않게 하고, 연결 복구 후 다시 시도합니다.",
    ]]
    story += [note("개인정보 원칙", "학생 이름·학번은 필요한 교사 화면과 DB에서만 사용합니다. AI에는 팀원 가명만 전달됩니다. 개인 일지는 작성자와 교사만 볼 수 있고, 연락처·이메일은 계획서에서 수집하지 않습니다.", GREEN_SOFT, colors.HexColor("#B9D9CB"))]
    return story


def student_story():
    story = title_block("학생용", "로그인 → 팀 주제 찾기 → 공동 계획서 작성과 제출 순서로 진행합니다.")
    story += [step(1, "첫 로그인과 비밀번호 변경")]
    story += [bullet(x) for x in [
        "선생님에게 받은 로그인 카드의 5자리 학번과 임시 비밀번호를 입력합니다.",
        "처음 로그인하면 새 비밀번호를 만듭니다: 8자 이상, 글자와 숫자를 함께 사용합니다.",
        "비밀번호는 친구와 공유하지 않습니다. 잊어버리면 선생님에게 초기화를 요청합니다.",
    ]]
    story += [step(2, "내 팀 확인")]
    story += [bullet(x) for x in [
        "로그인 후 화면 위쪽에서 반·팀명·팀원과 팀장을 확인합니다.",
        "팀이 다르거나 ‘아직 팀이 배정되지 않았습니다’가 나오면 선생님께 바로 알립니다.",
    ]]
    story += [step(3, "AI와 탐구 방향 찾기")]
    story += [bullet(x) for x in [
        "‘이론 탐구’ 탭에서 팀이 궁금해하는 현상이나 관심 분야를 팀의 말로 적습니다.",
        "‘AI와 방향 3개 찾기’를 누르고, 제안된 연구 질문·변인·안전 내용을 팀원과 비교합니다.",
        "팀이 합의한 카드에서 ‘이 방향 선택’을 누른 뒤 AI와 질문을 이어 갑니다.",
        "한 번에 한 질문만 처리됩니다. AI 답변이 생성되는 동안에는 새 입력이 잠시 잠깁니다.",
    ]]
    story += [note("AI 사용 원칙", "AI는 완성된 계획서를 대신 써 주는 사람이 아닙니다. 우리 팀의 생각을 먼저 적고, 모르는 개념·변인·오차·안전·출처를 질문하여 계획을 더 구체적으로 만드세요.", GREEN_SOFT, colors.HexColor("#B9D9CB")), PageBreak()]
    story += [p("팀 탐구 계획서 작성", "h1"), step(4, "항목별 공동 작성")]
    story += [bullet(x) for x in [
        "‘탐구 계획’ 탭을 열고 팀원이 역할을 나누어 항목별로 작성합니다.",
        "항목을 편집한 뒤 다른 곳을 누르면 저장됩니다. 같은 항목을 다른 팀원이 편집 중이면 작성자 표시와 잠금이 나타납니다.",
        "팀명·팀원·지도교사 정보는 자동으로 연결됩니다. 연락처와 이메일은 입력하지 않습니다.",
    ]]
    story += [step(5, "계획서에 꼭 들어갈 내용")]
    story += [bullet(x) for x in [
        "왜 탐구하는지: 연구 동기와 목적",
        "무엇을 알고 시작하는지: 이론적 배경·선행 연구·실제 출처",
        "어떻게 확인할지: 측정할 변인, 바꿀 조건, 같게 유지할 조건, 자료 수집 방법",
        "언제 무엇을 할지: 일정·장소·탐구 내용·준비물",
        "예상 결과·기대효과와 참고문헌",
    ]]
    story += [step(6, "제출과 교사 피드백"), bullet("팀원과 모든 항목을 확인한 뒤 ‘선생님께 제출’을 누릅니다."), status_table([
        ("선생님 확인 중", "제출이 완료되었습니다. 검토 결과를 기다립니다."),
        ("수정 요청", "교사 피드백을 읽고 해당 항목을 보완한 뒤 다시 제출합니다."),
        ("승인 완료", "계획이 승인되었습니다. 이후 실험 일지 작성이 열립니다."),
        ("재승인 필요", "승인 뒤 계획을 수정했습니다. 반드시 다시 제출합니다."),
    ]), step(7, "제출 전 마지막 확인")]
    story += [bullet(x) for x in [
        "연구 질문이 측정하거나 비교할 수 있을 만큼 구체적인가?",
        "실제 확인한 출처만 적었고, 존재하지 않는 논문·사이트를 만들지 않았는가?",
        "위험한 화학물질·불꽃·고전압·미생물·인체 적용이 있다면 교사 확인을 받았는가?",
        "실명·학번·연락처 같은 개인정보를 AI 대화에 직접 입력하지 않았는가?",
    ]]
    story += [note("연결이 불안할 때", "오류가 보여도 작성 내용을 먼저 지우지 마세요. WiFi를 확인하고 잠시 뒤 다시 저장하거나 제출합니다. 반복해서 버튼을 누르기보다 화면의 저장 상태와 오류 문구를 선생님께 보여 주세요.")]
    return story


def build(path, audience, story):
    doc = GuideDoc(str(path), audience)
    doc.build(story)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    build(OUT / "2026-과탐실-교사용-빠른-안내서.pdf", "교사용", teacher_story())
    build(OUT / "2026-과탐실-학생용-빠른-안내서.pdf", "학생용", student_story())
    print(OUT)


if __name__ == "__main__":
    main()
