export type MaterialLinkResult =
  | { ok: true; link: string; converted: boolean }
  | { ok: false; message: string };

const TRAILING_SHARE_PUNCTUATION = /[.,;!?\]\[)}>{]+$/;

function extractFirstHttpUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0].replace(TRAILING_SHARE_PUNCTUATION, "") ?? "";
}

function searchParamIgnoreCase(url: URL, name: string) {
  const expected = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === expected) return value;
  }
  return "";
}

function withPreservedSearch(base: string, source: URL) {
  const target = new URL(base);
  source.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target.toString();
}

export function normalizeMaterialLink(value: string): MaterialLinkResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, link: "", converted: false };

  const extracted = extractFirstHttpUrl(trimmed);
  if (!extracted) {
    return { ok: false, message: "상품 공유 문구나 http:// 또는 https://로 시작하는 링크를 입력해 주세요." };
  }

  let url: URL;
  try {
    url = new URL(extracted);
  } catch {
    return { ok: false, message: "상품 링크 형식을 확인해 주세요." };
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    return { ok: false, message: "안전한 http 또는 https 상품 링크만 입력할 수 있습니다." };
  }

  const host = url.hostname.toLowerCase();
  let normalized = url.toString();

  if (["m.gmarket.co.kr", "mg.gmarket.co.kr", "mitem.gmarket.co.kr"].includes(host)) {
    const goodsCode = searchParamIgnoreCase(url, "goodsCode");
    if (goodsCode) normalized = `https://item.gmarket.co.kr/Item?goodsCode=${encodeURIComponent(goodsCode)}`;
  } else if (host === "mitem.auction.co.kr") {
    const itemNo = searchParamIgnoreCase(url, "itemNo");
    if (itemNo) normalized = `https://itempage3.auction.co.kr/DetailView.aspx?itemno=${encodeURIComponent(itemNo)}`;
  } else if (host === "m.11st.co.kr") {
    const match = url.pathname.match(/^\/products\/m\/(\d+)\/?$/i);
    if (match) normalized = withPreservedSearch(`https://www.11st.co.kr/products/${match[1]}`, url);
  } else if (host === "m.smartstore.naver.com") {
    url.hostname = "smartstore.naver.com";
    normalized = url.toString();
  } else if (host === "m.coupang.com") {
    const match = url.pathname.match(/^\/vm\/products\/(\d+)\/?$/i);
    if (match) normalized = withPreservedSearch(`https://www.coupang.com/vp/products/${match[1]}`, url);
  }

  const normalizedHost = new URL(normalized).hostname.toLowerCase();
  const stillMobileOnly = normalizedHost.startsWith("m.")
    || normalizedHost.startsWith("mobile.")
    || normalizedHost.startsWith("mitem.");
  if (stillMobileOnly) {
    return {
      ok: false,
      message: "이 주소는 모바일 전용 링크입니다. 쇼핑몰의 PC 웹에서 상품을 열어 주소를 다시 복사해 주세요.",
    };
  }

  return { ok: true, link: normalized, converted: normalized !== extracted || extracted !== trimmed };
}
