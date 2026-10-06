/*
 * db.js — 우리 반 과제함 데이터 연결
 * 서버(/api/...)와 주고받으며, 화면 코드가 쓰는 저장소 모양
 * (collection / doc / onSnapshot / set / update / delete / get)을 그대로 제공해요.
 * 데이터는 모두 Cloudflare D1(서버)에 저장되고, 이 파일은 보여 주기용 사본만 들고 있어요.
 */
(function () {
  "use strict";
  const API = "/api";
  const TOKEN_KEY = "classToken";

  const cache = {};          // { 컬렉션: { 문서id: 데이터 } }
  const listeners = {};      // { 컬렉션: Set(콜백) }
  let since = 0;             // 서버 변경 번호
  let synced = false;        // 첫 동기화가 끝났는지
  let gen = 0;               // 동기화 루프 세대(로그인 바뀌면 새로 시작)
  let token = null;
  let authLostHandler = null;
  let wakeUp = null;

  /* ---------- 토큰(로그인 정보) ---------- */
  function store(remember) { try { return remember ? localStorage : sessionStorage; } catch (e) { return null; } }
  function loadToken() {
    for (const s of [store(true), store(false)]) {
      try { const t = s && s.getItem(TOKEN_KEY); if (t) return t; } catch (e) {}
    }
    return null;
  }
  function saveToken(t, remember) {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    token = t || null;
    if (t) { try { store(!!remember).setItem(TOKEN_KEY, t); } catch (e) {} }
  }
  function parseToken(t) {
    try {
      let p = t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      const o = JSON.parse(atob(p));
      if (o.exp && o.exp < Date.now()) return null;
      return o;
    } catch (e) { return null; }
  }
  const auth = { role: null, no: null };
  function setAuthFromToken() {
    const o = token ? parseToken(token) : null;
    if (!o) { token = null; auth.role = null; auth.no = null; return; }
    auth.role = o.r; auth.no = o.r === "s" ? +o.no : null;
  }

  /* ---------- 서버 요청 ---------- */
  async function req(path, opts) {
    opts = opts || {};
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let r;
    try { r = await fetch(API + path, Object.assign({}, opts, { headers })); }
    catch (e) { const er = new Error("서버에 연결할 수 없어요."); er.code = "unavailable"; throw er; }
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const er = new Error((j && j.error) || ("HTTP " + r.status));
      er.code = (j && j.code) || (r.status === 403 ? "permission_denied" : r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable");
      er.status = r.status; er.retry = j && j.retry;
      if (r.status === 401 && token) { saveToken(null); setAuthFromToken(); restart(); if (authLostHandler) authLostHandler(); }
      throw er;
    }
    return j;
  }

  /* ---------- 화면에 알리기 ---------- */
  function snapOf(col) {
    const o = cache[col] || {};
    const docs = Object.keys(o).sort().map(id => ({ id, exists: true, data: () => o[id], metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(col) {
    const set = listeners[col]; if (!set) return;
    const snap = snapOf(col);
    set.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }
  function emitAll() { Object.keys(listeners).forEach(emit); }

  /* 깊은 합치기 (서버의 json_patch와 같은 규칙: null이면 지움, 배열은 통째로 바꿈) */
  function merge(a, b) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
    const out = (a && typeof a === "object" && !Array.isArray(a)) ? Object.assign({}, a) : {};
    for (const k in b) { if (b[k] === null) delete out[k]; else out[k] = merge(out[k], b[k]); }
    return out;
  }

  /* ---------- 실시간 동기화 (롱 폴링) ---------- */
  const sleep = ms => new Promise(res => { const t = setTimeout(res, ms); wakeUp = () => { clearTimeout(t); res(); }; });
  async function loop(my) {
    let fails = 0;
    while (my === gen) {
      try {
        const hidden = typeof document !== "undefined" && document.hidden;
        const j = await req(`/sync?since=${since}&wait=${synced && !hidden ? 1 : 0}`);
        if (my !== gen) return;
        const touched = new Set();
        for (const x of j.docs) {
          const c = (cache[x.c] = cache[x.c] || {});
          if (x.d === null) delete c[x.i]; else c[x.i] = x.d;
          touched.add(x.c);
        }
        since = j.v;
        if (!synced) { if (j.more) continue; synced = true; emitAll(); }
        else touched.forEach(emit);
        fails = 0;
        if (j.more) continue;
        if (hidden) await sleep(20000);
      } catch (e) {
        if (my !== gen) return;
        fails++;
        await sleep(Math.min(15000, 1500 * fails));
      }
    }
  }
  function restart() {
    gen++; since = 0; synced = false;
    for (const k in cache) delete cache[k];
    loop(gen);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (!document.hidden && wakeUp) wakeUp(); });

  /* ---------- 쓰기 ---------- */
  async function write(op, col, id, data) {
    // 화면에 먼저 반영하고(빠르게 보이도록), 서버에 저장해요.
    const c = (cache[col] = cache[col] || {});
    const before = c[id];
    if (op === "set") c[id] = data;
    else if (op === "update") { if (before === undefined) { const er = new Error("문서가 없어요."); er.code = "invalid_argument"; throw er; } c[id] = merge(before, data); }
    else delete c[id];
    emit(col);
    try {
      await req("/write", { method: "POST", body: JSON.stringify({ op, col, id, data: op === "delete" ? undefined : data }) });
    } catch (e) {
      if (before === undefined) delete c[id]; else c[id] = before;
      emit(col);
      if (e.code === "permission_denied") e.code = "permission_denied";
      throw e;
    }
  }

  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      set: data => write("set", col, id, data),
      update: data => write("update", col, id, data),
      delete: () => write("delete", col, id),
      get: async () => {
        const j = await req(`/doc?col=${encodeURIComponent(col)}&id=${encodeURIComponent(id)}`);
        return { id, exists: !!j.exists, data: () => j.data, metadata: {} };
      },
      onSnapshot: (next) => {
        const fn = snap => { const d = snap.docs.find(x => x.id === id); next({ id, exists: !!d, data: () => d && d.data(), metadata: {} }); };
        return collRef(col).onSnapshot(fn);
      },
    };
  }
  function collRef(col) {
    return {
      path: col,
      doc: id => docRef(col, id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
      add: async data => { const r = docRef(col, Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); await r.set(data); return r; },
      get: async () => {
        const j = await req(`/list?col=${encodeURIComponent(col)}`);
        const docs = j.docs.map(x => ({ id: x.i, exists: true, data: () => x.d, metadata: {} }));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
      },
      onSnapshot: (next) => {
        (listeners[col] = listeners[col] || new Set()).add(next);
        if (synced) setTimeout(() => { if (listeners[col] && listeners[col].has(next)) next(snapOf(col)); }, 0);
        return () => { listeners[col] && listeners[col].delete(next); };
      },
    };
  }

  /* ---------- 공개 기능 ---------- */
  const ClassDB = {
    auth,
    collection: collRef,
    doc: path => { const [c, i] = path.split("/"); return docRef(c, i); },
    onAuthLost: fn => { authLostHandler = fn; },

    /** 서버가 살아 있는지 확인하고 동기화를 시작해요. 실패하면 false */
    async connect() {
      try {
        const r = await fetch(API + "/health", { cache: "no-store" });
        if (!r.ok) return false;
        const j = await r.json();
        ClassDB.health = j;
        if (!j.ok) return false;
      } catch (e) { return false; }
      token = loadToken(); setAuthFromToken();
      restart();
      return true;
    },
    async teacherLogin(password, remember) {
      const j = await req("/login", { method: "POST", body: JSON.stringify({ password, remember: !!remember }) });
      saveToken(j.token, remember); setAuthFromToken(); restart(); return true;
    },
    async studentLogin(no, pin, remember) {
      const j = await req("/student/login", { method: "POST", body: JSON.stringify({ no, pin, remember: !!remember }) });
      saveToken(j.token, remember); setAuthFromToken(); restart(); return true;
    },
    /** 학생 비밀번호 만들기/바꾸기. 바꿀 때는 old(지금 비밀번호)가 필요해요. */
    async studentSetPin(no, pin, old, remember) {
      const keep = (() => { try { return !!localStorage.getItem(TOKEN_KEY); } catch (e) { return false; } })();
      const j = await req("/student/setpin", { method: "POST", body: JSON.stringify({ no, pin, old: old || "", remember: !!(remember || keep) }) });
      if (j.token && auth.role !== "t") { saveToken(j.token, remember || keep); setAuthFromToken(); restart(); }
      return true;
    },
    logout() { saveToken(null); setAuthFromToken(); restart(); },
  };
  window.ClassDB = ClassDB;
})();
