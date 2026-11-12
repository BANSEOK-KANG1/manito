// 마니또 API — 방을 만들 때 서버가 직접 뽑고, 각자 이름+비밀번호로 자기 결과만 받는다.
const TTL = 60 * 60 * 24 * 45; // 45일 뒤 자동 삭제
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

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
async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const clean = s => String(s ?? "").trim().replace(/\s+/g, " ");

async function load(env, id) {
  if (!/^[a-z0-9]{10}$/.test(id)) return null;
  return await env.MANITO.get("room:" + id, "json");
}
const save = (env, id, room) => env.MANITO.put("room:" + id, JSON.stringify(room), { expirationTtl: TTL });

function publicView(room, now) {
  const out = {
    title: room.title, names: room.names, reveal: room.reveal, now,
    claimed: room.names.map((_, i) => !!room.pins[i]),
  };
  if (now >= room.reveal) out.result = room.names.map((n, i) => [n, room.names[room.target[i]]]);
  return out;
}

async function create(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return fail("bad_json", "요청을 읽지 못했어요.");
  const names = (body.names || []).map(clean).filter(Boolean);
  if (names.length < 3 || names.length > 30) return fail("count", "참가자는 3명에서 30명 사이여야 해요.");
  if (names.some(n => n.length > 20)) return fail("long", "이름은 20자까지 쓸 수 있어요.");
  if (new Set(names).size !== names.length) return fail("dup", "같은 이름이 있어요. 성이나 별명을 붙여 구분해 주세요.");
  const reveal = Number(body.reveal);
  if (!Number.isFinite(reveal)) return fail("reveal", "공개 시각을 다시 골라주세요.");
  const title = clean(body.title).slice(0, 30) || "우리 마니또";

  // 무작위 순서로 원을 만들고 각자 다음 사람을 챙김 → 자기 자신·서로 맞바꾸기 없음
  const order = names.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = randInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
  const target = new Array(names.length);
  order.forEach((p, k) => { target[p] = order[(k + 1) % order.length]; });

  let id = newId();
  for (let t = 0; t < 3 && (await env.MANITO.get("room:" + id)); t++) id = newId();
  const room = { title, names, reveal, target, pins: {}, fails: {}, created: Date.now() };
  await save(env, id, room);
  return json({ id });
}

async function open(req, env, id) {
  const room = await load(env, id);
  if (!room) return fail("no_room", "마니또 방을 찾지 못했어요. 링크를 다시 확인해 주세요.", 404);
  const body = await req.json().catch(() => null);
  const i = Number(body?.who), pin = String(body?.pin ?? "");
  if (!Number.isInteger(i) || i < 0 || i >= room.names.length) return fail("who", "이름을 다시 골라주세요.");
  if (!/^\d{4}$/.test(pin)) return fail("pin", "비밀번호는 숫자 4자리예요.");
  const now = Date.now();
  const f = room.fails[i] || { n: 0, until: 0 };
  if (f.until > now) return fail("locked", `비밀번호를 여러 번 틀려서 잠시 잠겼어요. ${Math.ceil((f.until - now) / 60000)}분 뒤에 다시 해주세요.`, 429);

  const h = await sha(`${id}:${i}:${pin}`);
  let first = false;
  if (!room.pins[i]) {
    if (body.claim !== true) return fail("unclaimed", "아직 비밀번호가 없어요. 새로 정해주세요.", 409);
    room.pins[i] = h; first = true;
    await save(env, id, room);
  } else if (room.pins[i] !== h) {
    f.n += 1; if (f.n >= MAX_FAILS) { f.until = now + LOCK_MS; f.n = 0; }
    room.fails[i] = f; await save(env, id, room);
    return fail("wrong_pin", body.claim ? "이 이름은 이미 누군가 비밀번호를 정했어요. 본인이 정한 적 없다면 단톡방에 알려주세요." : "비밀번호가 맞지 않아요.", 403);
  } else if (f.n) { room.fails[i] = { n: 0, until: 0 }; await save(env, id, room); }

  return json({ me: room.names[i], target: room.names[room.target[i]], first });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/api/rooms" && req.method === "POST") return await create(req, env);
      const m = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/open)?$/);
      if (m && !m[2] && req.method === "GET") {
        const room = await load(env, m[1]);
        return room ? json(publicView(room, Date.now())) : fail("no_room", "마니또 방을 찾지 못했어요. 링크를 다시 확인해 주세요.", 404);
      }
      if (m && m[2] && req.method === "POST") return await open(req, env, m[1]);
      if (url.pathname === "/") return new Response("manito api", { headers: cors });
      return fail("not_found", "없는 주소예요.", 404);
    } catch (e) {
      return fail("server", "서버에서 문제가 생겼어요. 잠시 뒤 다시 해주세요.", 500);
    }
  },
};
