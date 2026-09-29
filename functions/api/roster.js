// GET /api/roster  → 로그인 화면에 보여 줄 학생 이름 목록 (로그인 전이라 누구나 볼 수 있어요. 이름만 나가요)
import { json, loadDoc } from '../_lib/util.js';

export async function onRequestGet({ env }) {
  if (!env.BANK) return json({ error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);
  const { state } = await loadDoc(env);
  const list = ((state && state.students) || []).map((s) => ({ id: s.id, name: s.name, hasPin: !!s.pin }));
  return json({ students: list });
}
