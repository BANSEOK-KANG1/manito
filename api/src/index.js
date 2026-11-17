import { kakaoSkill, kakaoDebug } from "./bot.js";
// 마니또 API — 서버가 직접 뽑고, 각자 이름+비밀번호로 자기 것만 받는다.
// 방마다 Durable Object 하나: 저장 즉시 반영되고 요청이 차례대로 처리된다.
// 저장 키: "room" (방 정보), "p:<i>" (사람별 상태), "img:<key>" (증거 사진)
const TTL = 60 * 60 * 24 * 45;
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;
const DONE_PER_DAY = 3, NOTES_PER_DAY = 3, NOTE_MAX = 120, ASKS_PER_DAY = 2, ASK_MAX = 40;
const GUESS_PTS = 3, QUIZ_PTS = 2, QUIZ_N = 3, IMG_MAX = 220 * 1024, IMG_MAX_K = 1500 * 1024, IMG_PER_PERSON = 25;
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

const DECK = [
  [1, "단톡방 칭찬", "단톡방에서 마니또를 자연스럽게 칭찬하기. 티 나지 않게!"],
  [1, "안부 묻기", "마니또에게 \"오늘 하루 어땠어?\" 하고 물어보기"],
  [1, "1등 반응", "마니또가 단톡방에 올린 말에 제일 먼저 반응하기"],
  [1, "응원 쪽지", "익명 쪽지로 마니또에게 응원 한마디 보내기"],
  [1, "취향 조사: 노래", "마니또가 요즘 즐겨 듣는 노래 알아내기"],
  [1, "취향 조사: MBTI", "들키지 않고 마니또의 MBTI 알아내기"],
  [1, "좋아하는 색", "마니또가 좋아하는 색을 알아내기"],
  [2, "몰래 간식", "마니또 책상이나 가방에 간식 몰래 두기"],
  [2, "음료 배달", "다른 사람 핑계를 대고 마니또에게 음료 건네기"],
  [2, "최애 음식", "마니또가 제일 좋아하는 음식 알아내기"],
  [2, "한 줄 손편지", "손편지 한 줄을 써서 몰래 전달하기"],
  [2, "도움의 손길", "마니또가 하는 일 하나를 조용히 도와주기"],
  [2, "칭찬 전달", "\"누가 너 칭찬하더라\" 하고 다른 사람인 척 칭찬 전하기"],
  [2, "이름 삼행시", "마니또 이름으로 삼행시를 지어 익명 쪽지로 보내기"],
  [2, "추억 사진", "마니또가 모르게 좋은 사진 한 장 찍어두기 (공개 때 보여주기)"],
  [3, "작은 선물", "마니또에게 작은 선물을 들키지 않고 전달하기"],
  [3, "단둘이 10분", "들키지 않고 마니또와 단둘이 10분 이야기하기"],
  [3, "연막 작전", "다른 사람이 마니또인 것처럼 마니또를 헷갈리게 만들기"],
  [3, "깜짝 이벤트", "마니또를 위한 작은 깜짝 이벤트 준비하기"],
].map(([pts, title, desc], id) => ({ id, pts, title, desc }));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors } });
const fail = (code, msg, status = 400) => json({ error: code, message: msg }, status);

function randInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newId(n = 10) { let s = ""; for (let i = 0; i < n; i++) s += ID_CHARS[randInt(ID_CHARS.length)]; return s; }
async function sha(t) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const clean = (s, max = 200) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const kstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
function initialOf(ch) { const c = ch.charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch.toUpperCase(); }

/* ---------- 상태 ---------- */
async function loadPerson(st, i, room) {
  const p = structuredClone((await st.get("p:" + i)) || {});
  if (!p.pin && room.pins?.[i]) p.pin = room.pins[i];
  p.fails ||= { n: 0, until: 0 }; p.done ||= []; p.notes ||= []; p.day ||= {};
  p.asks ||= []; p.hints ||= []; p.elim ||= []; p.chos ||= []; p.quizAns ||= {}; p.spent ||= 0;
  return p;
}
const savePerson = (st, i, p) => st.put("p:" + i, p);
const loadAll = (st, room) => Promise.all(room.names.map((_, i) => loadPerson(st, i, room)));
const giverOf = (room, i) => room.target.indexOf(i);
const missionPts = p => p.done.reduce((s, d) => s + (DECK[d.card]?.pts || 0), 0);
// 내가 푼 퀴즈 점수: 내 대상(target)의 퀴즈와 내 답 비교
function quizPts(p, targetP) {
  if (!targetP?.quiz) return { n: 0, right: 0, pts: 0 };
  let n = 0, right = 0;
  targetP.quiz.forEach((q, k) => { if (p.quizAns[k] != null) { n++; if (p.quizAns[k] === q.ans) right++; } });
  return { n, right, pts: right * QUIZ_PTS };
}
const earned = (p, tp) => missionPts(p) + quizPts(p, tp).pts;
function today(p, now) { const d = kstDay(now); if (p.day.d !== d) p.day = { d, done: 0, notes: 0, pass: 0, asks: 0 }; p.day.asks ||= 0; return p.day; }

function hintPrices(room, i, p) {
  const giver = room.names[giverOf(room, i)];
  const cands = room.names.filter((n, k) => k !== i && !p.elim.includes(n));
  return {
    len: p.hints.some(h => h.t === "len") ? null : 1,
    elim: cands.length > 2 ? 2 : null, // 가격은 고정 (찬스를 가볍게)
    cho: p.chos.length < [...giver].length ? 3 : null,
  };
}

function scores(room, people) {
  return room.names.map((n, i) => {
    const p = people[i], tp = people[room.target[i]];
    const right = p.guess != null && giverOf(room, i) === p.guess;
    const mp = missionPts(p), qz = quizPts(p, tp);
    return {
      name: n, missions: p.done.length, missionPts: mp, quizRight: qz.right, quizPts: qz.pts, spent: p.spent,
      guess: p.guess != null ? room.names[p.guess] : null, right,
      total: mp + qz.pts + (right ? GUESS_PTS : 0) - p.spent,
    };
  });
}

async function publicView(st, room, now) {
  const people = await loadAll(st, room);
  const out = {
    title: room.title, names: room.names, reveal: room.reveal, now,
    claimed: people.map(p => !!(p.pin || p.kid)),
    // 사람별 '받은 미션 수'는 짝을 짐작하게 해서(안 들어온 사람의 대상만 0 등) 공개 전엔 합계만 준다
    cheerTotal: people.reduce((s, p) => s + p.done.length, 0),
  };
  if (now >= room.reveal) {
    out.result = room.names.map((n, i) => [n, room.names[room.target[i]]]);
    out.scores = scores(room, people);
    out.album = [];
    people.forEach((p, i) => p.done.forEach(d => { if (d.img) out.album.push({ from: room.names[i], to: room.names[room.target[i]], title: DECK[d.card].title, img: d.img, at: d.at }); }));
    out.album.sort((a, b) => a.at - b.at);
    out.lies = [];
    people.forEach((p, i) => p.asks.forEach(a => { if (a.lie) out.lies.push({ asker: room.names[i], liar: room.names[giverOf(room, i)], q: a.q, ans: a.ans }); }));
  }
  return out;
}

function myState(room, i, people, now) {
  const p = people[i], t = room.target[i], tp = people[t], g = giverOf(room, i), gp = people[g];
  const d = today(p, now), over = now >= room.reveal;
  const bal = earned(p, tp) - p.spent;
  return {
    me: room.names[i], target: room.names[t], who: i, over,
    // 챙겨주기
    card: p.card != null ? DECK[p.card] : null,
    deal: p.deal ? p.deal.map(c => DECK[c].pts) : null,
    done: p.done.map((x, k) => ({ ...DECK[x.card], at: x.at, k, photo: !!x.img })),
    left: { done: DONE_PER_DAY - d.done, notes: NOTES_PER_DAY - d.notes, pass: 1 - d.pass, asks: ASKS_PER_DAY - d.asks },
    tQuiz: tp.quiz ? tp.quiz.map((q, k) => {
      const mine = p.quizAns[k];
      return { q: q.q, opts: q.opts, mine: mine ?? null, ans: mine != null ? q.ans : null };
    }) : null,
    tAsks: tp.asks.map((a, k) => ({ k, q: a.q, ans: a.ans || null, lie: !!a.lie, at: a.at })),
    lieLeft: p.lieUsed ? 0 : 1,
    sent: p.notes.length,
    // 추리하기
    inbox: gp.notes.slice().reverse(),
    cheer: gp.done.length,
    myAsks: p.asks.map(a => ({ q: a.q, ans: a.ans || null, at: a.at, lie: over ? !!a.lie : undefined })),
    hints: p.hints, prices: hintPrices(room, i, p), elim: p.elim,
    guess: p.guess != null ? room.names[p.guess] : null,
    // 점수
    points: { mission: missionPts(p), quiz: quizPts(p, tp).pts, spent: p.spent, balance: bal },
    // 내 퀴즈
    myQuiz: p.quiz ? p.quiz.map(q => ({ q: q.q, opts: q.opts, ans: q.ans })) : null,
    myQuizSolved: p.quiz ? (() => { let n = 0, r = 0; p.quiz.forEach((q, k) => { if (gp.quizAns[k] != null) { n++; if (gp.quizAns[k] === q.ans) r++; } }); return { n, right: r, total: p.quiz.length }; })() : null,
    quizLocked: !!(p.quiz && Object.keys(gp.quizAns).length),
  };
}

/* ---------- 방 만들기 ---------- */
async function create(body, st) {
  const names = (body.names || []).map(n => clean(n, 40)).filter(Boolean);
  if (names.length < 3 || names.length > 30) return fail("count", "참가자는 3명에서 30명 사이여야 해요.");
  if (names.some(n => n.length > 20)) return fail("long", "이름은 20자까지 쓸 수 있어요.");
  if (new Set(names).size !== names.length) return fail("dup", "같은 이름이 있어요. 성이나 별명을 붙여 구분해 주세요.");
  const reveal = Number(body.reveal);
  if (!Number.isFinite(reveal)) return fail("reveal", "공개 시각을 다시 골라주세요.");
  const title = clean(body.title, 30) || "우리 마니또";
  const order = shuffle(names.map((_, i) => i));
  const target = new Array(names.length);
  order.forEach((p, k) => { target[p] = order[(k + 1) % order.length]; });
  if (await st.get("room")) return fail("exists", "잠시 뒤 다시 해주세요.", 409);
  const code = /^[A-Z0-9]{6}$/.test(body.code || "") ? body.code : undefined;
  await st.put("room", { title, names, reveal, target, created: Date.now(), v: 3, code });
  return json({ ok: true });
}

/* ---------- 비밀번호 ---------- */
async function auth(st, id, room, body, now) {
  const i = Number(body?.who), pin = String(body?.pin ?? "");
  if (!Number.isInteger(i) || i < 0 || i >= room.names.length) return { err: fail("who", "이름을 다시 골라주세요.") };
  if (!/^\d{4}$/.test(pin)) return { err: fail("pin", "비밀번호는 숫자 4자리예요.") };
  const p = await loadPerson(st, i, room);
  if (p.fails.until > now) return { err: fail("locked", `비밀번호를 여러 번 틀려서 잠시 잠겼어요. ${Math.ceil((p.fails.until - now) / 60000)}분 뒤에 다시 해주세요.`, 429) };
  const h = await sha(`${id}:${i}:${pin}`);
  if (p.kid) return { err: fail("kakao", "이 이름은 카카오톡 챗봇으로 참가했어요. 챗봇에서 이어서 해주세요.", 403) };
  if (!p.pin) {
    if (body.claim !== true) return { err: fail("unclaimed", "아직 비밀번호가 없어요. 새로 정해주세요.", 409) };
    p.pin = h; await savePerson(st, i, p);
  } else if (p.pin !== h) {
    p.fails.n += 1; if (p.fails.n >= MAX_FAILS) p.fails = { n: 0, until: now + LOCK_MS };
    await savePerson(st, i, p);
    return { err: fail("wrong_pin", body.claim ? "이 이름은 이미 누군가 비밀번호를 정했어요. 본인이 정한 적 없다면 단톡방에 알려주세요." : "비밀번호가 맞지 않아요.", 403) };
  } else if (p.fails.n) { p.fails = { n: 0, until: 0 }; await savePerson(st, i, p); }
  return { i };
}

/* ---------- 행동 ---------- */
// 카톡 챗봇: 워커가 확인한 카카오 사용자(해시)로 본인 확인
async function kauth(st, room, body) {
  const i = Number(body?.who);
  if (!Number.isInteger(i) || i < 0 || i >= room.names.length) return { err: fail("who", "이름을 다시 골라주세요.") };
  const p = await loadPerson(st, i, room);
  if (!body.kid || p.kid !== body.kid) return { err: fail("not_me", "이 이름으로 참가한 기록이 없어요. 참가 코드를 다시 보내주세요.", 403) };
  return { i };
}

async function act(body, st, id, kind, room, kakao = false) {
  const now = Date.now();
  const a = kakao ? await kauth(st, room, body) : await auth(st, id, room, body, now);
  if (a.err) return a.err;
  const i = a.i, people = await loadAll(st, room);
  const p = people[i], t = room.target[i], tp = people[t];
  const d = today(p, now);
  const dirty = new Set([i]);

  if (kind !== "open" && now >= room.reveal) return fail("over", "결과가 공개돼서 이제 기록할 수 없어요.", 409);

  switch (kind) {
    case "open": dirty.clear(); break;
    case "deal": // 카드 3장 깔기 (난이도만 보이고, 고른 뒤 미션 공개)
    case "draw": {
      if (p.card != null) return fail("has_card", "이미 뽑은 카드가 있어요. 먼저 완료하거나 패스해 주세요.", 409);
      if (d.done >= DONE_PER_DAY) return fail("limit", `오늘은 미션을 ${DONE_PER_DAY}개 다 했어요. 내일 또 뽑아요!`, 429);
      if (kind === "draw" && body.pick != null) {
        const pick = Number(body.pick);
        if (!p.deal || p.deal[pick] == null) return fail("no_deal", "카드를 다시 깔아주세요.", 409);
        p.card = p.deal[pick]; p.deal = null; break;
      }
      const used = new Set(p.done.map(x => x.card));
      let pool = DECK.filter(c => !used.has(c.id) && c.id !== p.last);
      if (pool.length < 3) pool = DECK.filter(c => c.id !== p.last);
      if (kind === "deal") { if (!p.deal) p.deal = shuffle(pool).slice(0, 3).map(c => c.id); else dirty.clear(); break; }
      p.card = pool[randInt(pool.length)].id; p.deal = null; break;
    }
    case "done":
      if (p.card == null) return fail("no_card", "먼저 카드를 뽑아주세요.", 409);
      if (d.done >= DONE_PER_DAY) return fail("limit", `오늘은 미션을 ${DONE_PER_DAY}개 다 했어요.`, 429);
      p.done.push({ card: p.card, at: now }); p.last = p.card; p.card = null; d.done++; break;
    case "pass":
      if (p.card == null) return fail("no_card", "패스할 카드가 없어요.", 409);
      if (d.pass >= 1) return fail("limit", "패스는 하루에 한 번만 할 수 있어요.", 429);
      p.last = p.card; p.card = null; d.pass++; break;
    case "photo": {
      const k = Number(body.k), item = p.done[k];
      if (!item) return fail("no_mission", "사진을 붙일 미션을 찾지 못했어요.");
      if (p.done.filter(x => x.img).length >= IMG_PER_PERSON && !item.img) return fail("limit", "사진은 더 올릴 수 없어요.", 429);
      let bytes;
      try { bytes = Uint8Array.from(atob(String(body.data || "")), c => c.charCodeAt(0)); } catch (e) { return fail("img", "사진을 읽지 못했어요."); }
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8, png = bytes[0] === 0x89 && bytes[1] === 0x50;
      if (bytes.length < 100 || bytes.length > (kakao ? IMG_MAX_K : IMG_MAX) || !(jpg || (kakao && png))) return fail("img", "사진이 너무 크거나 형식이 맞지 않아요.");
      if (item.img) await st.delete("img:" + item.img);
      item.img = newId(16);
      await st.put("img:" + item.img, bytes); break;
    }
    case "note": {
      const text = clean(body.text, NOTE_MAX);
      if (!text) return fail("empty", "쪽지 내용을 써주세요.");
      if (d.notes >= NOTES_PER_DAY) return fail("limit", `쪽지는 하루에 ${NOTES_PER_DAY}개까지 보낼 수 있어요.`, 429);
      p.notes.push({ text, at: now }); d.notes++; break;
    }
    case "guess": {
      const gi = Number(body.guess);
      if (!Number.isInteger(gi) || gi < 0 || gi >= room.names.length || gi === i) return fail("guess", "나를 뺀 다른 사람 중에서 골라주세요.");
      p.guess = gi; break;
    }
    case "quiz": { // 나에 대한 퀴즈 내기
      const g = people[giverOf(room, i)];
      if (p.quiz && Object.keys(g.quizAns).length) return fail("locked", "내 마니또가 이미 풀기 시작해서 바꿀 수 없어요.", 409);
      const qs = (body.quiz || []).slice(0, QUIZ_N).map(q => ({ q: clean(q.q, 60), a: clean(q.a, 30), w: (q.w || []).map(x => clean(x, 30)).filter(Boolean).slice(0, 2) }));
      if (!qs.length || qs.some(q => !q.q || !q.a || q.w.length !== 2)) return fail("quiz", `문제는 1~${QUIZ_N}개, 문제마다 질문·정답·오답 2개를 채워주세요.`);
      if (qs.some(q => new Set([q.a, ...q.w]).size !== 3)) return fail("quiz", "정답과 오답이 같은 문제가 있어요.");
      p.quiz = qs.map(q => { const opts = shuffle([q.a, ...q.w]); return { q: q.q, opts, ans: opts.indexOf(q.a) }; });
      break;
    }
    case "solve": { // 내가 챙기는 사람의 퀴즈 풀기
      const k = Number(body.k), c = Number(body.c);
      if (!tp.quiz || !tp.quiz[k]) return fail("no_quiz", "아직 퀴즈가 없어요.", 409);
      if (p.quizAns[k] != null) return fail("answered", "이미 푼 문제예요.", 409);
      if (!Number.isInteger(c) || c < 0 || c > 2) return fail("choice", "보기를 골라주세요.");
      p.quizAns[k] = c; break;
    }
    case "ask": { // 나를 챙기는 사람에게 예/아니오 질문
      const q = clean(body.q, ASK_MAX);
      if (!q) return fail("empty", "질문을 써주세요.");
      if (d.asks >= ASKS_PER_DAY) return fail("limit", `질문은 하루에 ${ASKS_PER_DAY}개까지 할 수 있어요.`, 429);
      p.asks.push({ q, at: now, ans: null, lie: false }); d.asks++; break;
    }
    case "answer": { // 내가 챙기는 사람이 보낸 질문에 답하기
      const k = Number(body.k), ans = body.ans === "예" ? "예" : body.ans === "아니오" ? "아니오" : null, lie = body.lie === true;
      const q = tp.asks[k];
      if (!q) return fail("no_ask", "질문을 찾지 못했어요.");
      if (q.ans) return fail("answered", "이미 답한 질문이에요.", 409);
      if (!ans) return fail("ans", "예 또는 아니오로 답해주세요.");
      if (lie && p.lieUsed) return fail("lie", "거짓말 찬스는 이미 썼어요.", 409);
      q.ans = ans; q.lie = lie; q.answeredAt = now;
      if (lie) p.lieUsed = true;
      dirty.add(t); break;
    }
    case "hint": {
      const type = body.type, pr = hintPrices(room, i, p)[type];
      if (pr == null) return fail("hint", "이 힌트는 더 살 수 없어요.", 409);
      if (earned(p, tp) - p.spent < pr) return fail("poor", `점수가 모자라요. ${pr}점이 필요해요.`, 409);
      const giver = room.names[giverOf(room, i)], chars = [...giver];
      let text;
      if (type === "len") text = `내 마니또 이름은 ${chars.length}글자예요`;
      else if (type === "elim") {
        const c = room.names.filter((n, k) => k !== i && n !== giver && !p.elim.includes(n));
        const n = c[randInt(c.length)]; p.elim.push(n); text = `${n}님은 내 마니또가 아니에요`;
      } else if (type === "cho") {
        const pos = chars.map((_, k) => k).filter(k => !p.chos.includes(k)), k = pos[randInt(pos.length)];
        p.chos.push(k); text = `내 마니또 이름 ${k + 1}번째 글자의 초성은 '${initialOf(chars[k])}'`;
      } else return fail("hint", "없는 힌트예요.");
      p.spent += pr; p.hints.push({ t: type, text, cost: pr, at: now }); break;
    }
    default: return fail("not_found", "없는 기능이에요.", 404);
  }
  for (const k of dirty) await savePerson(st, k, people[k]);
  const s = myState(room, i, people, now);
  if (kakao) Object.assign(s, { title: room.title, reveal: room.reveal, names: room.names, code: room.code, pub: await publicView(st, room, now) });
  return json(s);
}

/* ---------- Durable Object ---------- */
const NO_ROOM = () => fail("no_room", "마니또 방을 찾지 못했어요. 링크를 다시 확인해 주세요.", 404);
const KINDS = "open|draw|done|pass|photo|note|guess|quiz|solve|ask|answer|hint";

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async room(id) { // 예전(KV) 방이면 처음 한 번 옮겨 온다
    const st = this.ctx.storage;
    let room = await st.get("room");
    if (!room && this.env.OLDKV) {
      const old = await this.env.OLDKV.get("room:" + id, "json");
      if (old) {
        room = { title: old.title, names: old.names, reveal: old.reveal, target: old.target, created: old.created, v: 3 };
        for (const [i, h] of Object.entries(old.pins || {})) await st.put("p:" + i, { pin: h });
        await st.put("room", room);
      }
    }
    return room;
  }
  async fetch(req) {
    const url = new URL(req.url), st = this.ctx.storage;
    const [, id, kind, key] = url.pathname.split("/");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    if (kind === "init") {
      const r = await create(body || {}, st);
      if (r.ok) await st.setAlarm(Date.now() + TTL * 1000);
      return r;
    }
    const room = await this.room(id);
    if (!room) return NO_ROOM();
    if (!kind) return json(await publicView(st, room, Date.now()));
    const kakao = req.headers.get("x-kakao") === "1"; // 워커 내부 호출만 이 헤더를 붙인다 (바깥 요청은 헤더를 넘기지 않음)
    if (kakao && kind === "kpeek") { // 참가 전: 이름 목록·내가 이미 고른 이름
      const people = await loadAll(st, room);
      return json({ ...(await publicView(st, room, Date.now())), code: room.code, mine: people.findIndex(p => p.kid && p.kid === body?.kid) });
    }
    if (kakao && kind === "kclaim") {
      const i = Number(body?.who);
      if (!body?.kid || !Number.isInteger(i) || i < 0 || i >= room.names.length) return fail("who", "이름을 다시 골라주세요.");
      const people = await loadAll(st, room), had = people.findIndex(p => p.kid === body.kid);
      if (had >= 0 && had !== i) return fail("already", `이미 '${room.names[had]}'(으)로 참가했어요.`, 409);
      const p = people[i];
      if (p.kid !== body.kid) {
        if (p.kid || p.pin) return fail("taken", "이 이름은 이미 다른 사람이 골랐어요. 본인 이름이 맞다면 단톡방에 알려주세요.", 409);
        p.kid = body.kid; await savePerson(st, i, p);
      }
      return json({ ok: true });
    }
    if (kind === "img") {
      if (Date.now() < room.reveal) return fail("hidden", "사진은 공개 시간에 볼 수 있어요.", 403);
      const bytes = await st.get("img:" + key);
      if (!bytes) return fail("no_img", "사진이 없어요.", 404);
      return new Response(bytes, { headers: { "Content-Type": bytes[0] === 0x89 ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=86400", ...cors } });
    }
    if (kakao && !["deal", ...KINDS.split("|")].includes(kind)) return fail("not_found", "없는 기능이에요.", 404);
    return act(body, st, id, kind, room, kakao);
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// 작은 저장 칸: 카톡 사용자별 진행 상황(u:<해시>), 참가 코드 → 방(c:<코드>)
export class Box {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const st = this.ctx.storage;
    if (req.method === "GET") return json((await st.get("v")) ?? null);
    const { v, ifEmpty } = await req.json();
    if (ifEmpty && (await st.get("v")) != null) return json({ ok: false }, 409);
    await st.put("v", v); await st.setAlarm(Date.now() + TTL * 1000);
    return json({ ok: true });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

const stub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));
const ROUTE = new RegExp(`^/api/rooms/([a-z0-9]{10})(?:/(${KINDS}))?$`);
const IMG_ROUTE = /^\/api\/rooms\/([a-z0-9]{10})\/img\/([a-z0-9]{16})$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        const body = await req.text();
        for (let t = 0; t < 3; t++) {
          const id = newId();
          const r = await stub(env, id).fetch(`https://room/${id}/init`, { method: "POST", body });
          if (r.status !== 409) { const j = await r.json(); return r.ok ? json({ id }) : json(j, r.status); }
        }
        return fail("server", "잠시 뒤 다시 해주세요.", 500);
      }
      if (url.pathname === "/kakao/skill" && req.method === "GET") // 브라우저로 열었을 때 안내 (카카오는 POST로 보냄)
        return new Response("✅ 마니또 카카오 챗봇 스킬 주소가 정상 작동 중이에요.\n이 주소는 브라우저로 여는 곳이 아니라, 카카오 i 오픈빌더 '스킬' URL 칸에 넣는 주소예요.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/kakao/debug" && req.method === "GET" && env.BOX) return await kakaoDebug(req, env);
      if (url.pathname === "/kakao/skill" && req.method === "POST") {
        if (!env.BOX) return fail("not_found", "없는 주소예요.", 404);
        return await kakaoSkill(req, env, { stub, newId, sha, DECK, C: { NOTE_MAX, ASK_MAX, QUIZ_N, GUESS_PTS, QUIZ_PTS, IMG_MAX_K } });
      }
      const im = url.pathname.match(IMG_ROUTE);
      if (im && req.method === "GET") return await stub(env, im[1]).fetch(`https://room/${im[1]}/img/${im[2]}`);
      const m = url.pathname.match(ROUTE);
      if (m && ((!m[2] && req.method === "GET") || (m[2] && req.method === "POST"))) {
        const r = await stub(env, m[1]).fetch(`https://room/${m[1]}${m[2] ? "/" + m[2] : ""}`, { method: req.method, body: req.method === "POST" ? await req.text() : undefined });
        return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors } });
      }
      if (url.pathname.startsWith("/api/")) return fail("not_found", "없는 주소예요.", 404);
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response("manito api", { headers: cors });
    } catch (e) {
      return fail("server", "서버에서 문제가 생겼어요. 잠시 뒤 다시 해주세요.", 500);
    }
  },
};
