/*
 * 우리 반 과제함 — 서버 (Cloudflare Pages Functions + D1)
 * 주소: /api/...  (이 파일 하나가 /api 아래 모든 요청을 처리해요)
 *
 * 필요한 설정 (Cloudflare 대시보드 → Pages 프로젝트 → 설정)
 *   - D1 데이터베이스 바인딩 이름: DB
 *   - 환경변수 ADMIN_PASSWORD : 선생님 비밀번호 (필수)
 *   - 환경변수 SESSION_SECRET : 로그인 토큰 서명용 아무 긴 문자열 (선택, 권장)
 * 표(table)는 첫 요청 때 자동으로 만들어져요.
 */

/* ---------- 컬렉션과 권한 ---------- */
const ALL_COLS = ["students", "assignments", "submissions", "notices", "exams", "retakes", "records",
  "ideas", "ideaAnswers", "todos", "todoDone", "pins", "pinsPlain", "secret", "backupInfo", "photos", "backups", "links", "dayoff", "absent", "dms", "dmDone", "tchk", "seen"];
const ADMIN_READ = new Set(["records", "pinsPlain", "secret", "backups", "backupInfo", "tchk"]); // 선생님만 읽기
const PUBLIC_READ = new Set(["students", "pins"]);                                       // 로그인 전에도 읽기 (이름 고르기용)
const STUDENT_WRITE = new Set(["submissions", "photos", "notices", "retakes", "ideaAnswers", "todoDone", "absent", "dmDone", "seen"]);
const NO_SYNC = new Set(["photos", "backups"]);                                          // 크기가 커서 필요할 때만 불러와요
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_BYTES = 1900000;

/* ---------- 공통 ---------- */
const enc = new TextEncoder();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const fail = (status, code, error, extra) => json(Object.assign({ error, code }, extra || {}), status);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function b64u(bytes) {
  let s = ""; const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
// 학생 비밀번호 저장 방식 (Claude 버전 백업 파일과 호환)
const pinHash = (no, pin) => sha256hex(`ourclass:${no}:${pin}`);

/* ---------- 표 만들기 (처음 한 번) ---------- */
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT, v INTEGER NOT NULL, PRIMARY KEY (col, id))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_v ON docs (v)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)"),
  ]);
  ready = true;
}

/* ---------- 로그인 토큰 ---------- */
function secretOf(env) { return env.SESSION_SECRET || ("pw:" + (env.ADMIN_PASSWORD || "")); }
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secretOf(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function makeToken(env, payload, remember) {
  const exp = Date.now() + (remember ? 30 : 0.5) * 24 * 3600 * 1000; // 기억하기 30일, 아니면 12시간
  const p = b64u(enc.encode(JSON.stringify(Object.assign({}, payload, { exp }))));
  return p + "." + await hmac(env, p);
}
async function readToken(env, request) {
  const h = request.headers.get("Authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t || !env.ADMIN_PASSWORD) return null;
  const [p, sig] = t.split(".");
  if (!p || !sig || !sameText(sig, await hmac(env, p))) return null;
  try { const o = JSON.parse(fromB64u(p)); if (!o.exp || o.exp < Date.now()) return null; return o; } catch (e) { return null; }
}

/* ---------- 문서 읽기 ---------- */
async function getDoc(env, col, id) {
  const row = await env.DB.prepare("SELECT data FROM docs WHERE col = ?1 AND id = ?2 AND data IS NOT NULL").bind(col, id).first();
  return row ? JSON.parse(row.data) : null;
}
function canRead(role, col) {
  if (ADMIN_READ.has(col)) return role === "t";
  if (PUBLIC_READ.has(col)) return true;
  return role === "t" || role === "s";
}

/* ---------- 쓰기 (변경 번호를 하나 올리면서 저장) ---------- */
async function exec(env, op, col, id, data) {
  const bump = env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'");
  let stmt;
  if (op === "set") {
    stmt = env.DB.prepare("INSERT INTO docs (col, id, data, v) VALUES (?1, ?2, ?3, (SELECT v FROM meta WHERE k = 'seq')) " +
      "ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, v = excluded.v").bind(col, id, JSON.stringify(data));
  } else if (op === "update") {
    stmt = env.DB.prepare("UPDATE docs SET data = json_patch(data, ?3), v = (SELECT v FROM meta WHERE k = 'seq') " +
      "WHERE col = ?1 AND id = ?2 AND data IS NOT NULL").bind(col, id, JSON.stringify(data));
  } else {
    stmt = env.DB.prepare("UPDATE docs SET data = NULL, v = (SELECT v FROM meta WHERE k = 'seq') " +
      "WHERE col = ?1 AND id = ?2 AND data IS NOT NULL").bind(col, id);
  }
  const res = await env.DB.batch([bump, stmt]);
  return res[1].meta.changes || 0;
}

/* ---------- 학생 권한 확인 ---------- */
async function isCheckerOf(env, tid, no) {
  const t = await getDoc(env, "todos", tid);
  if (!t) return false;
  const list = [...(t.checkers || []), ...(t.checker ? [t.checker] : [])];
  const today = todayKST();
  return list.some(c => c && +c.no === no && (!c.until || c.until >= today));
}
async function isAnyChecker(env, no) {
  const { results } = await env.DB.prepare("SELECT data FROM docs WHERE col = 'todos' AND data IS NOT NULL").all();
  const today = todayKST();
  return results.some(r => { const t = JSON.parse(r.data); const list = [...(t.checkers || []), ...(t.checker ? [t.checker] : [])];
    return list.some(c => c && +c.no === no && (!c.until || c.until >= today)); });
}
const onlyKeys = (obj, keys) => obj && typeof obj === "object" && Object.keys(obj).every(k => keys.includes(k));
const heartsOnlyMine = (h, no) => h && typeof h === "object" && Object.keys(h).every(k => k === "s" + no);

async function studentAllowed(env, no, op, col, id, data) {
  const own = id.endsWith("__" + no);
  switch (col) {
    case "todoDone": {
      const tid = id.split("__")[0];
      if (own) {
        if (op === "delete") return true;
        if (data && data.no !== undefined && +data.no !== no) return false;
        if (!data || !data.by || data.by === "s") return true;
        return await isCheckerOf(env, tid, no);          // 자기 칸을 도우미로 확인하는 경우
      }
      return await isCheckerOf(env, tid, no);              // 검사 도우미만 다른 친구 칸을 바꿀 수 있어요
    }
    case "submissions": {
      if (own) {
        if (op === "delete") return true;
        if (op === "set") return +data.no === no && data.status === "submitted" && !data.stamp && !data.feedback;
        return onlyKeys(data, ["text", "title", "link", "hasPhoto", "editedAt", "editedBy", "hearts"]) && (!data.hearts || heartsOnlyMine(data.hearts, no));
      }
      return op === "update" && onlyKeys(data, ["hearts"]) && heartsOnlyMine(data.hearts, no); // 친구 글에는 좋아요만
    }
    case "photos": return own;
    case "seen": return id === String(no) && op !== "delete" && onlyKeys(data, ["no", "links", "todo"]) && (data.no === undefined || +data.no === no); // 새 글 확인 시각
    case "dmDone": return own && (op === "delete" || (data && +data.no === no && data.by === "s")); // 개별 알림: 자기 것만 '했어요'
    case "absent": return (op === "delete" || (data && /^\d{4}-\d{2}-\d{2}__\d+$/.test(id) && +data.no === +id.split("__")[1])) && await isAnyChecker(env, no); // 검사 도우미만 결석 처리
    case "ideaAnswers": return own && (op === "delete" || +data.no === no);
    case "notices": return own && op === "update" && onlyKeys(data, ["read"]);
    case "retakes": {
      if (op !== "set" || +data.no !== no || data.status !== "pending") return false;
      const cur = await getDoc(env, "retakes", id);
      return !cur || +cur.no === no;
    }
    default: return false;
  }
}

/* ---------- 로그인 실패 횟수 제한 ---------- */
async function checkLock(env, key) {
  const row = await env.DB.prepare("SELECT n, t FROM attempts WHERE k = ?1").bind(key).first();
  if (row && row.n >= 5 && Date.now() - row.t < 30000) return Math.ceil((30000 - (Date.now() - row.t)) / 1000);
  return 0;
}
async function addFail(env, key) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO attempts (k, n, t) VALUES (?1, 1, ?2) ON CONFLICT (k) DO UPDATE SET " +
    "n = CASE WHEN ?2 - attempts.t > 300000 OR attempts.n >= 5 THEN 1 ELSE attempts.n + 1 END, t = ?2").bind(key, now).run();
}
const clearFail = (env, key) => env.DB.prepare("DELETE FROM attempts WHERE k = ?1").bind(key).run();

/* ---------- 요청 처리 ---------- */
export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return fail(500, "no_db", "D1 데이터베이스가 연결되지 않았어요. Pages 설정에서 바인딩 이름 DB로 연결해 주세요.");
    await init(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const method = request.method.toUpperCase();
    const body = method === "POST" ? await request.json().catch(() => ({})) : {};
    const tok = await readToken(env, request);
    const role = tok ? tok.r : null;

    /* 서버 상태 */
    if (path === "health") return json({ ok: true, configured: !!env.ADMIN_PASSWORD });

    /* 선생님 로그인 */
    if (path === "login" && method === "POST") {
      if (!env.ADMIN_PASSWORD) return fail(500, "not_configured", "환경변수 ADMIN_PASSWORD가 설정되지 않았어요.");
      const wait = await checkLock(env, "t");
      if (wait) return fail(429, "rate_limited", `여러 번 틀려서 ${wait}초 뒤에 다시 넣을 수 있어요.`, { retry: wait });
      const ok = sameText(await sha256hex(String(body.password || "")), await sha256hex(env.ADMIN_PASSWORD));
      if (!ok) { await addFail(env, "t"); return fail(403, "wrong_password", "비밀번호가 맞지 않아요."); }
      await clearFail(env, "t");
      return json({ token: await makeToken(env, { r: "t" }, body.remember) });
    }

    /* 학생 로그인 */
    if (path === "student/login" && method === "POST") {
      const no = +body.no;
      if (!no) return fail(400, "invalid_argument", "번호가 없어요.");
      const key = "s:" + no;
      const wait = await checkLock(env, key);
      if (wait) return fail(429, "rate_limited", `여러 번 틀려서 ${wait}초 뒤에 다시 넣을 수 있어요.`, { retry: wait });
      const pin = await getDoc(env, "pins", String(no));
      if (!pin) return fail(404, "no_pin", "아직 비밀번호가 없어요. 새로 만들어 주세요.");
      if (!sameText(await pinHash(no, String(body.pin || "")), pin.hash)) { await addFail(env, key); return fail(403, "wrong_password", "비밀번호가 맞지 않아요."); }
      await clearFail(env, key);
      return json({ token: await makeToken(env, { r: "s", no, ps: pin.setAt || "" }, body.remember) });
    }

    /* 학생 비밀번호 만들기 / 바꾸기 */
    if (path === "student/setpin" && method === "POST") {
      const no = +body.no; const pinTxt = String(body.pin || "");
      if (!no || !/^\d{4,6}$/.test(pinTxt)) return fail(400, "invalid_argument", "비밀번호는 숫자 4~6자리로 정해 주세요.");
      if (!(await getDoc(env, "students", String(no)))) return fail(404, "not_found", "명단에 없는 번호예요.");
      const cur = await getDoc(env, "pins", String(no));
      if (cur && role !== "t") {
        const key = "s:" + no;
        const wait = await checkLock(env, key);
        if (wait) return fail(429, "rate_limited", `여러 번 틀려서 ${wait}초 뒤에 다시 넣을 수 있어요.`, { retry: wait });
        if (!sameText(await pinHash(no, String(body.old || "")), cur.hash)) { await addFail(env, key); return fail(403, "wrong_password", "지금 비밀번호가 맞지 않아요."); }
      }
      const setAt = new Date().toISOString();
      await exec(env, "set", "pins", String(no), { hash: await pinHash(no, pinTxt), setAt });
      return json({ ok: true, token: await makeToken(env, { r: "s", no, ps: setAt }, body.remember) });
    }

    /* 실시간 동기화: since 이후에 바뀐 문서만 돌려줘요 (wait=1이면 최대 20초 기다림) */
    if (path === "sync" && method === "GET") {
      const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);
      const wait = url.searchParams.get("wait") === "1";
      const cols = ALL_COLS.filter(c => !NO_SYNC.has(c) && canRead(role, c));
      const marks = cols.map((_, i) => "?" + (i + 2)).join(",");
      const q = env.DB.prepare(
        `SELECT col, id, v, CASE WHEN col = 'pins' AND data IS NOT NULL THEN json_object('set', 1, 'setAt', json_extract(data, '$.setAt')) ELSE data END AS data ` +
        `FROM docs WHERE v > ?1 AND col IN (${marks}) ORDER BY v LIMIT 1000`);
      const deadline = Date.now() + 20000;
      for (;;) {
        const seqRow = await env.DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first();
        const seq = seqRow ? seqRow.v : 0;
        if (seq > since) {
          const { results } = await q.bind(since, ...cols).all();
          if (results.length || !wait || Date.now() > deadline) {
            const more = results.length === 1000;
            const v = more ? results[results.length - 1].v : seq;
            const docs = results.map(r => `{"c":${JSON.stringify(r.col)},"i":${JSON.stringify(r.id)},"d":${r.data === null ? "null" : r.data}}`);
            return new Response(`{"v":${v},"more":${more},"docs":[${docs.join(",")}]}`, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
          }
          // 이 사람이 볼 수 없는 문서만 바뀐 경우: 번호만 따라가요
          return json({ v: seq, more: false, docs: [] });
        }
        if (!wait || Date.now() > deadline) return json({ v: Math.max(seq, since), more: false, docs: [] });
        await sleep(1500);
      }
    }

    /* 컬렉션 전체 읽기 (사진, 백업 등) */
    if (path === "list" && method === "GET") {
      const col = url.searchParams.get("col") || "";
      if (!ALL_COLS.includes(col)) return fail(400, "invalid_argument", "알 수 없는 컬렉션이에요.");
      if (!canRead(role, col)) return fail(403, "permission_denied", "볼 수 있는 권한이 없어요.");
      const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE col = ?1 AND data IS NOT NULL").bind(col).all();
      const strip = col === "pins" && role !== "t";
      const docs = results.map(r => `{"i":${JSON.stringify(r.id)},"d":${strip ? JSON.stringify({ set: 1, setAt: (JSON.parse(r.data).setAt || "") }) : r.data}}`);
      return new Response(`{"docs":[${docs.join(",")}]}`, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    }

    /* 문서 하나 읽기 */
    if (path === "doc" && method === "GET") {
      const col = url.searchParams.get("col") || ""; const id = url.searchParams.get("id") || "";
      if (!ALL_COLS.includes(col) || !ID_RE.test(id)) return fail(400, "invalid_argument", "주소가 올바르지 않아요.");
      if (!canRead(role, col)) return fail(403, "permission_denied", "볼 수 있는 권한이 없어요.");
      let d = await getDoc(env, col, id);
      if (d && col === "pins" && role !== "t") d = { set: 1, setAt: d.setAt || "" };
      return json({ exists: !!d, data: d });
    }

    /* 저장 / 고치기 / 지우기 */
    if (path === "write" && method === "POST") {
      const { op, col, id } = body; const data = body.data;
      if (!["set", "update", "delete"].includes(op)) return fail(400, "invalid_argument", "알 수 없는 작업이에요.");
      if (!ALL_COLS.includes(col) || typeof id !== "string" || !ID_RE.test(id)) return fail(400, "invalid_argument", "주소가 올바르지 않아요.");
      if (op !== "delete" && (!data || typeof data !== "object" || Array.isArray(data))) return fail(400, "invalid_argument", "저장할 내용이 올바르지 않아요.");
      if (op !== "delete" && enc.encode(JSON.stringify(data)).length > MAX_BYTES) return fail(413, "too_large", "내용이 너무 커요.");
      if (!role) return fail(401, "not_logged_in", "먼저 로그인해 주세요.");
      if (role === "s") {
        if (col === "pins" || !STUDENT_WRITE.has(col)) return fail(403, "permission_denied", "저장할 수 있는 권한이 없어요.");
        // 선생님이 비밀번호를 초기화했으면 예전 로그인은 더 이상 쓸 수 없어요
        const pin = await getDoc(env, "pins", String(tok.no));
        if (!pin || (pin.setAt || "") !== (tok.ps || "")) return fail(401, "session_expired", "다시 로그인해 주세요.");
        if (!(await studentAllowed(env, +tok.no, op, col, id, data))) return fail(403, "permission_denied", "저장할 수 있는 권한이 없어요.");
      }
      const changes = await exec(env, op, col, id, data);
      if (op === "update" && !changes) return fail(404, "invalid_argument", "고칠 문서가 없어요.");
      return json({ ok: true });
    }

    return fail(404, "not_found", "없는 주소예요.");
  } catch (e) {
    return fail(500, "server_error", "서버에서 문제가 생겼어요: " + (e && e.message ? e.message : String(e)));
  }
}
