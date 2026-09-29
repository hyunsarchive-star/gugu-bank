// 공용 도우미: 로그인 토큰 만들기/검사, 비밀번호 해시, KV 읽기/쓰기
// (이 파일은 주소(라우트)가 아니라 다른 파일이 가져다 쓰는 부품이에요)

const enc = new TextEncoder();

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

// 비밀 값: 환경변수 SESSION_SECRET 이 없으면 ADMIN_PASSWORD 를 대신 씁니다.
export const secretOf = (env) => env.SESSION_SECRET || env.ADMIN_PASSWORD || '';

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// 토큰 = 내용.서명   (role: 'student' | 'admin')
export async function makeToken(env, role, id) {
  const payload = b64u(enc.encode(JSON.stringify({ r: role, id: id || '', exp: Date.now() + 1000 * 60 * 60 * 24 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secretOf(env)), enc.encode(payload));
  return payload + '.' + b64u(sig);
}

export async function readAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = t.split('.');
  if (!payload || !sig || !secretOf(env)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secretOf(env)), fromB64u(sig), enc.encode(payload));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    if (!p.exp || p.exp < Date.now()) return null;
    return { role: p.r, id: p.id };
  } catch (e) {
    return null;
  }
}

export async function hashPin(env, id, pin) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`${id}:${pin}:${secretOf(env)}`));
  return 'h:' + [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// 길이가 같고 내용이 같은지 (시간차 공격을 줄이는 비교)
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}

// KV 에는 { rev, state } 한 덩어리로 저장해요.
export async function loadDoc(env) {
  const d = await env.BANK.get('state', 'json');
  return d || { rev: 0, state: null };
}
export async function saveDoc(env, doc) {
  await env.BANK.put('state', JSON.stringify(doc));
}

// 브라우저로 보내기 전에 비밀번호(해시)를 가립니다: 설정됨 → '*', 미설정 → ''
export function publicState(state) {
  if (!state) return null;
  const c = JSON.parse(JSON.stringify(state));
  delete c.tpin;
  (c.students || []).forEach((s) => {
    s.pin = s.pin ? '*' : '';
  });
  return c;
}
