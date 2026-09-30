// GET /api/backup  → 교사(admin)만: KV(BANK)에 저장된 현재 전체 데이터를 JSON 파일로 내려 줘요.
//  · 학생 토큰이면 403, 로그인 안 했으면 401, 저장된 데이터가 없으면 404
//  · 아무것도 바꾸지 않아요 (읽기만 해요). 데이터 구조는 KV에 있는 그대로 담고,
//    비밀번호는 원문이 없고 저장된 해시값이 그대로 들어 있어요 (복원용).
import { json, readAuth, loadDoc } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  const au = await readAuth(request, env);
  if (!au) return json({ error: '로그인이 필요해요' }, 401);
  if (au.role !== 'admin') return json({ error: '교사만 백업할 수 있어요' }, 403);
  if (!env.BANK) return json({ error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);
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
