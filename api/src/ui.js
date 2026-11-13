// 카카오 i 오픈빌더 응답(스킬 응답 2.0) 만들기 — 모든 기능이 같이 쓴다.
// outputs: 문자열(말풍선) 또는 카카오 응답 객체, 최대 3개
// qrs: 바로가기 답장 버튼 — "글자" 또는 ["버튼 이름", "보낼 말"], 최대 10개
// group: 단톡방이면 버튼이 보내는 말 앞에 "/"를 붙인다 (단톡방에서는 "/명령"으로 불러야 봇이 듣는다)
export function reply(outputs, qrs = [], group = false) {
  const o = [].concat(outputs).filter(Boolean).slice(0, 3).map(x => typeof x === "string" ? { simpleText: { text: x.slice(0, 1000) } } : x);
  const q = qrs.filter(Boolean).slice(0, 10).map(x => {
    const [label, msg] = typeof x === "string" ? [x, x] : x;
    return { label: [...label].slice(0, 14).join(""), action: "message", messageText: group ? "/" + msg : msg };
  });
  const template = { outputs: o.length ? o : [{ simpleText: { text: "..." } }] };
  if (q.length) template.quickReplies = q;
  return new Response(JSON.stringify({ version: "2.0", template }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export function randInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
export function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
