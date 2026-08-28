import { describe, expect, it } from "vitest";
import { normalizeMaterialLink } from "@/lib/material-links";
import { materialTotal } from "@/lib/materials";

describe("materialTotal", () => {
  it("adds per-item quantity and per-row shipping exactly once", () => {
    expect(materialTotal([
      { name: "0.1 M HCl", specification: "500 mL", unitPrice: 12_000, quantity: 2, shipping: 3_000, link: "" },
      { name: "거름종이", specification: "100매", unitPrice: 4_500, quantity: 1, shipping: 0, link: "" },
    ])).toBe(31_500);
  });
});

describe("normalizeMaterialLink", () => {
  it("extracts a URL from a mobile share message", () => {
    expect(normalizeMaterialLink("추천 상품입니다 https://example.com/items/42?color=red 확인해 보세요")).toEqual({
      ok: true,
      link: "https://example.com/items/42?color=red",
      converted: true,
    });
  });

  it.each([
    ["G마켓", "https://m.gmarket.co.kr/Item?goodscode=4799448999", "https://item.gmarket.co.kr/Item?goodsCode=4799448999"],
    ["옥션", "https://mitem.auction.co.kr/ViewOriginal?itemno=B541596679", "https://itempage3.auction.co.kr/DetailView.aspx?itemno=B541596679"],
    ["11번가", "https://m.11st.co.kr/products/m/3091715742?trTypeCd=22", "https://www.11st.co.kr/products/3091715742?trTypeCd=22"],
    ["스마트스토어", "https://m.smartstore.naver.com/store/products/123", "https://smartstore.naver.com/store/products/123"],
    ["쿠팡", "https://m.coupang.com/vm/products/7384363877?itemId=1", "https://www.coupang.com/vp/products/7384363877?itemId=1"],
  ])("converts %s mobile product links to desktop links", (_mall, mobile, desktop) => {
    expect(normalizeMaterialLink(mobile)).toEqual({ ok: true, link: desktop, converted: true });
  });

  it("rejects an unsupported mobile-only link", () => {
    expect(normalizeMaterialLink("https://m.example.com/product/1")).toEqual({
      ok: false,
      message: "이 주소는 모바일 전용 링크입니다. 쇼핑몰의 PC 웹에서 상품을 열어 주소를 다시 복사해 주세요.",
    });
  });

  it("does not accept non-web schemes hidden in share text", () => {
    expect(normalizeMaterialLink("shoppingapp://product/1")).toEqual({
      ok: false,
      message: "상품 공유 문구나 http:// 또는 https://로 시작하는 링크를 입력해 주세요.",
    });
  });
});
