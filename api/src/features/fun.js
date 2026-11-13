// 🎲 놀이 — 단톡방·1:1 어디서나 쓰는 가벼운 기능들
// 새 기능을 만들 때 이 파일을 본보기로 쓰면 된다:
//   name, commands(도움말에 보일 [명령, 설명]), match(c) → 처리 함수 또는 null
import { reply, randInt, shuffle } from "../ui.js";

export const name = "🎲 놀이";
export const commands = [
  ["주사위", "1~6 주사위 (주사위 100 → 1~100)"],
  ["골라줘 짜장 짬뽕 볶음밥", "하나 골라주기"],
  ["순서 반석 민지 서준", "순서 랜덤으로 정하기"],
  ["점심 추천", "메뉴 하나 추천"],
];

const LUNCH = ["김치찌개", "제육볶음", "돈까스", "짜장면", "짬뽕", "국밥", "쌀국수", "초밥", "떡볶이", "햄버거", "비빔밥", "칼국수", "마라탕", "샐러드", "부대찌개", "냉면", "카레", "김밥", "치킨", "파스타"];
const items = s => s.split(/[\s,]+|\s*vs\s*/i).map(x => x.trim()).filter(Boolean);

export function match(c) {
  const u = c.utter;
  let m;
  if ((m = u.match(/^주사위\s*(\d{1,6})?$/))) return () => {
    const n = Math.max(2, Math.min(Number(m[1] || 6), 100000));
    return reply(`🎲 ${c.who ? c.who + "님의 " : ""}주사위(1~${n}): ${randInt(n) + 1}`, [["🎲 다시", m[0]]], c.group);
  };
  if ((m = u.match(/^(?:골라줘|골라|뭐먹지|뭐할까)\s+(.+)$/))) return () => {
    const xs = items(m[1]);
    if (xs.length < 2) return reply("두 개 이상 써주세요. 예) 골라줘 짜장 짬뽕", [], c.group);
    return reply(`🤔 ${xs.join(" · ")}\n\n👉 ${xs[randInt(xs.length)]}!`, [["🔄 다시 고르기", m[0]]], c.group);
  };
  if ((m = u.match(/^(?:순서|순서정하기|차례)\s+(.+)$/))) return () => {
    const xs = items(m[1]);
    if (xs.length < 2) return reply("두 명 이상 써주세요. 예) 순서 반석 민지 서준", [], c.group);
    return reply("🔀 순서\n" + shuffle(xs).map((x, i) => `${i + 1}. ${x}`).join("\n"), [["🔄 다시", m[0]]], c.group);
  };
  if (/^(?:점심|저녁|메뉴)\s*(?:추천|뭐먹지)?$/.test(u)) return () =>
    reply(`🍚 오늘은... ${LUNCH[randInt(LUNCH.length)]} 어때요?`, [["🔄 다른 메뉴", u]], c.group);
  return null;
}
