// 카카오톡 챗봇 본체 — 오픈빌더 폴백 블록이 모든 말을 POST /kakao/skill 로 보낸다.
// 여기서 하는 일: 비밀 키 확인 → 1:1인지 단톡방인지 판별 → 기능(features)에 나눠주기 → 사용자 상태 저장.
//
// ▶ 새 기능 붙이는 법
//   1) features/<이름>.js 를 만든다 (features/fun.js 참고: name, commands, match(c))
//   2) 아래 FEATURES 에 한 줄 추가한다
//   단톡방에서도 쓰게 하려면 match 가 c.group 을 보고 공개해도 되는 내용만 답하면 된다.
import { reply } from "./ui.js";
import * as fun from "./features/fun.js";
import * as manito from "./features/manito.js";

const FEATURES = [fun]; // 정해진 명령에만 반응하는 기능들 (먼저 확인)
// 마니또는 1:1에서 나머지 모든 말을 받는 기본 기능, 단톡방에서는 "마니또 …" 공개 정보만

const LOG_N = 20;

// 단톡방 판별: 카카오 문서에 단톡방 필드가 아직 안 보여서, 있을 법한 자리를 다 본다.
// 확실하지 않을 때를 위해 "/명령"이나 "@봇 명령"으로 부른 말도 단톡방으로 친다 (1:1 버튼은 / 없이 보냄).
function detect(body, raw) {
  const ur = body.userRequest || {};
  const chat = [ur.chat, body.chat, ur.room, ur.chatRoom, body.room, ur.group, body.group].find(x => x && typeof x === "object");
  const t = String(chat?.type ?? chat?.chatType ?? "");
  const byField = chat ? (/group|multi|open|team|단체/i.test(t) || (!!t && !/direct|1:1|private|single|bot/i.test(t))) : false;
  const byPrefix = /^[\/@]/.test(raw);
  return { group: byField || byPrefix, chatId: chat ? String(chat.id ?? chat.chatId ?? chat.roomId ?? "") || null : null };
}
const strip = raw => raw.replace(/^@\S+\s*/, "").replace(/^\/\s*/, "").trim();

export async function kakaoSkill(req, env, X) {
  if (env.KAKAO_KEY && req.headers.get("x-manito-key") !== env.KAKAO_KEY) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => null);
  const ur = body?.userRequest, uid = ur?.user?.id;
  if (!uid) return reply("요청을 읽지 못했어요.");
  const box = name => env.BOX.get(env.BOX.idFromName(name));
  const raw = String(ur.utterance ?? "").trim();
  const c = {
    env, X, ur, body, raw, now: Date.now(), origin: new URL(req.url).origin,
    kid: await X.sha("kakao:" + uid),
    utter: strip(raw),
    ...detect(body, raw),
    sget: async name => (await box(name).fetch("https://box/")).json(),
    sput: (name, v, ifEmpty) => box(name).fetch("https://box/", { method: "POST", body: JSON.stringify({ v, ifEmpty }) }),
  };
  const logP = env.LOG_PAYLOADS === "1" ? log(c, body) : null;
  c.ses = (await c.sget("u:" + c.kid)) || {};
  const before = JSON.stringify(c.ses);
  let res;
  try { res = await dispatch(c); } catch (e) { console.log("skill error", e?.stack || e); res = reply("앗, 문제가 생겼어요. 잠시 뒤 다시 보내주세요.", [], c.group); }
  if (JSON.stringify(c.ses) !== before) await c.sput("u:" + c.kid, c.ses);
  if (logP) await logP;
  res.headers.set("x-took-ms", String(Date.now() - c.now)); // 카톡은 5초 안에 답해야 한다
  return res;
}

async function dispatch(c) {
  const k = c.utter.replace(/[^\p{L}\p{N}]/gu, "");
  // 1:1에서 마니또가 글(쪽지·질문·퀴즈 등)을 기다리는 중이면 다른 기능이 가로채지 않게
  const busy = !c.group && c.ses.mode;
  if (!busy && ["기능", "기능목록", "명령어"].includes(k)) return features(c);
  if (c.group && ["", "도움말", "사용법", "메뉴", "봇"].includes(k)) return features(c);
  if (!busy) for (const f of FEATURES) { const h = f.match(c); if (h) return h(); }
  if (c.group) return (await manito.group(c)) || features(c, "무슨 말인지 모르겠어요.");
  return manito.handle(c);
}

function features(c, head) {
  const lines = [head ? head + "\n" : "", c.group ? "🤖 단톡방에서 이렇게 불러주세요 (앞에 / 붙이기)" : "🤖 이런 걸 할 수 있어요"];
  for (const f of [...FEATURES, manito]) {
    const cmds = c.group ? (f.groupCommands || f.commands) : f.commands;
    if (!cmds?.length) continue;
    lines.push(`\n${f.name}`);
    for (const [cmd, desc] of cmds) lines.push(`· ${c.group ? "/" : ""}${cmd} — ${desc}`);
  }
  if (c.group) lines.push("\n🤫 마니또 비밀 기능(내 대상·미션·쪽지)은 채널 1:1 채팅에서만 돼요.");
  return reply(lines.filter(Boolean).join("\n"), c.group ? [["🎲 주사위", "주사위"], ["🍚 점심 추천", "점심 추천"], ["🎁 마니또 현황", "마니또"]] : [["🏠 마니또 홈", "홈"], ["🎲 주사위", "주사위"], ["🍚 점심 추천", "점심 추천"]], c.group);
}

// 실제 단톡방 요청이 어떻게 생겼는지 확인하려고 최근 요청을 남긴다 (사용자 ID는 지움). GET /kakao/debug 로 본다.
async function log(c, body) {
  const scrub = JSON.parse(JSON.stringify(body, (key, v) => (["id", "botUserKey", "plusfriendUserKey", "appUserId"].includes(key) && typeof v === "string" ? "…" + v.slice(-4) : v)));
  const list = (await c.sget("log")) || [];
  list.push({ at: new Date(c.now).toISOString(), group: c.group, chatId: c.chatId, raw: c.raw, body: scrub });
  await c.sput("log", list.slice(-LOG_N));
}
export async function kakaoDebug(req, env) {
  if (!env.KAKAO_KEY || req.headers.get("x-manito-key") !== env.KAKAO_KEY) return new Response("forbidden", { status: 403 });
  const r = await env.BOX.get(env.BOX.idFromName("log")).fetch("https://box/");
  return new Response(JSON.stringify(await r.json(), null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
