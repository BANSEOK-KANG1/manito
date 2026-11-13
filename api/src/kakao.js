// 카카오톡 채널 챗봇 (카카오 i 오픈빌더 스킬 서버)
// 오픈빌더에서 폴백 블록 하나만 이 스킬(POST /kakao/skill)로 연결하면, 사용자가 보내는 모든 말이 여기로 온다.
// 버튼은 전부 '바로가기 답장(quickReplies)'이고, 누르면 그 글자가 그대로 말로 들어온다.
// 사람 구분: 카카오가 주는 사용자 ID를 해시해서 쓴다 (비밀번호 없음).

const WD = "일월화수목금토";
const kd = t => new Date(t + 9 * 3600e3);
const pad = n => String(n).padStart(2, "0");
const fmt = t => { const d = kd(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const ago = (t, now) => { const m = Math.floor((now - t) / 60000); return m < 1 ? "방금" : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; };
function until(t, now) {
  const m = Math.ceil((t - now) / 60000);
  if (m <= 0) return "공개됨";
  if (m < 60) return `${m}분 남음`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 ${m % 60}분 남음`;
  const days = Math.round((Date.UTC(kd(t).getUTCFullYear(), kd(t).getUTCMonth(), kd(t).getUTCDate()) - Date.UTC(kd(now).getUTCFullYear(), kd(now).getUTCMonth(), kd(now).getUTCDate())) / 86400e3);
  return `D-${days}`;
}
const stars = n => "★".repeat(n);
const norm = s => String(s || "").replace(/[^\p{L}\p{N}]/gu, "");
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/* ---------- 응답 만들기 ---------- */
const MENU = [["🏠 홈", "홈"], ["🃏 미션", "미션"], ["💌 쪽지", "쪽지"], ["❓ 질문", "질문"], ["🧩 퀴즈", "퀴즈"], ["🔍 힌트", "힌트"], ["🎯 맞히기", "맞히기"], ["📊 점수", "점수"], ["📢 단톡 공지", "공지"]];
function reply(outputs, qrs = MENU) {
  const o = [].concat(outputs).filter(Boolean).slice(0, 3).map(x => typeof x === "string" ? { simpleText: { text: x.slice(0, 1000) } } : x);
  const q = qrs.filter(Boolean).slice(0, 10).map(x => { const [label, msg] = typeof x === "string" ? [x, x] : x; return { label: [...label].slice(0, 14).join(""), action: "message", messageText: msg }; });
  const template = { outputs: o.length ? o : [{ simpleText: { text: "..." } }] };
  if (q.length) template.quickReplies = q;
  return new Response(JSON.stringify({ version: "2.0", template }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
const withMenu = (first = []) => [...first, ...MENU.filter(m => !first.some(f => (typeof f === "string" ? f : f[1]) === m[1]))];

/* ---------- 진입점 ---------- */
export async function kakaoSkill(req, env, X) {
  if (env.KAKAO_KEY && req.headers.get("x-manito-key") !== env.KAKAO_KEY) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => null);
  const ur = body?.userRequest, uid = ur?.user?.id;
  if (!uid) return reply("요청을 읽지 못했어요.", []);
  const box = name => env.BOX.get(env.BOX.idFromName(name));
  const c = {
    env, X, ur, now: Date.now(), origin: new URL(req.url).origin,
    kid: await X.sha("kakao:" + uid),
    utter: String(ur.utterance ?? "").trim(),
    sget: async name => (await box(name).fetch("https://box/")).json(),
    sput: (name, v, ifEmpty) => box(name).fetch("https://box/", { method: "POST", body: JSON.stringify({ v, ifEmpty }) }),
  };
  c.ses = (await c.sget("u:" + c.kid)) || {};
  const before = JSON.stringify(c.ses);
  let res;
  try { res = await route(c); } catch (e) { res = reply("앗, 문제가 생겼어요. 잠시 뒤 다시 보내주세요.", withMenu()); }
  if (JSON.stringify(c.ses) !== before) await c.sput("u:" + c.kid, c.ses);
  res.headers.set("x-took-ms", String(Date.now() - c.now)); // 카톡은 5초 안에 답해야 해서 처리 시간을 남긴다
  return res;
}

async function call(c, kind, data = {}) {
  const id = c.ses.room;
  const r = await c.X.stub(c.env, id).fetch(`https://room/${id}/${kind}`, { method: "POST", headers: { "x-kakao": "1" }, body: JSON.stringify({ kid: c.kid, who: c.ses.who, ...data }) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { s: j } : { err: j.message || "문제가 생겼어요.", code: j.error };
}

/* ---------- 말 나누기 ---------- */
const CMD = {
  홈: home, 처음: home, 시작: home, 메뉴: home, 내마니또: home,
  도움말: help, 사용법: help,
  방만들기: startCreate, 방나가기: leave, 취소: cancel,
  참가: askCode, 참가코드: askCode,
  미션: mission, 카드뽑기: mission, 미션완료: missionDone, 패스: missionPass, 사진건너뛰기: skipPhoto,
  쪽지: notes, 쪽지쓰기: startNote,
  질문: asks, 질문하기: startAsk,
  퀴즈: quiz, 퀴즈내기: startQuiz,
  힌트: hints, 맞히기: guessMenu, 점수: points,
  공지: announce, 단톡공지: announce, 결과: result, 결과공유: shareResult, 앨범: album,
  네맞아요: confirmName, 아니에요: cancel,
};

async function route(c) {
  const u = c.utter, k = norm(u);
  let m;
  if (CMD[k]) { if (k !== "네맞아요") c.ses.mode = null; return CMD[k](c); }
  if ((m = u.match(/^([123])\s*번\s*카드$/))) return pickCard(c, Number(m[1]) - 1);
  if ((m = u.match(/^답변\s+(\d+)\s+(거짓\s+)?(예|아니오)$/))) return answerAsk(c, Number(m[1]), m[3], !!m[2]);
  if ((m = u.match(/^퀴즈답\s+(\d+)\s+(\d)$/))) return solveQuiz(c, Number(m[1]), Number(m[2]));
  if ((m = u.match(/^힌트\s*(글자수|지우기|초성)/))) return buyHint(c, { 글자수: "len", 지우기: "elim", 초성: "cho" }[m[1]]);
  if ((m = u.match(/^찍기\s+(.+)$/))) return guess(c, m[1].trim());
  if ((m = u.match(/^이름\s+(.+)$/))) return pickName(c, m[1].trim());
  if (c.ses.mode) return modeInput(c);
  if ((m = u.match(/^(?:참가\s*(?:코드)?\s*)?([A-Za-z0-9]{6})$/))) return join(c, m[1].toUpperCase());
  if (c.ses.room && c.ses.who == null) return pickName(c, u);
  return home(c);
}

/* ---------- 처음 / 도움말 ---------- */
function intro() {
  return reply("🎁 마니또 챗봇이에요!\n\n· 방장이라면: '방 만들기'를 눌러주세요.\n· 참가자라면: 단톡방에서 받은 참가 코드 6자리를 보내주세요.\n  예) K7M2QX", [["🎁 방 만들기", "방 만들기"], ["🔑 참가 코드 입력", "참가"], ["❔ 사용법", "도움말"]]);
}
function help(c) {
  return reply([
    "❔ 이렇게 놀아요\n\n🃏 미션: 카드 3장 중 하나를 고르면 미션이 나와요. ★ 개수만큼 점수를 받아요. (하루 3개, 패스 1번)\n💌 쪽지: 내가 챙기는 사람에게 이름 없이 쪽지를 보내요. (하루 3개)\n❓ 질문: 나를 챙겨주는 사람에게 예/아니오 질문을 해요. (하루 2개) 상대는 게임 중 딱 한 번 거짓말을 할 수 있어요.\n🧩 퀴즈: 나에 대한 퀴즈 3문제를 내요. 내가 챙기는 사람의 퀴즈를 맞히면 문제당 +2점이에요.\n🔍 힌트: 모은 점수로 '나를 챙겨주는 사람' 힌트를 사요.\n🎯 맞히기: 공개 전까지 내 마니또를 찍어두면, 맞혔을 때 +3점이에요.\n\n공개 시간이 되면 '결과'에서 전체 짝, 순위, 미션 사진 앨범을 볼 수 있어요.",
  ], c.ses?.who != null ? withMenu() : [["🎁 방 만들기", "방 만들기"], ["🔑 참가 코드 입력", "참가"]]);
}
function cancel(c) { c.ses.mode = null; return c.ses.room ? home(c) : intro(); }
function leave(c) { c.ses = {}; return reply("방에서 나왔어요. 진행 기록은 그대로 남아 있어서, 같은 참가 코드를 다시 보내면 이어서 할 수 있어요.", [["🔑 참가 코드 입력", "참가"], ["🎁 방 만들기", "방 만들기"]]); }
function askCode() { return reply("단톡방에서 받은 참가 코드 6자리를 보내주세요.\n예) K7M2QX", [["취소", "취소"]]); }

/* ---------- 방 만들기 ---------- */
function startCreate(c) {
  c.ses.mode = { m: "names" };
  return reply("🎁 새 마니또 방을 만들어요.\n\n참가자 이름을 모두 보내주세요. 나도 꼭 넣어주세요!\n쉼표나 줄바꿈으로 나눠요. (3~30명)\n\n예) 반석, 민지, 서준, 하은, 도윤", [["취소", "취소"]]);
}
function revealChoices(c) {
  return reply("공개는 언제 할까요?\n버튼을 누르거나 직접 써주세요.\n예) 11/21 21:00", [["3일 뒤 밤 9시", "3일 뒤"], ["5일 뒤 밤 9시", "5일 뒤"], ["7일 뒤 밤 9시", "7일 뒤"], ["10일 뒤 밤 9시", "10일 뒤"], ["취소", "취소"]]);
}
function parseReveal(u, now) {
  const t = kd(now), Y = t.getUTCFullYear(), M = t.getUTCMonth(), D = t.getUTCDate();
  const at = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h - 9, mi);
  let m;
  if ((m = u.match(/^(\d{1,3})\s*분\s*(?:뒤|후)$/))) return now + Number(m[1]) * 60000;
  if ((m = u.match(/(\d{1,2})\s*일\s*(?:뒤|후)/))) return at(Y, M, D + Number(m[1]), 21, 0);
  if ((m = u.match(/(\d{1,2})\s*[\/.월-]\s*(\d{1,2})\s*일?\s*(?:(오전|오후|밤|저녁)?\s*(\d{1,2})\s*(?:[:시]\s*(\d{1,2})?\s*분?)?)?/))) {
    let h = m[4] != null ? Number(m[4]) : 21; const mi = m[5] != null ? Number(m[5]) : 0;
    if (m[3] && m[3] !== "오전" && h < 12) h += 12;
    if (h > 23 || mi > 59) return null;
    let ts = at(Y, Number(m[1]) - 1, Number(m[2]), h, mi);
    if (ts < now - 86400e3) ts = at(Y + 1, Number(m[1]) - 1, Number(m[2]), h, mi);
    return ts;
  }
  return null;
}
async function createRoom(c, names, reveal) {
  const id = c.X.newId();
  let code;
  for (let t = 0; t < 6 && !code; t++) {
    let s = ""; for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.getRandomValues(new Uint32Array(1))[0] % CODE_CHARS.length];
    if ((await c.sput("c:" + s, id, true)).ok) code = s;
  }
  if (!code) return reply("잠시 뒤 다시 해주세요.", [["🎁 방 만들기", "방 만들기"]]);
  const r = await c.X.stub(c.env, id).fetch(`https://room/${id}/init`, { method: "POST", body: JSON.stringify({ names, reveal, code }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); c.ses.mode = { m: "names" }; return reply((j.message || "방을 만들지 못했어요.") + "\n이름을 다시 보내주세요.", [["취소", "취소"]]); }
  c.ses = { room: id, who: null, code, host: true };
  return reply([
    `✅ 방을 만들었어요!\n\n참가 코드: ${code}\n참가자: ${names.length}명\n공개: ${fmt(reveal)}\n\n짝은 서버가 몰래 뽑았어요. 방장도 다른 사람 짝은 볼 수 없어요.`,
    nameListText(names, names.map(() => false), "이제 내 이름을 골라주세요."),
  ], nameButtons(names, names.map(() => false)));
}

/* ---------- 참가 ---------- */
const nameButtons = (names, claimed) => {
  const free = names.filter((_, i) => !claimed[i]);
  return free.length <= 9 ? [...free.map(n => [n, "이름 " + n]), ["취소", "취소"]] : [["취소", "취소"]];
};
function nameListText(names, claimed, head) {
  const free = names.filter((_, i) => !claimed[i]);
  return `${head}\n\n` + names.map((n, i) => `${claimed[i] ? "✔️" : "·"} ${n}${claimed[i] ? " (참가함)" : ""}`).join("\n") + (free.length > 9 ? "\n\n'이름 홍길동'처럼 보내주세요." : "");
}
async function peek(c) {
  const r = await c.X.stub(c.env, c.ses.room).fetch(`https://room/${c.ses.room}/kpeek`, { method: "POST", headers: { "x-kakao": "1" }, body: JSON.stringify({ kid: c.kid }) });
  return r.ok ? r.json() : null;
}
async function join(c, code) {
  const id = await c.sget("c:" + code);
  if (!id) return reply(`'${code}' 참가 코드를 찾지 못했어요. 단톡방의 코드를 다시 확인해 주세요.`, c.ses.room ? withMenu() : [["🔑 다시 입력", "참가"], ["🎁 방 만들기", "방 만들기"]]);
  c.ses = { room: id, who: null, code };
  const v = await peek(c);
  if (!v) { c.ses = {}; return reply("방이 없어졌거나 기간이 끝났어요.", [["🎁 방 만들기", "방 만들기"]]); }
  if (v.mine >= 0) { c.ses.who = v.mine; return home(c, `다시 왔네요, ${v.names[v.mine]}님!`); }
  if (v.claimed.every(Boolean)) { c.ses = {}; return reply("이 방은 모든 자리가 찼어요. 방장에게 물어봐 주세요.", []); }
  return reply(nameListText(v.names, v.claimed, `🎁 ${v.title}\n공개: ${fmt(v.reveal)}\n\n내 이름을 골라주세요.`), nameButtons(v.names, v.claimed));
}
async function pickName(c, name) {
  if (!c.ses.room) return intro();
  if (c.ses.who != null) return home(c);
  const v = await peek(c);
  if (!v) return intro();
  const i = v.names.indexOf(name);
  if (i < 0) return reply(nameListText(v.names, v.claimed, `'${name}'은(는) 명단에 없어요. 다시 골라주세요.`), nameButtons(v.names, v.claimed));
  if (v.claimed[i]) return reply(`'${name}'은(는) 이미 누군가 골랐어요. 본인 이름이 맞다면 단톡방에 알려주세요.`, nameButtons(v.names, v.claimed));
  c.ses.mode = { m: "confirm", who: i };
  return reply(`'${name}'님 맞나요?\n한 번 고르면 바꿀 수 없어요.`, [["네, 맞아요", "네 맞아요"], ["아니에요", "아니에요"]]);
}
async function confirmName(c) {
  const md = c.ses.mode; c.ses.mode = null;
  if (!c.ses.room || md?.m !== "confirm") return c.ses.room ? home(c) : intro();
  const r = await c.X.stub(c.env, c.ses.room).fetch(`https://room/${c.ses.room}/kclaim`, { method: "POST", headers: { "x-kakao": "1" }, body: JSON.stringify({ kid: c.kid, who: md.who }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return reply(j.message || "이름을 고르지 못했어요.", [["🔑 참가 코드 입력", "참가"]]);
  c.ses.who = md.who;
  const o = await call(c, "open");
  if (o.err) return reply(o.err, withMenu());
  const s = o.s;
  return reply([
    `🤫 쉿! ${s.me}님이 몰래 챙겨줄 사람은...\n\n🎁 ${s.target} 🎁\n\n들키지 않게 잘 챙겨주세요. 공개는 ${fmt(s.reveal)}이에요.`,
    "먼저 '🃏 미션'에서 카드를 뽑아보세요!\n'🧩 퀴즈'에서 나에 대한 퀴즈를 내두면, 나를 챙기는 사람이 풀 수 있어요.",
  ], withMenu([["🃏 미션", "미션"], ["🧩 퀴즈", "퀴즈"]]));
}

/* ---------- 입력을 기다리는 중 ---------- */
async function modeInput(c) {
  const md = c.ses.mode, u = c.utter;
  switch (md.m) {
    case "names": {
      const names = u.split(/[,\n、/·]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
      if (names.length < 3 || names.length > 30) return reply(`${names.length}명이에요. 3명에서 30명 사이로 보내주세요.\n쉼표로 나눠요. 예) 반석, 민지, 서준`, [["취소", "취소"]]);
      if (names.some(n => n.length > 20)) return reply("이름은 20자까지 쓸 수 있어요. 다시 보내주세요.", [["취소", "취소"]]);
      if (new Set(names).size !== names.length) return reply("같은 이름이 있어요. 성이나 별명을 붙여서 다시 보내주세요.", [["취소", "취소"]]);
      c.ses.mode = { m: "reveal", names };
      return revealChoices(c);
    }
    case "reveal": {
      const ts = parseReveal(u, c.now);
      if (!ts) return revealChoices(c);
      const minM = Number(c.env.MIN_REVEAL_MIN ?? 10);
      if (ts < c.now + minM * 60000 - 5000) return reply(`공개 시간은 지금부터 ${minM}분 뒤 이후로 골라주세요.`, [["3일 뒤 밤 9시", "3일 뒤"], ["7일 뒤 밤 9시", "7일 뒤"], ["취소", "취소"]]);
      if (ts > c.now + 40 * 86400e3) return reply("공개 시간은 40일 안으로 골라주세요.", [["7일 뒤 밤 9시", "7일 뒤"], ["취소", "취소"]]);
      c.ses.mode = null;
      return createRoom(c, md.names, ts);
    }
    case "confirm": c.ses.mode = null; return pickName(c, u);
    case "note": {
      const r = await call(c, "note", { text: u });
      if (r.err) return reply(r.err, [["취소", "취소"]]);
      c.ses.mode = null;
      return reply(`💌 ${r.s.target}님에게 쪽지를 보냈어요. 이름은 안 보여요.\n오늘 더 보낼 수 있는 쪽지: ${r.s.left.notes}개`, withMenu([["✏️ 하나 더 쓰기", "쪽지 쓰기"]]));
    }
    case "ask": {
      const r = await call(c, "ask", { q: u });
      if (r.err) return reply(r.err, [["취소", "취소"]]);
      c.ses.mode = null;
      return reply(`❓ 질문을 보냈어요: "${r.s.myAsks.at(-1).q}"\n나를 챙겨주는 사람이 답하면 '❓ 질문'에서 볼 수 있어요.\n오늘 남은 질문: ${r.s.left.asks}개`, withMenu());
    }
    case "quiz": {
      const parts = u.split(/\s*[\/\n]\s*/).map(s => s.trim()).filter(Boolean);
      if (parts.length !== 4) return reply(`형식이 달라요. '질문 / 정답 / 오답 / 오답' 4칸을 / 로 나눠 보내주세요.\n예) 내가 좋아하는 계절은? / 겨울 / 여름 / 봄`, [["취소", "취소"]]);
      if (new Set(parts.slice(1)).size !== 3) return reply("정답과 오답이 같아요. 서로 다르게 써주세요.", [["취소", "취소"]]);
      const qs = [...md.qs, parts];
      if (qs.length < c.X.C.QUIZ_N) {
        c.ses.mode = { m: "quiz", qs };
        return reply(`✅ ${qs.length}번 문제 저장!\n이제 ${qs.length + 1}번 문제를 보내주세요.\n(질문 / 정답 / 오답 / 오답)`, [["취소", "취소"]]);
      }
      const r = await call(c, "quiz", { quiz: qs.map(([q, a, w1, w2]) => ({ q, a, w: [w1, w2] })) });
      c.ses.mode = null;
      if (r.err) return reply(r.err, withMenu());
      return reply("🧩 퀴즈 3문제를 냈어요! 나를 챙겨주는 사람이 풀면 몇 개 맞혔는지 알려드릴게요.\n보기 순서는 섞여서 나가요.", withMenu());
    }
    case "photo": {
      const url = findImage(c.ur);
      if (!url) return reply("📸 미션 증거 사진을 보내주세요. 공개 때 앨범에 나와요.\n사진이 없으면 '사진 건너뛰기'를 눌러주세요.", [["사진 건너뛰기", "사진 건너뛰기"], ...MENU.slice(0, 3)]);
      let data;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!r.ok || buf.length > c.X.C.IMG_MAX_K) throw new Error("big");
        let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        data = btoa(s);
      } catch (e) { return reply("사진을 가져오지 못했어요. 조금 작은 사진으로 다시 보내주세요.", [["사진 건너뛰기", "사진 건너뛰기"]]); }
      const r = await call(c, "photo", { k: md.k, data });
      if (r.err) return reply(r.err, [["사진 건너뛰기", "사진 건너뛰기"]]);
      c.ses.mode = null;
      return reply("📸 사진을 저장했어요! 공개 시간에 앨범에서 다 같이 봐요.", withMenu([["🃏 다음 미션", "미션"]]));
    }
  }
  c.ses.mode = null;
  return home(c);
}
function findImage(ur) {
  const urls = JSON.stringify(ur).match(/https?:\/\/[^"\s\\]+/g) || [];
  return urls.find(x => /kakao|kakaocdn|daumcdn/i.test(x)) || (/^https?:\/\//.test(ur.utterance || "") ? ur.utterance.trim() : null);
}

/* ---------- 홈 ---------- */
async function state(c) {
  if (!c.ses.room) return { res: intro() };
  if (c.ses.who == null) {
    const v = await peek(c);
    if (!v) { c.ses = {}; return { res: intro() }; }
    if (v.mine >= 0) c.ses.who = v.mine;
    else return { res: reply(nameListText(v.names, v.claimed, "먼저 내 이름을 골라주세요."), nameButtons(v.names, v.claimed)) };
  }
  const o = await call(c, "open");
  if (o.err) {
    if (o.code === "no_room") { c.ses = {}; return { res: reply("방이 없어졌거나 기간이 끝났어요.", [["🎁 방 만들기", "방 만들기"]]) }; }
    return { res: reply(o.err, withMenu()) };
  }
  return { s: o.s };
}
function news(c, s) {
  const seen = c.ses.seen || {}, out = [];
  const nNotes = s.inbox.length - (seen.notes || 0);
  if (nNotes > 0) out.push(`💌 새 쪽지 ${nNotes}개`);
  const toAnswer = s.tAsks.filter(a => !a.ans).length;
  if (toAnswer) out.push(`❓ 답해줄 질문 ${toAnswer}개`);
  const nAns = s.myAsks.filter(a => a.ans).length - (seen.ans || 0);
  if (nAns > 0) out.push(`🗨️ 내 질문에 새 답 ${nAns}개`);
  if (s.tQuiz && s.tQuiz.some(q => q.mine == null)) out.push(`🧩 ${s.target}님 퀴즈 풀 수 있음`);
  if (!s.myQuiz) out.push("🧩 내 퀴즈를 아직 안 냈어요");
  return out;
}
async function home(c, hello) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const nw = news(c, s);
  const t = [
    hello ? hello + "\n" : "",
    `🎁 ${s.title}`,
    `공개: ${fmt(s.reveal)} · ${until(s.reveal, c.now)}`,
    `\n🤫 내가 챙길 사람: ${s.target}`,
    `⭐ 쓸 수 있는 점수: ${s.points.balance}점`,
    `📅 오늘 남은 것: 미션 ${s.left.done} · 쪽지 ${s.left.notes} · 질문 ${s.left.asks}`,
    s.card ? `\n🃏 진행 중인 미션: ${s.card.title} (${stars(s.card.pts)})` : "",
    nw.length ? "\n🔔 " + nw.join("\n🔔 ") : "",
  ].filter(x => x !== "").join("\n");
  const first = [];
  if (s.inbox.length - (c.ses.seen?.notes || 0) > 0) first.push(["💌 새 쪽지 보기", "쪽지"]);
  if (s.tAsks.some(a => !a.ans) || s.myAsks.filter(a => a.ans).length > (c.ses.seen?.ans || 0)) first.push(["❓ 질문 보기", "질문"]);
  return reply(t, withMenu(first));
}

/* ---------- 미션 ---------- */
async function mission(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const done = `\n\n지금까지 완료: ${s.done.length}개 (${s.points.mission}점)`;
  if (s.card) return showCard(s, "🃏 진행 중인 미션이에요." , done);
  if (s.left.done <= 0) return reply(`오늘 미션 3개를 다 했어요! 내일 또 뽑아요.${done}`, withMenu());
  const r = await call(c, "deal");
  if (r.err) return reply(r.err, withMenu());
  const d = r.s.deal;
  return reply(`🃏 카드 3장을 깔았어요.\n${s.target}님을 위한 미션 카드예요. 어떤 미션인지는 고른 뒤에 보여요!\n\n1번 카드 ${stars(d[0])}\n2번 카드 ${stars(d[1])}\n3번 카드 ${stars(d[2])}\n\n★ 개수 = 받는 점수예요.${done}`,
    [[`1번 ${stars(d[0])}`, "1번 카드"], [`2번 ${stars(d[1])}`, "2번 카드"], [`3번 ${stars(d[2])}`, "3번 카드"], ...MENU.slice(0, 1)]);
}
function showCard(s, head, tail = "") {
  return reply(`${head}\n\n【${s.card.title}】 ${stars(s.card.pts)}\n${s.card.desc}\n\n대상: ${s.target}\n하고 나서 '미션 완료'를 눌러주세요.${tail}`,
    [["✅ 미션 완료", "미션 완료"], s.left.pass > 0 ? ["🙅 패스 (하루 1번)", "패스"] : null, ...MENU.slice(0, 3)]);
}
async function pickCard(c, k) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.card) return showCard(s, "이미 고른 카드가 있어요.");
  const r = await call(c, "draw", { pick: k });
  if (r.err) return reply(r.err, [["🃏 미션", "미션"], ...MENU.slice(0, 1)]);
  return showCard(r.s, `🃏 ${k + 1}번 카드를 뒤집었어요!`);
}
async function missionDone(c) {
  if (!c.ses.room || c.ses.who == null) return home(c);
  const r = await call(c, "done");
  if (r.err) return reply(r.err, withMenu());
  const last = r.s.done.at(-1);
  c.ses.mode = { m: "photo", k: last.k };
  return reply(`🎉 미션 완료! +${last.pts}점\n쓸 수 있는 점수: ${r.s.points.balance}점\n\n📸 증거 사진이 있으면 지금 보내주세요. 공개 때 앨범에 나와요.`, [["사진 건너뛰기", "사진 건너뛰기"], ["🃏 다음 미션", "미션"], ...MENU.slice(0, 1)]);
}
async function missionPass(c) {
  if (!c.ses.room || c.ses.who == null) return home(c);
  const r = await call(c, "pass");
  if (r.err) return reply(r.err, withMenu());
  return reply("🙅 패스했어요. 새 카드를 뽑아보세요.", withMenu([["🃏 새 카드", "미션"]]));
}
function skipPhoto(c) { c.ses.mode = null; return reply("좋아요! 다음 미션도 화이팅.", withMenu([["🃏 다음 미션", "미션"]])); }

/* ---------- 쪽지 ---------- */
async function notes(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  c.ses.seen = { ...c.ses.seen, notes: s.inbox.length };
  const inbox = s.inbox.slice(0, 6).map(n => `· "${n.text}" (${ago(n.at, c.now)})`).join("\n");
  return reply(`💌 내 쪽지함 (나를 챙겨주는 사람이 보낸 쪽지)\n\n${inbox || "아직 받은 쪽지가 없어요."}${s.inbox.length > 6 ? `\n…외 ${s.inbox.length - 6}개` : ""}\n\n📮 ${s.target}님에게 보낸 쪽지: ${s.sent}개\n오늘 더 보낼 수 있는 쪽지: ${s.left.notes}개`,
    withMenu([["✏️ 쪽지 쓰기", "쪽지 쓰기"]]));
}
async function startNote(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  if (s.left.notes <= 0) return reply("오늘 쪽지를 다 보냈어요. 내일 또 보내요!", withMenu());
  c.ses.mode = { m: "note" };
  return reply(`✏️ ${s.target}님에게 보낼 쪽지를 써주세요.\n내 이름은 안 나가요. (${c.X.C.NOTE_MAX}자까지)`, [["취소", "취소"]]);
}

/* ---------- 예/아니오 질문 ---------- */
async function asks(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  c.ses.seen = { ...c.ses.seen, ans: s.myAsks.filter(a => a.ans).length };
  const mine = s.myAsks.slice(-5).map(a => `· ${a.q} → ${a.ans ? `"${a.ans}"` : "기다리는 중"}`).join("\n");
  const open = s.tAsks.find(a => !a.ans);
  let t = `🗨️ 내가 한 질문 (나를 챙겨주는 사람에게)\n${mine || "아직 없어요."}\n오늘 남은 질문: ${s.left.asks}개`;
  const qr = [];
  if (open) {
    t += `\n\n❓ ${s.target}님이 자기 마니또(나!)에게 물어봤어요:\n"${open.q}"\n\n예/아니오로 답해주세요.` + (s.lieLeft ? "\n🤥 거짓말 찬스가 1번 남았어요. 거짓말은 공개 때 밝혀져요." : "");
    qr.push(["예", `답변 ${open.k} 예`], ["아니오", `답변 ${open.k} 아니오`]);
    if (s.lieLeft) qr.push(["🤥 예 (거짓말)", `답변 ${open.k} 거짓 예`], ["🤥 아니오 (거짓말)", `답변 ${open.k} 거짓 아니오`]);
  }
  qr.push(["❓ 질문하기", "질문하기"]);
  return reply(t, withMenu(qr));
}
async function startAsk(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  if (s.left.asks <= 0) return reply("오늘 질문을 다 했어요. 내일 또 물어봐요!", withMenu());
  c.ses.mode = { m: "ask" };
  return reply(`❓ 나를 챙겨주는 사람에게 예/아니오 질문을 보내세요. (${c.X.C.ASK_MAX}자까지)\n예) 나랑 같은 학교야? / 안경 써?\n\n※ 상대는 게임 중 딱 한 번 거짓말을 할 수 있어요.`, [["취소", "취소"]]);
}
async function answerAsk(c, k, ans, lie) {
  if (!c.ses.room || c.ses.who == null) return home(c);
  const r = await call(c, "answer", { k, ans, lie });
  if (r.err) return reply(r.err, withMenu([["❓ 질문", "질문"]]));
  return reply(`✅ "${ans}"(이)라고 답했어요.${lie ? " 🤥 거짓말 찬스를 썼어요!" : ""}`, withMenu([["❓ 질문", "질문"]]));
}

/* ---------- 퀴즈 ---------- */
const CIR = ["①", "②", "③"];
async function quiz(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const parts = [], qr = [];
  if (!s.myQuiz) { parts.push("📝 내 퀴즈: 아직 안 냈어요.\n나에 대한 문제 3개를 내면, 나를 챙겨주는 사람이 풀어요."); qr.push(["📝 퀴즈 내기", "퀴즈 내기"]); }
  else parts.push(`📝 내 퀴즈: ${s.myQuizSolved.n}/3 풀림 · ${s.myQuizSolved.right}개 맞힘` + (s.quizLocked ? "" : "\n(아직 아무도 안 풀어서 다시 낼 수 있어요)"));
  if (!s.myQuiz || !s.quizLocked) { if (s.myQuiz) qr.push(["📝 다시 내기", "퀴즈 내기"]); }
  if (!s.tQuiz) parts.push(`\n🧩 ${s.target}님은 아직 퀴즈를 안 냈어요.`);
  else {
    const solved = s.tQuiz.map((q, k) => q.mine != null ? `${q.mine === q.ans ? "✅" : "❌"} ${q.q} → ${q.opts[q.ans]}` : null).filter(Boolean);
    const k = s.tQuiz.findIndex(q => q.mine == null);
    parts.push(`\n🧩 ${s.target}님 퀴즈 (맞히면 문제당 +2점)` + (solved.length ? "\n" + solved.join("\n") : ""));
    if (k >= 0) {
      const q = s.tQuiz[k];
      parts.push(`\nQ${k + 1}. ${q.q}\n` + q.opts.map((o, j) => `${CIR[j]} ${o}`).join("\n"));
      q.opts.forEach((o, j) => qr.push([`${CIR[j]} ${o}`, `퀴즈답 ${k} ${j}`]));
    } else parts.push("다 풀었어요!");
  }
  return reply(parts.join("\n"), withMenu(qr));
}
async function startQuiz(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  if (s.quizLocked) return reply("내 마니또가 이미 풀기 시작해서 바꿀 수 없어요.", withMenu());
  c.ses.mode = { m: "quiz", qs: [] };
  return reply("📝 나에 대한 퀴즈 3문제를 내요.\n한 문제씩 '질문 / 정답 / 오답 / 오답' 형식으로 보내주세요.\n\n예) 내가 좋아하는 계절은? / 겨울 / 여름 / 봄\n\n1번 문제를 보내주세요.", [["취소", "취소"]]);
}
async function solveQuiz(c, k, j) {
  if (!c.ses.room || c.ses.who == null) return home(c);
  const r = await call(c, "solve", { k, c: j });
  if (r.err) return reply(r.err, withMenu([["🧩 퀴즈", "퀴즈"]]));
  const q = r.s.tQuiz[k], ok = q.mine === q.ans;
  const next = r.s.tQuiz.some(x => x.mine == null);
  return reply(`${ok ? "⭕ 정답! +2점" : `❌ 아쉬워요. 정답은 '${q.opts[q.ans]}'`}\n쓸 수 있는 점수: ${r.s.points.balance}점`, withMenu(next ? [["🧩 다음 문제", "퀴즈"]] : []));
}

/* ---------- 힌트 ---------- */
async function hints(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const p = s.prices, qr = [];
  const own = s.hints.map(h => `· ${h.text}`).join("\n");
  const shop = [];
  if (p.len != null) { shop.push(`· 이름 글자 수: ${p.len}점`); qr.push([`글자 수 ${p.len}점`, "힌트 글자수"]); }
  if (p.elim != null) { shop.push(`· 후보 한 명 지우기: ${p.elim}점`); qr.push([`후보 지우기 ${p.elim}점`, "힌트 지우기"]); }
  if (p.cho != null) { shop.push(`· 이름 한 글자 초성: ${p.cho}점`); qr.push([`초성 ${p.cho}점`, "힌트 초성"]); }
  return reply(`🔍 힌트 상점 — 나를 챙겨주는 사람은 누구?\n⭐ 쓸 수 있는 점수: ${s.points.balance}점\n\n${shop.join("\n") || "살 수 있는 힌트를 다 샀어요."}\n\n📜 내 힌트\n${own || "아직 없어요."}\n\n※ 힌트에 쓴 점수는 최종 점수에서 빠져요.`, withMenu(qr));
}
async function buyHint(c, type) {
  if (!c.ses.room || c.ses.who == null) return home(c);
  const r = await call(c, "hint", { type });
  if (r.err) return reply(r.err, withMenu([["🔍 힌트", "힌트"]]));
  return reply(`🔍 ${r.s.hints.at(-1).text}\n\n남은 점수: ${r.s.points.balance}점`, withMenu([["🎯 맞히기", "맞히기"], ["🔍 힌트", "힌트"]]));
}

/* ---------- 맞히기 ---------- */
async function guessMenu(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const others = s.names.filter(n => n !== s.me);
  const cand = others.filter(n => !s.elim.includes(n));
  const list = others.map(n => `${s.elim.includes(n) ? "✖️" : "·"} ${n}${n === s.guess ? " 🎯" : ""}`).join("\n");
  return reply(`🎯 나를 챙겨주는 사람은 누구일까요?\n공개 전까지 몇 번이든 바꿀 수 있어요. 맞히면 +${c.X.C.GUESS_PTS}점!\n\n지금 찍은 사람: ${s.guess || "없음"}\n\n${list}` + (cand.length > 9 ? "\n\n'찍기 홍길동'처럼 보내주세요." : "") + (s.elim.length ? "\n(✖️는 힌트로 지운 사람)" : ""),
    cand.length <= 9 ? [...cand.map(n => [n, "찍기 " + n]), ...MENU.slice(0, 1)] : withMenu());
}
async function guess(c, name) {
  const { s, res } = await state(c);
  if (res) return res;
  const gi = s.names.indexOf(name);
  if (gi < 0) return reply(`'${name}'은(는) 명단에 없어요.`, withMenu([["🎯 맞히기", "맞히기"]]));
  const r = await call(c, "guess", { guess: gi });
  if (r.err) return reply(r.err, withMenu([["🎯 맞히기", "맞히기"]]));
  return reply(`🎯 '${name}'님으로 찍었어요! 공개 때 확인해요.`, withMenu());
}

/* ---------- 점수 ---------- */
async function points(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (s.over) return result(c, s);
  const p = s.points;
  return reply(`📊 내 점수\n\n🃏 미션: ${p.mission}점 (${s.done.length}개)\n🧩 퀴즈: ${p.quiz}점\n🔍 힌트에 씀: -${p.spent}점\n⭐ 지금 점수: ${p.balance}점\n🎯 맞히면 공개 때 +${c.X.C.GUESS_PTS}점\n\n${s.done.slice(-5).map(d => `✅ ${d.title} ${stars(d.pts)}${d.photo ? " 📸" : ""}`).join("\n")}`.trim(), withMenu());
}

/* ---------- 단톡방 공지 ---------- */
function joinGuide(c, s) {
  const ch = c.env.CHANNEL_URL;
  return `1) 카카오톡 채널 추가${ch ? `: ${ch}` : " (채널 검색: " + (c.env.CHANNEL_NAME || "마니또 채널") + ")"}\n2) 채널 채팅방에 참가 코드 ${s.code} 보내기\n3) 내 이름 고르기`;
}
async function announce(c) {
  const { s, res } = await state(c);
  if (res) return res;
  const pub = s.pub, joined = pub.claimed.filter(Boolean).length, cheer = pub.cheer.reduce((a, b) => a + b, 0);
  const msg = s.over
    ? null
    : `🎁 [${s.title}] 진행 중!\n\n참가: ${joined}/${s.names.length}명\n지금까지 완료한 미션: ${cheer}개\n공개: ${fmt(s.reveal)} (${until(s.reveal, c.now)})\n\n아직 참가 안 했다면 👇\n${joinGuide(c, s)}`;
  if (!msg) return shareResult(c, s);
  return reply(["📢 아래 말풍선을 길게 눌러 '전달' → 단톡방을 고르면 공지가 돼요.", msg], withMenu());
}

/* ---------- 공개 ---------- */
async function result(c, s0) {
  let s = s0;
  if (!s) { const r = await state(c); if (r.res) return r.res; s = r.s; }
  const pub = s.pub;
  if (!s.over || !pub.result) return reply(`아직 공개 전이에요. ${fmt(s.reveal)} (${until(s.reveal, c.now)})`, withMenu());
  const giver = pub.result.find(([, t]) => t === s.me)?.[0];
  const sc = pub.scores.slice().sort((a, b) => b.total - a.total);
  const myScore = pub.scores.find(x => x.name === s.me);
  const rank = sc.map((x, k) => `${k === 0 ? "👑" : `${k + 1}.`} ${x.name} ${x.total}점${x.right ? " 🎯" : ""}`).join("\n");
  const lies = (pub.lies || []).filter(l => l.asker === s.me).map(l => `🤥 "${l.q}" → "${l.ans}"는 거짓말이었어요!`).join("\n");
  return reply([
    `🎉 공개!\n\n나를 챙겨준 마니또는... 🎁 ${giver} 🎁\n내 추측: ${myScore.guess || "없음"} ${myScore.guess ? (myScore.right ? "✅ 정답 +3점" : "❌") : ""}${lies ? "\n\n" + lies : ""}`,
    `🏆 최고의 마니또\n${rank}\n\n🔗 전체 짝\n${pub.result.map(([a, b]) => `${a} → ${b}`).join("\n")}`,
  ], [["📸 앨범", "앨범"], ["📢 결과 공유", "결과 공유"], ["🏠 홈", "홈"]]);
}
async function shareResult(c, s0) {
  let s = s0;
  if (!s) { const r = await state(c); if (r.res) return r.res; s = r.s; }
  if (!s.over || !s.pub.result) return announce(c);
  const sc = s.pub.scores.slice().sort((a, b) => b.total - a.total);
  const msg = `🎉 [${s.title}] 결과!\n\n👑 최고의 마니또: ${sc[0].name} (${sc[0].total}점)\n\n${s.pub.result.map(([a, b]) => `${a} → ${b}`).join("\n")}\n\n🎯 정체를 맞힌 사람: ${sc.filter(x => x.right).map(x => x.name).join(", ") || "없음"}\n📸 미션 사진: ${s.pub.album.length}장`;
  return reply(["📢 아래 말풍선을 길게 눌러 '전달' → 단톡방을 고르면 결과가 공유돼요.", msg], [["📸 앨범", "앨범"], ["🏠 홈", "홈"]]);
}
async function album(c) {
  const { s, res } = await state(c);
  if (res) return res;
  if (!s.over) return reply("앨범은 공개 시간에 열려요.", withMenu());
  const items = s.pub.album.slice(-10).map(a => ({
    title: `${a.title}`.slice(0, 50),
    description: `${a.from} → ${a.to}`.slice(0, 230),
    thumbnail: { imageUrl: `${c.origin}/api/rooms/${c.ses.room}/img/${a.img}`, fixedRatio: false },
  }));
  if (!items.length) return reply("📸 올라온 미션 사진이 없어요.", [["🎉 결과", "결과"], ["🏠 홈", "홈"]]);
  return reply([`📸 미션 앨범 (${s.pub.album.length}장${s.pub.album.length > 10 ? ", 최근 10장" : ""})`, { carousel: { type: "basicCard", items } }], [["🎉 결과", "결과"], ["📢 결과 공유", "결과 공유"], ["🏠 홈", "홈"]]);
}
