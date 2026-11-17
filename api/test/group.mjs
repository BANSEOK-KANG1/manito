// 단톡방 시험: "/명령"으로 부른 말과, 단톡방 필드가 있는 요청에서 비밀이 새지 않는지 본다.
// 사용: KEY=비밀키 node api/test/group.mjs <서버주소>
const BASE = process.argv[2] || "http://localhost:8799";
let fails = 0;
async function say(user, utterance, chat) {
  const userRequest = { utterance, user: { id: "g-" + user, properties: {} } };
  if (chat) userRequest.chat = chat;
  const r = await fetch(BASE + "/kakao/skill", { method: "POST", headers: { "x-manito-key": process.env.KEY || "" }, body: JSON.stringify({ userRequest }) });
  const j = await r.json();
  return { texts: j.template.outputs.map(o => o.simpleText?.text || JSON.stringify(o)).join("\n---\n"), qrs: (j.template.quickReplies || []).map(q => q.messageText) };
}
const ok = (res, re, label, not) => {
  const good = re.test(res.texts) && !(not && not.test(res.texts));
  if (!good) { fails++; console.log(`✗ ${label}\n${res.texts}\n[${res.qrs.join(" | ")}]`); } else console.log(`✓ ${label}`);
  return res;
};
const A = "a" + Date.now(), B = "b" + Date.now();
const GROUP = { id: "room-" + Date.now(), type: "GroupChat" };

// 1:1에서 방 만들고 참가
await say(A, "방 만들기"); await say(A, "반석, 민지, 서준");
const code = (await say(A, "7일 뒤")).texts.match(/코드: (\w+)/)[1];
await say(A, "이름 반석"); const t = (await say(A, "네 맞아요")).texts.match(/🎁 (\S+) 🎁/)[1];
await say(B, code); await say(B, "이름 민지"); await say(B, "네 맞아요");

// 1:1 놀이 기능
ok(await say(A, "주사위"), /🎲 .*주사위\(1~6\): [1-6]/, "1:1 주사위");
ok(await say(A, "기능"), /놀이[\s\S]*마니또/, "1:1 기능 목록");
// 쪽지 쓰는 중에는 '골라줘'도 쪽지 내용으로
await say(A, "쪽지 쓰기");
ok(await say(A, "골라줘 너의 최애 과자"), /쪽지를 보냈어요/, "쪽지 입력 중엔 다른 기능이 가로채지 않음");

// 단톡방: "/" 로 부름 (필드 없음)
const SECRET = new RegExp(`챙길 사람|${t} 🎁|미션 완료|쪽지함`);
ok(await say(A, "/"), /단톡방에서 이렇게/, "/ 만 보내면 단톡 도움말");
let r = ok(await say(A, "/홈"), /단톡방에서 이렇게|무슨 말인지/, "단톡에서 /홈 → 비밀 안 보임", SECRET);
ok(await say(A, "/미션"), /단톡방|무슨 말인지/, "단톡에서 /미션 → 비밀 안 보임", SECRET);
ok(await say(A, "/쪽지"), /단톡방|무슨 말인지/, "단톡에서 /쪽지 → 비밀 안 보임", SECRET);
r = ok(await say(A, "/마니또"), /진행 현황[\s\S]*참가: 2\/3명[\s\S]*아직 안 들어온 사람: 서준/, "단톡 /마니또 현황", SECRET);
if (!r.qrs.every(q => q.startsWith("/"))) { fails++; console.log("✗ 단톡 버튼은 / 로 시작해야 함", r.qrs); }
ok(await say(A, "@마니또봇 주사위 100"), /주사위\(1~100\)/, "@봇 호출 주사위");
ok(await say(A, "/골라줘 짜장 짬뽕"), /👉 (짜장|짬뽕)!/, "단톡 골라줘");
ok(await say(A, "/순서 a b c"), /1\. [abc]\n2\. [abc]\n3\. [abc]/, "단톡 순서");
ok(await say(A, "/마니또 결과"), /아직 공개 전/, "공개 전 결과 막힘");

// 단톡방 필드가 오는 경우 ("/" 없이도 단톡으로 처리 + 연결)
ok(await say(B, "홈", GROUP), /단톡방|무슨 말인지/, "단톡 필드 + 홈 → 비밀 안 보임", SECRET);
ok(await say(B, "마니또 연결 " + code, GROUP), /연결했어요/, "단톡 연결");
ok(await say("stranger", "마니또", GROUP), /참가: 2\/3명/, "연결된 단톡은 누가 불러도 현황");
ok(await say(B, "홈", { id: "x", type: "DirectChat" }), /챙길 사람/, "1:1 필드면 평소처럼");

console.log(fails ? `\n실패 ${fails}개` : "\n모두 통과");
process.exit(fails ? 1 : 0);
