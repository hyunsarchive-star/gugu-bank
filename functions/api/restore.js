// POST /api/restore  { backup: <백업 파일 내용(JSON)> }  → 교사(admin)만.
// 순서:  ① 교사 확인 → ② 백업 파일 검증 → ③ 현재 데이터를 안전 백업(KV 별도 키)에 저장하고 다시 읽어 확인
//        → ④ 그때서야 BANK 의 state 를 백업 내용으로 교체 (rev 는 현재보다 크게)
// ②③ 중 하나라도 실패하면 현재 데이터는 전혀 바뀌지 않아요.
import { json, readAuth, loadDoc, saveDoc } from '../_lib/util.js';

const ARR = ['auctions', 'students', 'tx', 'deps', 'stocks', 'orders', 'props', 'preq', 'sh', 'ord', 'trades', 'news', 'jobs', 'apps', 'assign', 'ptx', 'gigs', 'splits', 'officers'];
const OBJ = ['mkt', 'snap', 'sdisc', 'job', 'catalog'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 문제가 있으면 한국어 문장을, 괜찮으면 null 을 돌려줘요.
function validate(b) {
  if (!isObj(b)) return '백업 파일 내용이 올바르지 않아요';
  if (b.app !== 'gugu-bank') return '고구마은행에서 만든 백업 파일이 아니에요';
  if (!('state' in b)) return '이 파일은 복원할 수 없는 형식이에요 (구형 백업이거나 「데이터 백업」으로 만든 파일이 아니에요)';
  if (typeof b.rev !== 'number' || !Number.isInteger(b.rev) || b.rev < 0) return '백업 파일에 저장 번호(rev)가 없어요';
  if (typeof b.backupAt !== 'string' || isNaN(Date.parse(b.backupAt))) return '백업 파일에 백업 시각이 없어요';
  const s = b.state;
  if (!isObj(s)) return '백업 데이터(state)가 비어 있거나 올바르지 않아요';
  for (const k of ARR) if (k in s && !Array.isArray(s[k])) return `백업 데이터의 「${k}」 형식이 올바르지 않아요`;
  for (const k of OBJ) if (k in s && s[k] !== null && !isObj(s[k])) return `백업 데이터의 「${k}」 형식이 올바르지 않아요`;
  if (!Array.isArray(s.students) || !Array.isArray(s.tx)) return '학생 또는 통장 기록이 없는 백업이에요';
  if ('month' in s && typeof s.month !== 'string') return '백업 데이터의 「month」 형식이 올바르지 않아요';
  const ids = new Set();
  for (const st of s.students) {
    if (!isObj(st) || typeof st.id !== 'string' || !st.id || typeof st.name !== 'string') return '학생 정보 형식이 올바르지 않아요';
    if (ids.has(st.id)) return '학생 번호가 겹쳐요';
    ids.add(st.id);
    const p = st.pin == null ? '' : st.pin;
    if (typeof p !== 'string' || !(p === '' || /^h:[0-9a-f]{64}$/.test(p))) return '학생 비밀번호 정보가 올바르지 않아요 (이 앱의 백업 파일이 아니에요)';
  }
  for (const t of s.tx) {
    if (!isObj(t) || typeof t.sid !== 'string' || !['in', 'out'].includes(t.type) || typeof t.amt !== 'number' || !isFinite(t.amt)) return '통장 기록 형식이 올바르지 않아요';
  }
  for (const k of ['stocks', 'props', 'sh']) for (const x of s[k] || []) if (!isObj(x)) return `「${k}」 항목 형식이 올바르지 않아요`;
  return null;
}

export async function onRequestPost({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ ok: false, error: '로그인이 필요해요' }, 401);
  if (au.role !== 'admin') return json({ ok: false, error: '교사만 복원할 수 있어요' }, 403);
  if (!env.BANK) return json({ ok: false, error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);

  let body;
  try {
    const txt = await request.text();
    if (txt.length > 20 * 1024 * 1024) return json({ ok: false, error: '파일이 너무 커요' }, 413);
    body = JSON.parse(txt);
  } catch (e) {
    return json({ ok: false, error: '잘못된 요청이에요' }, 400);
  }
  const backup = body && body.backup;

  // ② 검증 (실패하면 여기서 끝, 아무것도 바꾸지 않음)
  const bad = validate(backup);
  if (bad) return json({ ok: false, error: bad }, 422);

  // ③ 현재 데이터 안전 백업
  const cur = await loadDoc(env);
  let safetyKey = null;
  if (cur.state) {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
    safetyKey = `safety-${kst.slice(0, 10)}-${kst.slice(11, 13)}${kst.slice(14, 16)}${kst.slice(17, 19)}-rev${cur.rev}`;
    const copy = JSON.stringify({ app: 'gugu-bank', kind: 'safety-before-restore', backupAt: now.toISOString(), rev: cur.rev, state: cur.state });
    try {
      await env.BANK.put(safetyKey, copy);
      const back = await env.BANK.get(safetyKey);
      if (back !== copy) throw new Error('verify');
    } catch (e) {
      return json({ ok: false, error: '현재 데이터를 안전하게 보관하지 못해서 복원을 중단했어요. 데이터는 그대로예요.' }, 500);
    }
  }

  // ④ 교체 (rev 는 현재보다 반드시 크게)
  const state = backup.state;
  delete state.tpin;
  state.students.forEach((s) => {
    s.pin = s.pin || '';
  });
  const rev = cur.rev + 1;
  try {
    await saveDoc(env, { rev, state });
  } catch (e) {
    return json({ ok: false, error: '저장에 실패했어요. 데이터는 그대로예요.' }, 500);
  }
  return json({ ok: true, rev, safetyKey, students: state.students.length, tx: state.tx.length, backupAt: backup.backupAt, backupRev: backup.rev });
}
