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

const INITIAL_KEYS = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
const MEDIAL_KEYS = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
const FINAL_KEYS = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];

export function hangulToDubeolsik(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) return character;

    const syllableOffset = codePoint - 0xac00;
    const initialIndex = Math.floor(syllableOffset / 588);
    const medialIndex = Math.floor((syllableOffset % 588) / 28);
    const finalIndex = syllableOffset % 28;
    return `${INITIAL_KEYS[initialIndex]}${MEDIAL_KEYS[medialIndex]}${FINAL_KEYS[finalIndex]}`;
  }).join("");
}

export function generateTemporaryPassword() {
  const word = WORDS[randomInt(WORDS.length)];
  const number = randomInt(10_000, 100_000);
  const symbol = ["!", "#", "?"][randomInt(3)];
  return `${hangulToDubeolsik(word)}${number}${symbol}`;
}

export function isAcceptablePassword(password: string) {
  return password.length >= 8 && /[A-Za-z가-힣]/.test(password) && /\d/.test(password);
}
