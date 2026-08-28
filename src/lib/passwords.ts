import { randomInt } from "node:crypto";

const WORDS = [
  "별빛",
  "새싹",
  "바다",
  "구름",
  "나무",
  "여울",
  "노을",
  "하늘",
  "우주",
  "달빛",
];

export function generateTemporaryPassword() {
  const word = WORDS[randomInt(WORDS.length)];
  const number = randomInt(10_000, 100_000);
  const symbol = ["!", "#", "?"][randomInt(3)];
  return `${word}${number}${symbol}`;
}

export function isAcceptablePassword(password: string) {
  return password.length >= 8 && /[A-Za-z가-힣]/.test(password) && /\d/.test(password);
}
