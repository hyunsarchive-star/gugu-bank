// GET /api/state[?since=번호]  → 전체 데이터 (로그인 필요)
// PUT /api/state  { baseRev, state } → 저장 (로그인 필요). 그 사이 다른 사람이 저장했으면 409 를 돌려줘요.
import { json, readAuth, loadDoc, saveDoc, publicState } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ error: '로그인이 필요해요' }, 401);
  const doc = await loadDoc(env);
  const since = new URL(request.url).searchParams.get('since');
  if (since !== null && +since === doc.rev) return json({ rev: doc.rev, same: true });
  return json({ rev: doc.rev, state: publicState(doc.state) });
}

// 학생은 교사만 바꿀 수 있는 항목(시장 열기/닫기, 종목·시세, 직업 목록, 수입처 등)을 바꿀 수 없어요.
const TEACHER_ONLY = ['mkt', 'catalog', 'officers', 'phase', 'month', 'sdisc', 'jobs', 'job', 'splits', 'stocks', 'students'];

export async function onRequestPut({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ error: '로그인이 필요해요' }, 401);
  let b = {};
  try { b = await request.json(); } catch (e) { return json({ error: '잘못된 요청' }, 400); }
  if (!b.state || typeof b.state !== 'object' || !Array.isArray(b.state.students)) return json({ error: '잘못된 데이터' }, 400);
  const doc = await loadDoc(env);
  if (doc.rev !== b.baseRev) return json({ error: 'conflict', rev: doc.rev }, 409);

  const old = doc.state;
  const next = b.state;
  delete next.tpin; // 교사 비밀번호는 데이터에 저장하지 않아요 (환경변수 ADMIN_PASSWORD)

  if (au.role === 'admin') {
    // 비밀번호(해시)는 서버가 지켜요: '*' = 그대로, '' = 초기화(학생이 다시 만듦)
    const oldPin = {};
    ((old && old.students) || []).forEach((s) => (oldPin[s.id] = s.pin || ''));
    next.students.forEach((s) => {
      s.pin = s.pin === '' ? '' : oldPin[s.id] || '';
    });
  } else {
    if (!old) return json({ error: '교사가 아직 학생을 등록하지 않았어요' }, 403);
    TEACHER_ONLY.forEach((k) => {
      next[k] = old[k];
    });
  }
  const rev = doc.rev + 1;
  await saveDoc(env, { rev, state: next });
  return json({ rev });
}
