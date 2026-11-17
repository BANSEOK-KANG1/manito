// 카톡 오픈빌더가 보내는 형식으로 가짜 사용자 3명이 처음부터 공개까지 진행해 본다.
// 사용: node api/test/play.mjs <서버주소>   (환경변수 KEY=비밀키, WAIT=초 → 공개까지 기다려 결과도 확인, IMG_URL=사진 주소)
const BASE = process.argv[2] || "http://localhost:8799";
const VERBOSE = process.env.V === "1";
let fails = 0;
async function say(user, utterance, extra = {}) {
  const r = await fetch(BASE + "/kakao/skill", {
    method: "POST", headers: { "Content-Type": "application/json", "x-manito-key": process.env.KEY || "" },
    body: JSON.stringify({ userRequest: { utterance, user: { id: "test-" + user, type: "botUserKey", properties: {} }, params: {}, ...extra }, action: { params: {} } }),
  });
  const j = await r.json();
  const texts = j.template.outputs.map(o => o.simpleText?.text || (o.carousel ? `[carousel ${o.carousel.items.length}] ` + JSON.stringify(o.carousel.items[0]) : JSON.stringify(o))).join("\n---\n");
  const qrs = (j.template.quickReplies || []).map(q => q.messageText);
  for (const q of j.template.quickReplies || []) if ([...q.label].length > 14) { console.log("!! label too long", q.label); fails++; }
  for (const o of j.template.outputs) if (o.simpleText && o.simpleText.text.length > 1000) { console.log("!! text too long"); fails++; }
  if (VERBOSE) console.log(`\n▶ ${user}: ${utterance}\n${texts}\n  [${qrs.join(" | ")}]`);
  return { texts, qrs, j };
}
const expect = (res, re, label) => { if (!re.test(res.texts)) { fails++; console.log(`✗ ${label}\n${res.texts}\n[${res.qrs.join(" | ")}]`); } else console.log(`✓ ${label}`); return res; };

const A = "a" + Date.now(), B = "b" + Date.now(), C = "c" + Date.now();
expect(await say(A, "안녕"), /마니또 챗봇/, "처음 인사");
expect(await say(A, "방 만들기"), /이름을 모두/, "방 만들기 시작");
expect(await say(A, "반석, 민지"), /2명이에요/, "인원 부족 거절");
expect(await say(A, "반석, 민지, 서준"), /공개는 언제/, "이름 받음");
expect(await say(A, "내일 모레쯤"), /공개는 언제/, "시간 못 알아들음");
let r = expect(await say(A, "2분 뒤"), /참가 코드: ([A-Z0-9]{6})/, "방 생성");
const code = r.texts.match(/참가 코드: ([A-Z0-9]{6})/)[1];
expect(await say(A, "이름 없는사람"), /명단에 없어요/, "없는 이름");
expect(await say(A, "이름 반석"), /맞나요/, "이름 확인");
r = expect(await say(A, "네 맞아요"), /챙겨줄 사람은/, "A 참가 + 대상 공개");
const tA = r.texts.match(/🎁 (\S+) 🎁/)[1];

expect(await say(B, code.toLowerCase()), /내 이름을 골라주세요/, "B 코드 입력(소문자)");
expect(await say(B, "이름 반석"), /이미 누군가/, "B가 A 이름 시도 → 막힘");
await say(B, "이름 민지");
expect(await say(B, "네 맞아요"), /챙겨줄 사람은/, "B 참가");
await say(C, "참가 " + code); await say(C, "서준");
expect(await say(C, "네 맞아요"), /챙겨줄 사람은/, "C 참가");
expect(await say(C, code), /다시 왔네요/, "C 재입장");

// 짝 알아내기
const who = { 반석: A, 민지: B, 서준: C };
const giverOfA = Object.entries(who).find(([n, u]) => u !== A && n !== tA); // A를 챙기는 사람(3명이면 A의 대상이 아닌 쪽)
const [gName, G] = giverOfA, T = who[tA];
console.log(`  짝: 반석→${tA}, ${gName}→반석`);

// 미션
r = expect(await say(A, "미션"), /카드 3장/, "카드 3장 깔기");
expect(await say(A, "미션"), /카드 3장/, "다시 열어도 같은 카드");
r = expect(await say(A, "2번 카드"), /뒤집었어요/, "카드 고르기");
expect(await say(A, "미션 완료"), /미션 완료! \+\d점/, "미션 완료");
// 1x1 JPEG
const jpg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
expect(await say(A, "아무말"), /증거 사진을 보내주세요/, "사진 대기 중 글자 → 안내");
const imgUrl = process.env.IMG_URL;
if (imgUrl) expect(await say(A, imgUrl), /사진을 저장/, "사진 저장");
else expect(await say(A, "사진 건너뛰기"), /다음 미션/, "사진 건너뛰기");
await say(A, "미션"); await say(A, "1번 카드");
expect(await say(A, "패스"), /패스했어요/, "패스");
await say(A, "미션"); await say(A, "3번 카드");
expect(await say(A, "패스"), /한 번만/, "두 번째 패스 막힘");

// 쪽지
expect(await say(A, "쪽지 쓰기"), /보낼 쪽지/, "쪽지 쓰기");
expect(await say(A, "힘내! 오늘도 화이팅"), /쪽지를 보냈어요/, "쪽지 전송");
expect(await say(T, "홈"), /새 쪽지 1개/, "받는 사람 홈에 새 쪽지 알림");
expect(await say(T, "쪽지"), /힘내! 오늘도 화이팅/, "쪽지함");
expect(await say(T, "홈"), /^(?![\s\S]*새 쪽지)/, "본 뒤 알림 사라짐");

// 질문 (T가 자기 마니또 = A에게)
await say(T, "질문하기");
expect(await say(T, "우리 같은 학교야?"), /질문을 보냈어요/, "질문 보내기");
r = expect(await say(A, "질문"), /우리 같은 학교야\?/, "A가 받은 질문 확인");
const lieBtn = r.qrs.find(q => q.includes("거짓 예"));
expect(await say(A, lieBtn), /거짓말 찬스/, "거짓말로 답");
expect(await say(T, "질문"), /우리 같은 학교야\? → "예"/, "T가 답 확인");

// 퀴즈 (A가 내고, A를 챙기는 G가 푼다)
await say(A, "퀴즈 내기");
expect(await say(A, "좋아하는 계절? / 겨울"), /형식이 달라요/, "퀴즈 형식 오류");
await say(A, "좋아하는 계절? / 겨울 / 여름 / 봄");
expect(await say(A, "MBTI는? / INFP / ESTJ / ENTP"), /여기까지만/, "2번 저장 + 여기까지 내기 안내");
expect(await say(A, "여기까지 내기"), /2문제를 냈어요/, "퀴즈 2개만 내기");
expect(await say(A, "퀴즈"), /0\/2 풀림/, "내 퀴즈 0/2");
r = expect(await say(G, "퀴즈"), /Q1\./, "G가 A 퀴즈 보기");
expect(await say(G, r.qrs.find(q => q.startsWith("퀴즈답"))), /⭕ 정답|❌ 아쉬워요/, "G 퀴즈 풀기");
expect(await say(A, "퀴즈 내기"), /바꿀 수 없어요/, "풀기 시작 후 수정 막힘");

// 힌트·맞히기
await say(G, "미션"); await say(G, "1번 카드"); await say(G, "미션 완료"); await say(G, "사진 건너뛰기");
r = expect(await say(A, "찬스"), /질문 찬스[\s\S]*힌트 찬스[\s\S]*거짓말 찬스: 썼어요[\s\S]*맞히기/, "찬스 모아보기");
r = expect(await say(A, "힌트"), /힌트 찬스/, "힌트 찬스");
expect(await say(A, "힌트 초성"), /점수가 모자라요|초성은/, "초성 힌트(점수 따라)");
expect(await say(A, "힌트 글자수"), /글자예요|점수가 모자라요/, "글자 수 힌트(점수 따라)");
expect(await say(A, "맞히기"), /누구일까요/, "맞히기 화면");
expect(await say(A, "찍기 " + gName), /찍었어요/, "정답 찍기");
expect(await say(A, "점수"), /지금 점수/, "점수");
expect(await say(A, "공지"), new RegExp(`참가: 3/3명[\\s\\S]*${code}`), "단톡 공지 문구");
expect(await say(A, "결과"), /아직 공개 전/, "공개 전 결과 막힘");

if (process.env.WAIT) {
  console.log("  공개 시간까지 기다리는 중...");
  await new Promise(res => setTimeout(res, Number(process.env.WAIT) * 1000));
  expect(await say(A, "홈"), new RegExp(`나를 챙겨준 마니또는\\.\\.\\. 🎁 ${gName}[\\s\\S]*정답 \\+3점`), "공개: 내 마니또 + 정답");
  expect(await say(T, "결과"), /거짓말이었어요/, "공개: 거짓말 밝혀짐");
  expect(await say(A, "결과 공유"), /최고의 마니또/, "결과 공유 문구");
  expect(await say(A, "앨범"), imgUrl ? /carousel 1/ : /사진이 없어요/, "앨범");
  expect(await say(A, "쪽지 쓰기"), /공개!/, "공개 후 기록 막힘(결과로)");
}
console.log(fails ? `\n실패 ${fails}개` : "\n모두 통과");
process.exit(fails ? 1 : 0);
