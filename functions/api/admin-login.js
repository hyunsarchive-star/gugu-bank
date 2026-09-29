// POST /api/admin-login  { password }  → 교사 로그인. 비밀번호는 환경변수 ADMIN_PASSWORD 와 비교해요.
import { json, makeToken, safeEqual } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: '서버에 ADMIN_PASSWORD 환경변수가 없어요' }, 500);
  let b = {};
  try { b = await request.json(); } catch (e) {}
  if (!safeEqual(b.password || '', env.ADMIN_PASSWORD)) return json({ error: '비밀번호가 달라요' }, 401);
  return json({ token: await makeToken(env, 'admin') });
}
