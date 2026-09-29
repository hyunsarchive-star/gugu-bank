// POST /api/login  { id, pin }  → 학생 로그인.
//  · 아직 비밀번호가 없으면 입력한 값이 그 학생의 비밀번호로 저장돼요 (처음 로그인 때 직접 만들기)
//  · 비밀번호는 해시로만 저장되고, 브라우저로는 절대 내려가지 않아요
import { json, makeToken, hashPin, loadDoc, saveDoc, safeEqual } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  if (!env.BANK) return json({ error: 'KV 바인딩(BANK)이 연결되지 않았어요' }, 500);
  let b = {};
  try { b = await request.json(); } catch (e) {}
  const id = String(b.id || ''), pin = String(b.pin || '').trim();
  const doc = await loadDoc(env);
  const s = doc.state && doc.state.students.find((x) => x.id === id);
  if (!s) return json({ error: '이름을 선택하세요' }, 404);
  if (!pin) return json({ error: '비밀번호를 입력하세요' }, 400);
  const h = await hashPin(env, id, pin);
  if (!s.pin) {
    if (pin.length < 4) return json({ error: '비밀번호는 4자 이상으로 만들어요' }, 400);
    s.pin = h;
    doc.rev += 1;
    await saveDoc(env, doc);
  } else if (!safeEqual(s.pin, h)) {
    return json({ error: '비밀번호가 달라요' }, 401);
  }
  return json({ token: await makeToken(env, 'student', id) });
}
