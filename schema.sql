-- 우리 반 과제함 D1 표 구조 (참고용)
-- 서버(functions/api/[[path]].js)가 첫 요청 때 자동으로 만들기 때문에 직접 실행하지 않아도 돼요.
CREATE TABLE IF NOT EXISTS docs (
  col  TEXT NOT NULL,      -- 종류 (students, todos, submissions ...)
  id   TEXT NOT NULL,      -- 문서 이름
  data TEXT,               -- 내용(JSON). 지운 문서는 NULL
  v    INTEGER NOT NULL,   -- 변경 번호 (실시간 동기화용)
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS docs_v ON docs (v);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0);
CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL);
