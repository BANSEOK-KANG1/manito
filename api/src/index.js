// 마니또 API — 서버가 직접 뽑고, 각자 이름+비밀번호로 자기 것만 받는다.
// 방 핵심 정보는 room:<id>, 사람별 상태(비밀번호·미션·쪽지·추측)는 room:<id>:p:<i> 에 따로 저장해
// 여러 사람이 동시에 움직여도 서로의 기록을 덮어쓰지 않게 한다.
const TTL = 60 * 60 * 24 * 45;
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;
const DONE_PER_DAY = 3, NOTES_PER_DAY = 3, NOTE_MAX = 120, GUESS_PTS = 3;
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

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
function newId() { let s = ""; for (let i = 0; i < 10; i++) s += ID_CHARS[randInt(ID_CHARS.length)]; return s; }
async function sha(t) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const clean = s => String(s ?? "").trim().replace(/\s+/g, " ");
const kstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);

// 저장: 방마다 Durable Object 하나 (저장 즉시 반영, 요청이 차례대로 처리됨)
// env 자리에 st(그 방의 storage)를 넘긴다.
async function loadRoom(st) { return (await st.get("room")) || null; }
async function loadPerson(st, id, i, room) {
  const p = structuredClone((await st.get("p:" + i)) || {});
  if (!p.pin && room.pins?.[i]) p.pin = room.pins[i]; // 예전 방 호환
  p.fails ||= { n: 0, until: 0 }; p.done ||= []; p.notes ||= []; p.day ||= {};
  return p;
}
const savePerson = (st, id, i, p) => st.put("p:" + i, p);
const loadAll = (env, id, room) => Promise.all(room.names.map((_, i) => loadPerson(env, id, i, room)));
const giverOf = (room, i) => room.target.indexOf(i);
const pts = p => p.done.reduce((s, d) => s + (DECK[d.card]?.pts || 0), 0);
function today(p, now) { const d = kstDay(now); if (p.day.d !== d) p.day = { d, done: 0, notes: 0, pass: 0 }; return p.day; }

function scores(room, people) {
  return room.names.map((n, i) => {
    const p = people[i], right = p.guess != null && giverOf(room, i) === p.guess;
    const mp = pts(p);
    return { name: n, missions: p.done.length, missionPts: mp, guess: p.guess != null ? room.names[p.guess] : null, right, total: mp + (right ? GUESS_PTS : 0) };
  });
}

async function publicView(env, id, room, now) {
  const people = await loadAll(env, id, room);
  const out = {
    title: room.title, names: room.names, reveal: room.reveal, now,
    claimed: people.map(p => !!p.pin),
    // 각 사람이 "받은" 미션 수 (누가 했는지는 숨김)
    cheer: room.names.map((_, i) => people[giverOf(room, i)]?.done.length || 0),
  };
  if (now >= room.reveal) {
    out.result = room.names.map((n, i) => [n, room.names[room.target[i]]]);
    out.scores = scores(room, people);
  }
  return out;
}

function myState(room, i, p, giver, now) {
  const t = room.target[i], d = today(p, now);
  return {
    me: room.names[i], target: room.names[t], who: i,
    card: p.card != null ? DECK[p.card] : null,
    done: p.done.map(x => ({ ...DECK[x.card], at: x.at })),
    points: pts(p),
    left: { done: DONE_PER_DAY - d.done, notes: NOTES_PER_DAY - d.notes, pass: 1 - d.pass },
    inbox: (giver?.notes || []).slice().reverse(),     // 내 마니또가 나에게 보낸 쪽지
    sent: p.notes.length,
    cheer: giver?.done.length || 0,                     // 내 마니또가 나를 위해 한 미션 수
    guess: p.guess != null ? room.names[p.guess] : null,
    deckSize: DECK.length,
  };
}

async function create(body, st) {
  if (!body) return fail("bad_json", "요청을 읽지 못했어요.");
  const names = (body.names || []).map(clean).filter(Boolean);
  if (names.length < 3 || names.length > 30) return fail("count", "참가자는 3명에서 30명 사이여야 해요.");
  if (names.some(n => n.length > 20)) return fail("long", "이름은 20자까지 쓸 수 있어요.");
  if (new Set(names).size !== names.length) return fail("dup", "같은 이름이 있어요. 성이나 별명을 붙여 구분해 주세요.");
  const reveal = Number(body.reveal);
  if (!Number.isFinite(reveal)) return fail("reveal", "공개 시각을 다시 골라주세요.");
  const title = clean(body.title).slice(0, 30) || "우리 마니또";
  const order = names.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = randInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const target = new Array(names.length);
  order.forEach((p, k) => { target[p] = order[(k + 1) % order.length]; });
  if (await st.get("room")) return fail("exists", "잠시 뒤 다시 해주세요.", 409);
  await st.put("room", { title, names, reveal, target, created: Date.now(), v: 2 });
  return json({ ok: true });
}

// 비밀번호 확인 (처음이면 claim 으로 정함). 성공하면 사람 상태를 돌려준다.
async function auth(env, id, room, body, now) {
  const i = Number(body?.who), pin = String(body?.pin ?? "");
  if (!Number.isInteger(i) || i < 0 || i >= room.names.length) return { err: fail("who", "이름을 다시 골라주세요.") };
  if (!/^\d{4}$/.test(pin)) return { err: fail("pin", "비밀번호는 숫자 4자리예요.") };
  const p = await loadPerson(env, id, i, room);
  if (p.fails.until > now) return { err: fail("locked", `비밀번호를 여러 번 틀려서 잠시 잠겼어요. ${Math.ceil((p.fails.until - now) / 60000)}분 뒤에 다시 해주세요.`, 429) };
  const h = await sha(`${id}:${i}:${pin}`);
  if (!p.pin) {
    if (body.claim !== true) return { err: fail("unclaimed", "아직 비밀번호가 없어요. 새로 정해주세요.", 409) };
    p.pin = h; await savePerson(env, id, i, p);
  } else if (p.pin !== h) {
    p.fails.n += 1; if (p.fails.n >= MAX_FAILS) p.fails = { n: 0, until: now + LOCK_MS };
    await savePerson(env, id, i, p);
    return { err: fail("wrong_pin", body.claim ? "이 이름은 이미 누군가 비밀번호를 정했어요. 본인이 정한 적 없다면 단톡방에 알려주세요." : "비밀번호가 맞지 않아요.", 403) };
  } else if (p.fails.n) { p.fails = { n: 0, until: 0 }; await savePerson(env, id, i, p); }
  return { i, p };
}

async function act(body, env, id, kind, room) {
  const now = Date.now();
  const a = await auth(env, id, room, body, now);
  if (a.err) return a.err;
  const { i, p } = a;
  const g = giverOf(room, i);
  const giver = g >= 0 ? await loadPerson(env, id, g, room) : null;
  const over = now >= room.reveal;
  const d = today(p, now);

  if (kind === "open") { /* 상태만 돌려줌 */ }
  else if (over && kind !== "open") return fail("over", "결과가 공개돼서 이제 기록할 수 없어요.", 409);
  else if (kind === "draw") {
    if (p.card != null) return fail("has_card", "이미 뽑은 카드가 있어요. 먼저 완료하거나 패스해 주세요.", 409);
    if (d.done >= DONE_PER_DAY) return fail("limit", `오늘은 미션을 ${DONE_PER_DAY}개 다 했어요. 내일 또 뽑아요!`, 429);
    const usedToday = new Set(p.done.map(x => x.card));
    let pool = DECK.filter(c => !usedToday.has(c.id) && c.id !== p.last);
    if (!pool.length) pool = DECK.filter(c => c.id !== p.last);
    p.card = pool[randInt(pool.length)].id;
  } else if (kind === "done") {
    if (p.card == null) return fail("no_card", "먼저 카드를 뽑아주세요.", 409);
    if (d.done >= DONE_PER_DAY) return fail("limit", `오늘은 미션을 ${DONE_PER_DAY}개 다 했어요.`, 429);
    p.done.push({ card: p.card, at: now }); p.last = p.card; p.card = null; d.done++;
  } else if (kind === "pass") {
    if (p.card == null) return fail("no_card", "패스할 카드가 없어요.", 409);
    if (d.pass >= 1) return fail("limit", "패스는 하루에 한 번만 할 수 있어요.", 429);
    p.last = p.card; p.card = null; d.pass++;
  } else if (kind === "note") {
    const text = clean(body.text).slice(0, NOTE_MAX);
    if (!text) return fail("empty", "쪽지 내용을 써주세요.");
    if (d.notes >= NOTES_PER_DAY) return fail("limit", `쪽지는 하루에 ${NOTES_PER_DAY}개까지 보낼 수 있어요.`, 429);
    p.notes.push({ text, at: now }); d.notes++;
  } else if (kind === "guess") {
    const gi = Number(body.guess);
    if (!Number.isInteger(gi) || gi < 0 || gi >= room.names.length || gi === i) return fail("guess", "나를 뺀 다른 사람 중에서 골라주세요.");
    p.guess = gi;
  } else return fail("not_found", "없는 기능이에요.", 404);

  if (kind !== "open") await savePerson(env, id, i, p);
  return json({ ...myState(room, i, p, giver, now), first: false });
}

const NO_ROOM = () => fail("no_room", "마니또 방을 찾지 못했어요. 링크를 다시 확인해 주세요.", 404);

export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  // 예전(KV) 방이면 처음 한 번 옮겨 온다
  async room(id) {
    const st = this.ctx.storage;
    let room = await st.get("room");
    if (!room && this.env.OLDKV) {
      const old = await this.env.OLDKV.get("room:" + id, "json");
      if (old) {
        room = { title: old.title, names: old.names, reveal: old.reveal, target: old.target, created: old.created, v: 2 };
        for (const [i, h] of Object.entries(old.pins || {})) await st.put("p:" + i, { pin: h });
        await st.put("room", room);
      }
    }
    return room;
  }
  async fetch(req) {
    const url = new URL(req.url), st = this.ctx.storage;
    const [, id, kind] = url.pathname.split("/");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    if (kind === "init") {
      const r = await create(body || {}, st);
      if (r.ok) await this.ctx.storage.setAlarm(Date.now() + TTL * 1000);
      return r;
    }
    const room = await this.room(id);
    if (!room) return NO_ROOM();
    if (!kind) return json(await publicView(st, id, room, Date.now()));
    return act(body, st, id, kind, room);
  }
  async alarm() { await this.ctx.storage.deleteAll(); } // 45일 뒤 방 삭제
}

const stub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

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
      const m = url.pathname.match(/^\/api\/rooms\/([a-z0-9]{10})(?:\/(open|draw|done|pass|note|guess))?$/);
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
