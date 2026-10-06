// GET /api/backup  → 교사(admin)만: KV(BANK)에 저장된 현재 전체 데이터를 JSON 파일로 내려 줘요.
//  · 학생 토큰이면 403, 로그인 안 했으면 401, 저장된 데이터가 없으면 404
//  · 아무것도 바꾸지 않아요 (읽기만 해요). 데이터 구조는 KV에 있는 그대로 담고,
//    비밀번호는 원문이 없고 저장된 해시값이 그대로 들어 있어요 (복원용).
import { json, readAuth, loadDoc } from '../_lib/util.js';

// 서버 안에 보관하는 "가장 최근 백업" 키
const LATEST = 'backup-latest';
const kstOf = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00';

// POST /api/backup → 현재 데이터를 서버(KV)에 백업으로 한 번 저장해요 (파일 다운로드 아님). 바로 다시 읽어 확인해요.
export async function onRequestPost({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ ok: false, error: '로그인이 필요해요' }, 401);
  if (au.role !== 'admin') return json({ ok: false, error: '교사만 백업할 수 있어요' }, 403);
  if (!env.BANK) return json({ ok: false, error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);
  const doc = await loadDoc(env);
  if (!doc.state) return json({ ok: false, error: '백업할 데이터가 아직 없어요' }, 404);
  const now = new Date();
  const copy = JSON.stringify({ app: 'gugu-bank', kind: 'server-backup', backupAt: now.toISOString(), backupAtKST: kstOf(now), rev: doc.rev, state: doc.state });
  try {
    await env.BANK.put(LATEST, copy);
    if ((await env.BANK.get(LATEST)) !== copy) throw new Error('verify');
  } catch (e) {
    return json({ ok: false, error: '서버에 백업을 저장하지 못했어요. 데이터는 그대로예요.' }, 500);
  }
  return json({ ok: true, backupAt: now.toISOString(), backupAtKST: kstOf(now), rev: doc.rev, students: (doc.state.students || []).length, tx: (doc.state.tx || []).length });
}

export async function onRequestGet({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ error: '로그인이 필요해요' }, 401);
  if (au.role !== 'admin') return json({ error: '교사만 백업할 수 있어요' }, 403);
  if (!env.BANK) return json({ error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);
  // GET /api/backup?info=1 → 서버에 저장된 가장 최근 백업의 시각만 알려 줘요
  if (new URL(request.url).searchParams.get('info')) {
    const raw = await env.BANK.get(LATEST);
    if (!raw) return json({ exists: false });
    try {
      const b = JSON.parse(raw);
      return json({ exists: true, backupAt: b.backupAt, backupAtKST: b.backupAtKST, rev: b.rev, students: (b.state.students || []).length, tx: (b.state.tx || []).length });
    } catch (e) {
      return json({ exists: false });
    }
  }
  const doc = await loadDoc(env);
  if (!doc.state) return json({ error: '백업할 데이터가 아직 없어요' }, 404);

  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString(); // 한국 시간
  const stamp = kst.slice(0, 10) + '-' + kst.slice(11, 13) + kst.slice(14, 16); // YYYY-MM-DD-HHmm
  const body = JSON.stringify({ app: 'gugu-bank', backupAt: now.toISOString(), backupAtKST: kst.slice(0, 19) + '+09:00', rev: doc.rev, state: doc.state }, null, 1);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gugu-bank-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
