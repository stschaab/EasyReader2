-- EasyReader2 – Datenbankschema
-- SQLite (Cloudflare D1)
-- Legend:
--   * Alle Tabellen haben INTEGER PRIMARY KEY (D1 auto-increments)
--   * Timestamps als ISO 8601 TEXT (SQLite hat keinen echten DATETIME)
--   * user_id Spalten sind überall vorhanden für späteren OAuth (Default: 'anon')

-- ═══════════════════════════════════════════════════════════════
-- SPRACHEN
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS languages (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- 'ru', 'zh', 'es', 'de', 'en'
  name TEXT NOT NULL,                 -- 'Русский'
  tts_lang TEXT NOT NULL,             -- 'ru-RU' für SpeechSynthesis
  wiktionary_lang TEXT NOT NULL,      -- 'ru' für Wiktionary API
  level_system TEXT NOT NULL DEFAULT 'CEFR',  -- 'CEFR' oder 'HSK'
  word_regex TEXT NOT NULL,           -- '[А-Яа-яЁё]+' für Wort-Erkennung
  created_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- BÜCHER / KAPITEL / CHUNKS
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY,
  language_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  source_url TEXT,
  edition TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (language_id) REFERENCES languages(id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL,
  volume INTEGER DEFAULT 1,           -- Том (Band)
  part INTEGER DEFAULT 1,             -- Часть (Teil)
  chapter_num INTEGER NOT NULL,       -- Kapitel-Nummer
  title TEXT,                         -- Kapiteltitel (optional)
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL,
  chapter_id INTEGER,
  order_index INTEGER NOT NULL,       -- Reihenfolge im Buch
  original_text TEXT NOT NULL,
  word_count INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (chapter_id) REFERENCES chapters(id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_id, order_index);

-- ═══════════════════════════════════════════════════════════════
-- VEREINFACHUNGEN (Cache + RAG-Ergebnisse)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS simplifications (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL,
  level TEXT NOT NULL,                -- 'C1','B2','B1','A2'
  simplified_text TEXT NOT NULL,
  method TEXT DEFAULT 'zeroshot',     -- 'zeroshot' | 'rag' | 'manual'
  model TEXT DEFAULT 'glm-4.5-flash',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(chunk_id, level),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

-- ═══════════════════════════════════════════════════════════════
-- WORTLISTE (Häufigkeitsbasiert, Hingston)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY,
  language_id INTEGER NOT NULL,
  lemma TEXT NOT NULL,                -- Grundform (vorerst: rohe Form, später lemmatisiert)
  rank INTEGER NOT NULL,              -- Häufigkeitsrang (1 = häufigstes Wort)
  cefr_level TEXT,                    -- 'A1','A2','B1','B2','C1','C2' – aus rank abgeleitet
  UNIQUE(language_id, lemma),
  FOREIGN KEY (language_id) REFERENCES languages(id)
);
CREATE INDEX IF NOT EXISTS idx_words_lang_lemma ON words(language_id, lemma);
CREATE INDEX IF NOT EXISTS idx_words_lang_level ON words(language_id, cefr_level);

-- ═══════════════════════════════════════════════════════════════
-- CHUNK-WÖRTER (welche Wörter in welchem Chunk, mit Level)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chunk_words (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  position INTEGER,                   -- Position im Chunk (für Sortierung)
  inflected_form TEXT,                -- Originalform im Text (vor Lemmatisierung)
  UNIQUE(chunk_id, word_id, position),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);
CREATE INDEX IF NOT EXISTS idx_chunk_words_chunk ON chunk_words(chunk_id);

-- ═══════════════════════════════════════════════════════════════
-- GRAMMATIK (PLATZHALTER – später befüllen)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS grammar_points (
  id INTEGER PRIMARY KEY,
  language_id INTEGER NOT NULL,
  name TEXT NOT NULL,                 -- z.B. 'Причастия', 'Вид глагола'
  description TEXT,
  cefr_level TEXT,                    -- ab welchem Level erwartbar
  category TEXT,                      -- 'morphology' | 'syntax' | 'aspect' etc.
  FOREIGN KEY (language_id) REFERENCES languages(id)
);

CREATE TABLE IF NOT EXISTS chunk_grammar (
  id INTEGER PRIMARY KEY,
  chunk_id INTEGER NOT NULL,
  grammar_point_id INTEGER NOT NULL,
  UNIQUE(chunk_id, grammar_point_id),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id),
  FOREIGN KEY (grammar_point_id) REFERENCES grammar_points(id)
);

-- ═══════════════════════════════════════════════════════════════
-- USER & FORTSCHRITT (Schema vorbereitet für OAuth)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                -- UUID; später OAuth-ID
  type TEXT DEFAULT 'anon',           -- 'anon' | 'google' | 'email'
  email TEXT,
  name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  level TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, book_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (book_id) REFERENCES books(id)
);

-- ═══════════════════════════════════════════════════════════════
-- VOKABEL-DECK (für späteren SRS-Algorithmus)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_words (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  word_id INTEGER NOT NULL,
  interval INTEGER DEFAULT 0,         -- Tage bis nächste Wiederholung
  ease REAL DEFAULT 2.5,              -- Ease-Faktor (SM-2 Standard)
  reps INTEGER DEFAULT 0,             -- Anzahl erfolgreicher Wiederholungen
  due_date TEXT,                      -- ISO Datum der nächsten Wiederholung
  added_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, word_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (word_id) REFERENCES words(id)
);

-- ═══════════════════════════════════════════════════════════════
-- BUG-REPORTS (User-Feedback aus dem Frontend)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  version TEXT,                       -- Frontend-Version zum Zeitpunkt des Reports
  book_id INTEGER,                    -- aktuelles Buch (optional)
  chunk_index INTEGER,                -- aktueller Absatz (optional)
  level TEXT,                         -- aktuelles Level (optional)
  description TEXT,                   -- Freitext-Beschreibung (optional)
  screenshot TEXT,                    -- base64-Data-URL (kann NULL sein, wenn zu groß)
  user_agent TEXT,                    -- Browser/OS aus Request-Header
  created_at TEXT DEFAULT (datetime('now')),
  -- Ticket-Felder (via /api/admin/migrate nachträglich angelegt)
  type TEXT DEFAULT 'bug',            -- 'bug' | 'feature' | 'improvement'
  title TEXT,                         -- optionale Kurzüberschrift
  status TEXT DEFAULT 'open',         -- 'open' | 'in_progress' | 'on_hold' | 'closed' | 'rejected'
  priority TEXT DEFAULT 'medium',     -- 'low' | 'medium' | 'high'
  note TEXT,                          -- Bearbeitungs-Notiz (vom Admin)
  updated_at TEXT                     -- letzte Änderung an status/type/priority/title/note
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- TICKET-ÄNDERUNGSHISTORIE (Audit-Trail, CMMS-style)
-- ═══════════════════════════════════════════════════════════════
-- Jeder PATCH auf bug_reports schreibt pro wirklich geändertem Feld einen
-- Eintrag: was (field), alter Wert, neuer Wert, von wem (userId), wann.
-- Wird beim Löschen eines Tickets NICHT mitgelöscht (kein ON DELETE CASCADE) —
-- die Historie bleibt nachvollziehbar, wie in einem CMMS üblich.
CREATE TABLE IF NOT EXISTS ticket_changes (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  field TEXT NOT NULL,               -- 'status' | 'type' | 'priority' | 'title' | 'note'
  old_value TEXT,                    -- NULL = Feld war vorher leer
  new_value TEXT,                    -- NULL = Feld wurde geleert
  changed_by TEXT,                   -- userId (anon-XXXXX) aus X-User-Id-Header
  changed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES bug_reports(id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_changes_ticket ON ticket_changes(ticket_id, changed_at DESC);
