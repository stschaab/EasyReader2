// EasyReader2 – Cloudflare Worker API
// Endpoints:
//   GET  /                        – health check
//   GET  /api/books               – alle Bücher
//   GET  /api/books/:id           – Buch mit allen Chunks + fertigen Levels
//   POST /api/simplify            – RAG-Vereinfachung { chunk_id, level }
//   POST /api/progress            – Lesefortschritt speichern
//   GET  /api/progress/:bookId    – Lesefortschritt laden
//   GET    /api/deck              – Vokabel-Deck laden (anonym via X-User-Id)
//   POST   /api/deck/card         – einzelne Lernkarte upsert (create/update/grade)
//   DELETE /api/deck/card/:lemma  – einzelne Lernkarte löschen
//   POST   /api/user/login        – Login/Registrierung via E-Mail (kein Passwort)
//   GET    /api/tickets           – öffentliche Ticket-Liste (reduzierte Felder)
//   GET    /api/tickets/:id       – einzelnes Ticket öffentlich
//   POST /api/bug-report          – Bug-Report mit optionalem Screenshot speichern
//   POST /api/synonym             – Synonym+Rang+EN für ein spanisches Wort (GLM, live)
//   GET  /api/dict?word=&lang=    – Wörterbuch-Lookup via GLM (mit D1-Cache)
//   GET  /api/admin/bug-reports   – Ticket-Liste (X-Admin-Key geschützt)
//   GET  /api/admin/bug-reports/:id – Einzelnes Ticket mit Screenshot
//   PATCH /api/admin/bug-reports/:id – Ticket aktualisieren (status/type/...)
//   POST  /api/admin/bug-reports/:id/suggest-title – GLM generiert Titelvorschlag
//   GET   /api/admin/bug-reports/:id/history – Audit-Trail (wer-wann-was)
//   DELETE /api/admin/bug-reports/:id – Ticket löschen
//   POST /api/admin/migrate       – Schema-Migration (ALTER TABLE, idempotent)
//   POST /api/admin/words         – Kelly-Wortlisten-Import (X-Admin-Key geschützt)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Id, X-Admin-Key",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS,
  });
}

// CEFR-Level als Zahl für Vergleich (höher = schwieriger)
const CEFR_RANK = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const userId = request.headers.get("X-User-Id") || "anon";

    try {
      // ─── Health ───
      if (path === "/" && request.method === "GET") {
        return json({ status: "EasyReader2 API", db: !!env.DB, glm: !!env.GLM_API_KEY });
      }

      // ─── Diagnose: Hard-Words für einen Chunk anzeigen (ohne GLM) ───
      if (path === "/api/debug/hardwords" && request.method === "POST") {
        const { chunk_id, level } = await request.json();
        const targetRank = CEFR_RANK[level || "B1"];
        const chunk = await env.DB.prepare(
          `SELECT c.*, b.language_id FROM chunks c JOIN books b ON c.book_id = b.id WHERE c.id = ?`
        ).bind(chunk_id).first();
        if (!chunk) return json({ error: "Chunk nicht gefunden" }, 404);
        const tokens = [...new Set((chunk.original_text.match(new RegExp("[А-Яа-яЁё]+", "g")) || []).map(t => t.toLowerCase()))].slice(0, 100);
        // Lemmata über word_forms-Tabelle nachschlagen (vorab generiert)
        let lookupTokens = tokens;
        const wfCheck = await env.DB.prepare(`SELECT COUNT(*) c FROM word_forms`).first();
        if (wfCheck.c > 0) {
          const ph = tokens.map(() => "?").join(",");
          const wf = await env.DB.prepare(
            `SELECT word_form, lemma FROM word_forms WHERE word_form IN (${ph})`
          ).bind(...tokens).all();
          const formToLemma = {};
          for (const r2 of wf.results) formToLemma[r2.word_form] = r2.lemma;
          lookupTokens = [...new Set(tokens.map(t => formToLemma[t] || t))];
        }
        const placeholders = lookupTokens.map(() => "?").join(",");
        const r = await env.DB.prepare(
          `SELECT lemma, cefr_level FROM words WHERE language_id = ? AND lemma IN (${placeholders}) AND cefr_level IS NOT NULL`
        ).bind(chunk.language_id, ...lookupTokens).all();
        const hardWords = r.results
          .filter(w => CEFR_RANK[w.cefr_level] && CEFR_RANK[w.cefr_level] > targetRank)
          .sort((a, b) => CEFR_RANK[b.cefr_level] - CEFR_RANK[a.cefr_level])
          .map(w => ({ word: w.lemma, level: w.cefr_level }));
        const knownWords = r.results.filter(w => CEFR_RANK[w.cefr_level] && CEFR_RANK[w.cefr_level] <= targetRank).length;
        return json({ chunk_id, level, target_rank: targetRank, tokens_total: tokens.length, lemmas_total: lookupTokens.length, known_words: knownWords, hard_words: hardWords, hard_count: hardWords.length });
      }

      // ─── Bücher-Liste ───
      if (path === "/api/books" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT b.id, b.title, b.author, b.edition, l.code as lang, l.tts_lang,
                  (SELECT COUNT(*) FROM chunks WHERE book_id = b.id) as chunk_count
           FROM books b JOIN languages l ON b.language_id = l.id
           ORDER BY b.id`
        ).all();
        return json({ books: r.results });
      }

      // ─── Buch-Detail: nur Metadaten + Originaltexte (klein, schnell) ───
      const bookMatch = path.match(/^\/api\/books\/(\d+)$/);
      if (bookMatch && request.method === "GET") {
        const bookId = parseInt(bookMatch[1], 10);
        const book = await env.DB.prepare(
          `SELECT b.*, l.code as lang, l.tts_lang, l.wiktionary_lang, l.level_system, l.word_regex
           FROM books b JOIN languages l ON b.language_id = l.id WHERE b.id = ?`
        ).bind(bookId).first();
        if (!book) return json({ error: "Buch nicht gefunden" }, 404);

        const chunks = await env.DB.prepare(
          `SELECT c.id, c.order_index, c.original_text, c.word_count,
                  ch.volume, ch.part, ch.chapter_num
           FROM chunks c LEFT JOIN chapters ch ON c.chapter_id = ch.id
           WHERE c.book_id = ? ORDER BY c.order_index`
        ).bind(bookId).all();

        // Levels dynamisch ermitteln: welche simplification-levels hat dieses Buch?
        // Liefert z.B. ["A1","A1e","A2","B1","EN"] für Zalacaín oder ["A2","B1","EN"] für Tolstoi.
        const levelRows = await env.DB.prepare(
          `SELECT DISTINCT level FROM simplifications s
           JOIN chunks c ON s.chunk_id = c.id WHERE c.book_id = ? ORDER BY level`
        ).bind(bookId).all();
        const levels = levelRows.results.map(r => r.level);

        // Leere Felder für alle vorhandenen Levels vorbereiten (wie früher hartcodiert).
        // Frontend liest die Werte später über /api/books/:id/simplifications nach.
        const levelFields = {};
        for (const lvl of levels) levelFields[lvl] = "";

        const chunksOut = chunks.results.map((c) => Object.assign({
          id: c.id,
          order_index: c.order_index,
          chapter: c.chapter_num ? "Т." + (c.volume || 1) + " · Ч." + (c.part || 1) + " · Гл. " + toRoman(c.chapter_num) : null,
          original: c.original_text,
          word_count: c.word_count,
        }, levelFields));

        return json({ book, chunks: chunksOut, levels });
      }

      // ─── Alle Vereinfachungen für ein Buch (ein großer Request) ───
      const simsMatch = path.match(/^\/api\/books\/(\d+)\/simplifications$/);
      if (simsMatch && request.method === "GET") {
        const bookId = parseInt(simsMatch[1], 10);
        const sims = await env.DB.prepare(
          `SELECT s.chunk_id, s.level, s.simplified_text
           FROM simplifications s JOIN chunks c ON s.chunk_id = c.id
           WHERE c.book_id = ? ORDER BY s.chunk_id, s.level`
        ).bind(bookId).all();

        // Nach chunk_id gruppiert als Objekt
        const result = {};
        for (const s of sims.results) {
          if (!result[s.chunk_id]) result[s.chunk_id] = {};
          result[s.chunk_id][s.level] = s.simplified_text;
        }
        return json({ simplifications: result });
      }

      // ─── RAG-Vereinfachung ───
      if (path === "/api/simplify" && request.method === "POST") {
        const { chunk_id, level } = await request.json();
        if (!chunk_id || !level) return json({ error: "chunk_id und level erforderlich" }, 400);
        // A1e ist ein Offline-Format (A1-Text + englische Inline-Glossen) und
        // kann nicht on-demand vom Worker erzeugt werden.
        if (level === "A1e") return json({ error: "A1e ist nur offline verfügbar (vorab generiert)." }, 400);
        if (!CEFR_RANK[level]) return json({ error: "Unbekanntes Level: " + level }, 400);

        // 1. Chunk laden
        const chunk = await env.DB.prepare(
          `SELECT c.*, b.language_id FROM chunks c
           JOIN books b ON c.book_id = b.id WHERE c.id = ?`
        ).bind(chunk_id).first();
        if (!chunk) return json({ error: "Chunk nicht gefunden" }, 404);

        // 2. Cache prüfen (bereits generiert?)
        const cached = await env.DB.prepare(
          `SELECT simplified_text FROM simplifications WHERE chunk_id = ? AND level = ?`
        ).bind(chunk_id, level).first();
        if (cached) return json({ simplified: cached.simplified_text, source: "cache" });

        // 3. Hard words für RAG bestimmen
        const targetRank = CEFR_RANK[level];
        const wordRegex = new RegExp("[А-Яа-яЁё]+", "g");
        const tokens = chunk.original_text.match(wordRegex) || [];
        const uniqueTokens = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 100);

        // 3a. Lemmata-Lookup: flektierte Formen → Grundformen via D1-Tabelle
        // (word_forms wird vorab per Batch-Job aus Kelly-Lemmata generiert, s. build_wordforms.js)
        // Fallback: wenn word_forms leer, nutze originale Tokens (Abwärtskompatibilität)
        let lookupTokens = uniqueTokens;
        const wfCheck = await env.DB.prepare(
          `SELECT COUNT(*) c FROM word_forms`
        ).first();
        if (wfCheck.c > 0) {
          // Für jeden Token das Lemma nachschlagen
          const ph = uniqueTokens.map(() => "?").join(",");
          const wf = await env.DB.prepare(
            `SELECT word_form, lemma FROM word_forms WHERE word_form IN (${ph})`
          ).bind(...uniqueTokens).all();
          const formToLemma = {};
          for (const r of wf.results) formToLemma[r.word_form] = r.lemma;
          lookupTokens = [...new Set(
            uniqueTokens.map(t => formToLemma[t] || t)
          )];
        }

        // 3b. Batch-Query: Lemmata gegen Kelly-Wortliste
        const hardWords = [];
        if (lookupTokens.length > 0) {
          const placeholders = lookupTokens.map(() => "?").join(",");
          const r = await env.DB.prepare(
            `SELECT lemma, cefr_level FROM words
             WHERE language_id = ? AND lemma IN (${placeholders})
             AND cefr_level IS NOT NULL`
          ).bind(chunk.language_id, ...lookupTokens).all();
          for (const w of r.results) {
            if (CEFR_RANK[w.cefr_level] && CEFR_RANK[w.cefr_level] > targetRank) {
              hardWords.push({ word: w.lemma, level: w.cefr_level });
            }
          }
        }

        // 4. Prompt bauen
        const prompt = buildPrompt(chunk.original_text, level, hardWords);

        // 5. GLM aufrufen über Coding-Plan (Anthropic-Endpunkt, nicht api.z.ai!)
        // Coding Plan greift nur über open.bigmodel.cn/api/anthropic (siehe Zhipu FAQ).
        let simplified = null;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
          try {
            const glmRes = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": env.GLM_API_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "glm-4.6",
                max_tokens: 2000,
                system: prompt.system,
                messages: [
                  { role: "user", content: prompt.user },
                ],
                temperature: 0.3,
              }),
            });
            if (glmRes.ok) {
              const glmData = await glmRes.json();
              // Anthropic-Format: content ist Array von {type:"text", text:"..."}
              const contentParts = glmData.content || [];
              let candidate = contentParts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
                .trim();
              // Validierung: keine CJK-Zeichen, keine längeren lateinischen Sequenzen
              // (GLM verliert gelegentlich die Sprache → chinesische/englische Ausreißer)
              const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate);
              if (hasCJK) {
                lastError = "CJK-Zeichen in Ausgabe (Sprache verloren)";
                if (attempt > 0) {
                  // beim letzten Versuch trotzdem nehmen (besser als nichts)
                  simplified = candidate;
                  break;
                }
                continue; // retry
              }
              simplified = candidate;
              break;
            }
            const errText = await glmRes.text();
            lastError = errText;
            if (!errText.includes("1302")) break; // nur bei Rate-Limit retry
          } catch (e) {
            lastError = e.message;
          }
        }

        if (!simplified) {
          return json({ error: "GLM-Fehler: " + (lastError || "unbekannt") }, 502);
        }

        // 6. In DB speichern (Cache für下次)
        await env.DB.prepare(
          `INSERT OR REPLACE INTO simplifications (chunk_id, level, simplified_text, method, model)
           VALUES (?, ?, ?, 'rag', 'glm-4.6')`
        ).bind(chunk_id, level, simplified).run();

        return json({ simplified, source: "rag", hard_words: hardWords.length });
      }

      // ─── Admin: Simplifikationen direkt einfügen (Batch, für Offline-Generierung) ───
      if (path === "/api/admin/insert-simplifications" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const { items } = await request.json();
        if (!Array.isArray(items)) return json({ error: "items-Array erforderlich" }, 400);
        let inserted = 0;
        let errors = 0;
        for (const it of items) {
          try {
            if (!it.chunk_id || !it.level || !it.simplified_text) { errors++; continue; }
            await env.DB.prepare(
              `INSERT OR REPLACE INTO simplifications (chunk_id, level, simplified_text, method, model)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(it.chunk_id, it.level, it.simplified_text, it.method || "offline", it.model || "glm-5.2").run();
            inserted++;
          } catch (e) { errors++; }
        }
        return json({ ok: true, inserted, errors, total: items.length });
      }

      // ─── Admin: Simplifikations-Cache löschen (für RAG-Regenerierung) ───
      if (path === "/api/admin/clearcache" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const { chunk_id, level } = await request.json();
        if (chunk_id && level) {
          const r = await env.DB.prepare(
            `DELETE FROM simplifications WHERE chunk_id = ? AND level = ?`
          ).bind(chunk_id, level).run();
          return json({ ok: true, deleted: r.meta?.changes || 0 });
        }
        if (chunk_id && !level) {
          const r = await env.DB.prepare(
            `DELETE FROM simplifications WHERE chunk_id = ?`
          ).bind(chunk_id).run();
          return json({ ok: true, deleted: r.meta?.changes || 0 });
        }
        return json({ error: "chunk_id erforderlich" }, 400);
      }

      // ─── Admin: Chunks für ein Buch neu aufbauen (Re-Chunking) ───
      if (path === "/api/admin/rebuild-chunks" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const body = await request.json();
        const { book_id, action, chunks } = body;
        if (!book_id) return json({ error: "book_id erforderlich" }, 400);

        // action=reset: alle Chunks + Simplifikationen des Buches löschen
        if (action === "reset") {
          const d1 = await env.DB.prepare(
            `DELETE FROM simplifications WHERE chunk_id IN (SELECT id FROM chunks WHERE book_id = ?)`
          ).bind(book_id).run();
          const d2 = await env.DB.prepare(
            `DELETE FROM chunks WHERE book_id = ?`
          ).bind(book_id).run();
          return json({ ok: true, deleted_simplifications: d1.meta?.changes || 0, deleted_chunks: d2.meta?.changes || 0 });
        }

        // action=insert: neue Chunks einfügen (Batch)
        if (action === "insert" && Array.isArray(chunks)) {
          let inserted = 0;
          let errors = 0;
          for (const c of chunks) {
            try {
              // chapter_id aus chapter_num ableiten (1 → chapter 1, 2 → chapter 2)
              const chapterId = c.chapter_num || 1;
              await env.DB.prepare(
                `INSERT INTO chunks (book_id, chapter_id, order_index, original_text, word_count)
                 VALUES (?, ?, ?, ?, ?)`
              ).bind(book_id, chapterId, c.order_index, c.original_text, c.word_count).run();
              inserted++;
            } catch (e) {
              errors++;
            }
          }
          return json({ ok: true, inserted, errors, total: chunks.length });
        }

        // action=status
        if (action === "status") {
          const cnt = await env.DB.prepare(
            `SELECT COUNT(*) c FROM chunks WHERE book_id = ?`
          ).bind(book_id).first();
          const sims = await env.DB.prepare(
            `SELECT COUNT(*) c FROM simplifications WHERE chunk_id IN (SELECT id FROM chunks WHERE book_id = ?)`
          ).bind(book_id).first();
          return json({ chunks: cnt.c, simplifications: sims.c });
        }

        return json({ error: "unbekannte action" }, 400);
      }

      // ─── Admin: word_forms-Tabelle verwalten (Flexionsformen → Lemma) ───
      if (path === "/api/admin/wordforms" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const { action, forms } = await request.json();

        if (action === "create") {
          await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS word_forms (
              word_form TEXT NOT NULL,
              lemma TEXT NOT NULL,
              cefr_level TEXT,
              PRIMARY KEY (word_form, lemma)
            )`
          ).run();
          await env.DB.prepare(
            `CREATE INDEX IF NOT EXISTS idx_word_forms ON word_forms(word_form)`
          ).run();
          return json({ ok: true });
        }

        if (action === "reset") {
          await env.DB.prepare(`DELETE FROM word_forms`).run();
          return json({ ok: true });
        }

        if (action === "insert" && Array.isArray(forms)) {
          let inserted = 0;
          const BATCH = 25;
          for (let i = 0; i < forms.length; i += BATCH) {
            const batch = forms.slice(i, i + BATCH);
            try {
              const placeholders = batch.map(() => "(?,?,?)").join(",");
              const flat = [];
              for (const f of batch) flat.push(f.word_form, f.lemma, f.cefr_level || null);
              await env.DB.prepare(
                `INSERT OR IGNORE INTO word_forms (word_form, lemma, cefr_level) VALUES ${placeholders}`
              ).bind(...flat).run();
              inserted += batch.length;
            } catch (e) { /* Batch-Fehler überspringen */ }
          }
          return json({ ok: true, inserted, total: forms.length });
        }

        if (action === "status") {
          const cnt = await env.DB.prepare(`SELECT COUNT(*) c FROM word_forms`).first();
          return json({ total: cnt ? cnt.c : 0 });
        }

        return json({ error: "unbekannte action" }, 400);
      }

      // ─── Admin: Wortliste laden (Kelly-Import) ───
      if (path === "/api/admin/words" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);

        const body = await request.json();
        const { action, language_id, words } = body;
        if (!language_id) return json({ error: "language_id erforderlich" }, 400);

        // Phase 1: Alle Wörter der Sprache löschen (sauberer Reset)
        if (action === "reset") {
          const r = await env.DB.prepare(
            `DELETE FROM words WHERE language_id = ?`
          ).bind(language_id).run();
          return json({ ok: true, deleted: r.meta?.changes || 0 });
        }

        // Phase 2: Batch-INSERT (Wörter Array: [{lemma, rank, cefr}, ...])
        if (action === "insert" && Array.isArray(words)) {
          let inserted = 0;
          let errors = 0;
          // In Sub-Batches à 25 (3 Spalten × 25 = 75 Variablen, sicher)
          const BATCH = 25;
          for (let i = 0; i < words.length; i += BATCH) {
            const batch = words.slice(i, i + BATCH);
            try {
              const placeholders = batch.map(() => "(?, ?, ?, ?)").join(",");
              const flat = [];
              for (const w of batch) {
                flat.push(language_id, w.lemma, w.rank, w.cefr);
              }
              await env.DB.prepare(
                `INSERT OR IGNORE INTO words (language_id, lemma, rank, cefr_level) VALUES ${placeholders}`
              ).bind(...flat).run();
              inserted += batch.length;
            } catch (e) {
              errors++;
            }
          }
          return json({ ok: true, inserted, errors, total: words.length });
        }

        // Phase 3: Status (Verteilung)
        if (action === "status") {
          const cnt = await env.DB.prepare(
            `SELECT COUNT(*) c FROM words WHERE language_id = ?`
          ).bind(language_id).first();
          const dist = await env.DB.prepare(
            `SELECT cefr_level, COUNT(*) c FROM words WHERE language_id = ? GROUP BY cefr_level ORDER BY cefr_level`
          ).bind(language_id).all();
          return json({ total: cnt.c, distribution: dist.results });
        }

        return json({ error: "unbekannte action" }, 400);
      }

      // ─── Bug-Report speichern (öffentlich, mit Screenshot) ───
      // Frontend schickt { description, screenshot (data-url), version, book_id, chunk_index, level }.
      // Screenshot wird verworfen, wenn er zu groß für D1 ist (~750 KB base64-Grenze).
      if (path === "/api/bug-report" && request.method === "POST") {
        const body = await request.json();
        const description = (body.description || "").toString().slice(0, 4000);
        const version = body.version ? String(body.version).slice(0, 32) : null;
        const bookId = body.book_id ? parseInt(body.book_id, 10) : null;
        const chunkIndex = Number.isInteger(body.chunk_index) ? body.chunk_index : null;
        const lvl = body.level ? String(body.level).slice(0, 16) : null;
        const userAgent = (request.headers.get("User-Agent") || "").slice(0, 512);

        // Screenshot-Größenlimit: base64-String, max ~750 KB (D1-Zeilen-Limit sicher)
        const MAX_SHOT = 750000;
        let screenshot = null;
        let screenshotDropped = false;
        if (typeof body.screenshot === "string" && body.screenshot.length > 0) {
          if (body.screenshot.length <= MAX_SHOT) {
            screenshot = body.screenshot;
          } else {
            screenshotDropped = true;
          }
        }

        // Tabelle bei Bedarf anlegen (wie bei word_forms, Idempotent)
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS bug_reports (
            id INTEGER PRIMARY KEY,
            user_id TEXT NOT NULL,
            version TEXT,
            book_id INTEGER,
            chunk_index INTEGER,
            level TEXT,
            description TEXT,
            screenshot TEXT,
            user_agent TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`
        ).run();
        await env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_bug_reports_created ON bug_reports(created_at DESC)`
        ).run();

        // User anlegen falls noch nicht vorhanden (analog /api/progress)
        await env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, type) VALUES (?, 'anon')`
        ).bind(userId).run();

        const result = await env.DB.prepare(
          `INSERT INTO bug_reports (user_id, version, book_id, chunk_index, level, description, screenshot, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(userId, version, bookId, chunkIndex, lvl, description || null, screenshot, userAgent).run();

        return json({
          ok: true,
          id: result.meta?.last_row_id || null,
          screenshot_dropped: screenshotDropped,
        });
      }

      // ─── Admin: Schema-Migration (idempotent, ALTER TABLE) ───
      // Fügt die Ticket-Spalten zur bug_reports-Tabelle hinzu, falls sie noch
      // fehlen. CREATE TABLE IF NOT EXISTS ist bei bestehender Tabelle ein
      // No-Op, daher der separate Migrations-Pfad. SQLite ADD COLUMN schlägt
      // fehl, wenn die Spalte schon existiert -> pro Spalte try/catch.
      if (path === "/api/admin/migrate" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const cols = [
          { name: "type",       ddl: "TEXT DEFAULT 'bug'" },
          { name: "title",      ddl: "TEXT" },
          { name: "status",     ddl: "TEXT DEFAULT 'open'" },
          { name: "priority",   ddl: "TEXT DEFAULT 'medium'" },
          { name: "note",       ddl: "TEXT" },
          { name: "updated_at", ddl: "TEXT" },
        ];
        const results = [];
        for (const c of cols) {
          try {
            await env.DB.prepare(
              `ALTER TABLE bug_reports ADD COLUMN ${c.name} ${c.ddl}`
            ).run();
            results.push({ col: c.name, added: true });
          } catch (e) {
            // Spalte existiert bereits -> OK, nichts tun.
            results.push({ col: c.name, added: false, reason: e.message });
          }
        }
        // Backfill: bestehende Reports ohne status/type/priority mit Defaults füllen
        try {
          await env.DB.prepare(
            `UPDATE bug_reports SET status='open' WHERE status IS NULL`
          ).run();
          await env.DB.prepare(
            `UPDATE bug_reports SET type='bug' WHERE type IS NULL`
          ).run();
          await env.DB.prepare(
            `UPDATE bug_reports SET priority='medium' WHERE priority IS NULL`
          ).run();
        } catch (e) { /* Tabelle evtl. noch nicht da -> ignorieren */ }

        // Audit-Tabelle anlegen (idempotent via IF NOT EXISTS).
        // Schreibt bei jedem PATCH die alten+neuen Werte, von wem, wann —
        // nicht-destruktive Historie wie im CMMS.
        try {
          await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS ticket_changes (
              id INTEGER PRIMARY KEY,
              ticket_id INTEGER NOT NULL,
              field TEXT NOT NULL,
              old_value TEXT,
              new_value TEXT,
              changed_by TEXT,
              changed_at TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (ticket_id) REFERENCES bug_reports(id)
            )`
          ).run();
          await env.DB.prepare(
            `CREATE INDEX IF NOT EXISTS idx_ticket_changes_ticket ON ticket_changes(ticket_id, changed_at DESC)`
          ).run();
          results.push({ col: "ticket_changes_table", added: true });
        } catch (e) {
          results.push({ col: "ticket_changes_table", added: false, reason: e.message });
        }
        return json({ ok: true, columns: results });
      }

      // ─── Admin: Ticket-Liste (ohne Screenshots, dafür mit Status/Typ/etc.) ───
      if (path === "/api/admin/bug-reports" && request.method === "GET") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const r = await env.DB.prepare(
          `SELECT id, user_id, version, book_id, chunk_index, level,
                  description, user_agent, created_at, updated_at,
                  type, title, status, priority, note,
                  (screenshot IS NOT NULL) AS has_screenshot
           FROM bug_reports ORDER BY created_at DESC LIMIT 100`
        ).all();
        return json({ reports: r.results });
      }

      // ─── Admin: Einzelner Bug-Report mit Screenshot ───
      const bugMatch = path.match(/^\/api\/admin\/bug-reports\/(\d+)$/);
      if (bugMatch && request.method === "GET") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const reportId = parseInt(bugMatch[1], 10);
        const row = await env.DB.prepare(
          `SELECT id, user_id, version, book_id, chunk_index, level, description, screenshot, user_agent, created_at
           FROM bug_reports WHERE id = ?`
        ).bind(reportId).first();
        if (!row) return json({ error: "nicht gefunden" }, 404);
        return json({ report: row });
      }

      // ─── Admin: Bug-Report löschen ───
      const bugDeleteMatch = path.match(/^\/api\/admin\/bug-reports\/(\d+)$/);
      if (bugDeleteMatch && request.method === "DELETE") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const reportId = parseInt(bugDeleteMatch[1], 10);
        const r = await env.DB.prepare(
          `DELETE FROM bug_reports WHERE id = ?`
        ).bind(reportId).run();
        return json({ ok: true, deleted: r.meta?.changes || 0 });
      }

      // ─── Admin: Ticket aktualisieren (status/type/priority/title/note) ───
      // PATCH mit beliebigem Subset der Felder. Whitelist schützt vor Injection
      // (Feldnamen werden in SQL eingefügt, daher dürfen nur bekannte durch).
      // Audit: vor dem UPDATE alte Werte laden, danach Diff-Einträge in
      // ticket_changes schreiben (nur für Felder die sich WIRKLICH geändert
      // haben — sonst müllt "Speichern ohne Änderung" die Historie voll).
      const bugPatchMatch = path.match(/^\/api\/admin\/bug-reports\/(\d+)$/);
      if (bugPatchMatch && request.method === "PATCH") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const reportId = parseInt(bugPatchMatch[1], 10);
        const body = await request.json();
        // Erlaubte Felder + Wert-Bereinigung (Längenlimits, Typ).
        const allowed = {
          status:   (v) => ["open", "in_progress", "on_hold", "closed", "rejected"].includes(v) ? v : null,
          type:     (v) => ["bug", "feature", "improvement"].includes(v) ? v : null,
          priority: (v) => ["low", "medium", "high"].includes(v) ? v : null,
          title:    (v) => typeof v === "string" ? v.slice(0, 200) : null,
          note:     (v) => typeof v === "string" ? v.slice(0, 4000) : null,
        };
        // 1) Nur Felder sammeln, die gültig im Body sind.
        const changes = {};   // field -> newValue
        for (const [field, validate] of Object.entries(allowed)) {
          if (body[field] !== undefined) {
            const cleaned = validate(body[field]);
            if (cleaned !== null) changes[field] = cleaned;
          }
        }
        const fieldsToPatch = Object.keys(changes);
        if (fieldsToPatch.length === 0) return json({ error: "keine gültigen Felder" }, 400);

        // 2) Alte Werte laden (für Audit-Diff). Nur die relevanten Felder.
        const selectCols = fieldsToPatch.join(", ");
        const oldRow = await env.DB.prepare(
          `SELECT ${selectCols} FROM bug_reports WHERE id = ?`
        ).bind(reportId).first();
        if (!oldRow) return json({ error: "nicht gefunden" }, 404);

        // 3) UPDATE bauen + ausführen.
        const sets = fieldsToPatch.map((f) => `${f} = ?`);
        const vals = fieldsToPatch.map((f) => changes[f]);
        sets.push(`updated_at = datetime('now')`);
        vals.push(reportId);
        await env.DB.prepare(
          `UPDATE bug_reports SET ${sets.join(", ")} WHERE id = ?`
        ).bind(...vals).run();

        // 4) Audit-Einträge für Felder mit echtem Diff (old !== new).
        let auditCount = 0;
        for (const f of fieldsToPatch) {
          const oldVal = oldRow[f] == null ? null : String(oldRow[f]);
          let newVal = changes[f];
          if (newVal == null) newVal = null;
          // String-Vergleich; NULL-Semantik: null !== "x" ist eine Änderung.
          const changed = (oldVal === null) !== (newVal === null) || (oldVal !== newVal);
          if (!changed) continue;
          // Werte auf 1000 Zeichen kappen (keine Megabyte-Notizen in der History).
          const oldSlice = oldVal == null ? null : oldVal.slice(0, 1000);
          const newSlice = newVal == null ? null : newVal.slice(0, 1000);
          try {
            await env.DB.prepare(
              `INSERT INTO ticket_changes (ticket_id, field, old_value, new_value, changed_by)
               VALUES (?, ?, ?, ?, ?)`
            ).bind(reportId, f, oldSlice, newSlice, userId).run();
            auditCount++;
          } catch (e) { /* Audit-Fehler darf UPDATE nicht ungeschehen machen */ }
        }

        return json({ ok: true, updated: fieldsToPatch.length, audited: auditCount });
      }

      // ─── Admin: GLM-Titel-Vorschlag für ein Ticket ───
      // Lädt das Ticket (mit allen Feldern), baut einen Prompt und ruft GLM auf.
      // Gibt einen kurzen, aussagekräftigen Titel zurück (max ~80 Zeichen).
      // Überschreibt nichts — das Frontend entscheidet, ob es den Titel übernimmt.
      const bugTitleMatch = path.match(/^\/api\/admin\/bug-reports\/(\d+)\/suggest-title$/);
      if (bugTitleMatch && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const reportId = parseInt(bugTitleMatch[1], 10);
        const t = await env.DB.prepare(
          `SELECT id, description, note, type, status, priority, book_id, level, version FROM bug_reports WHERE id = ?`
        ).bind(reportId).first();
        if (!t) return json({ error: "nicht gefunden" }, 404);

        const systemPrompt =
          "You summarize a bug/feature report into a concise German TITLE (Kopfzeile), " +
          "like a Jira summary or a CMMS fault-notification headline. " +
          "Rules:\n" +
          "- Max ~80 characters, ideally 4-8 words.\n" +
          "- German (the app's UI language). Keep technical terms as-is.\n" +
          "- State the PROBLEM or REQUEST, not the user's wording. Be specific.\n" +
          "- Examples: 'Wörterbuch: keine Übersetzung bei Verben', 'SRS-Intervall in Karten anzeigen', 'Lesefortschritt wird nicht wiederhergestellt'.\n" +
          "- Output ONLY the title text, no quotes, no explanation, no prefix.";
        const fields = [];
        if (t.description) fields.push("Beschreibung: " + t.description);
        if (t.note)       fields.push("Notiz: " + t.note);
        if (t.type)       fields.push("Typ: " + t.type);
        if (t.status)     fields.push("Status: " + t.status);
        if (t.book_id)    fields.push("Buch: #" + t.book_id);
        if (t.level)      fields.push("Level: " + t.level);
        if (t.version)    fields.push("App-Version: " + t.version);
        const userPrompt = "Ticket-Daten:\n" + fields.join("\n") + "\n\nTitel:";

        let title = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
          try {
            const glmRes = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": env.GLM_API_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "glm-4.6",
                max_tokens: 60,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
                temperature: 0.3,
              }),
            });
            if (glmRes.ok) {
              const glmData = await glmRes.json();
              const candidate = (glmData.content || [])
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
                .trim()
                .split("\n")[0]              // nur erste Zeile
                .replace(/^["'\s]+|["'\s]+$/g, "")  // Anführungszeichen drumrum weg
                .slice(0, 100);
              if (candidate.length >= 3) { title = candidate; break; }
              lastError = "leere/kurze Antwort";
            } else {
              const errText = await glmRes.text();
              lastError = errText.slice(0, 120);
              if (!errText.includes("1302")) break;  // nur bei Rate-Limit retry
            }
          } catch (e) { lastError = e.message; }
        }
        if (!title) return json({ error: "GLM-Fehler: " + (lastError || "unbekannt") }, 502);
        return json({ ok: true, title: title });
      }

      // ─── Admin: Audit-Trail (Historie) für ein Ticket ───
      // Liefert alle ticket_changes-Einträge, absteigend nach Datum.
      const bugHistoryMatch = path.match(/^\/api\/admin\/bug-reports\/(\d+)\/history$/);
      if (bugHistoryMatch && request.method === "GET") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const reportId = parseInt(bugHistoryMatch[1], 10);
        const r = await env.DB.prepare(
          `SELECT id, field, old_value, new_value, changed_by, changed_at
           FROM ticket_changes WHERE ticket_id = ?
           ORDER BY changed_at DESC, id DESC`
        ).bind(reportId).all();
        return json({ changes: r.results });
      }

      // ─── Lesefortschritt speichern ───
      if (path === "/api/progress" && request.method === "POST") {
        const { book_id, chunk_index, level } = await request.json();
        if (!book_id) return json({ error: "book_id erforderlich" }, 400);

        // User anlegen falls noch nicht vorhanden (anonym)
        await env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, type) VALUES (?, 'anon')`
        ).bind(userId).run();

        await env.DB.prepare(
          `INSERT OR REPLACE INTO progress (user_id, book_id, chunk_index, level, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        ).bind(userId, book_id, chunk_index || 0, level || "original").run();
        return json({ ok: true });
      }

      // ─── Lesefortschritt laden ───
      const progressMatch = path.match(/^\/api\/progress\/(\d+)$/);
      if (progressMatch && request.method === "GET") {
        const bookId = parseInt(progressMatch[1], 10);
        const p = await env.DB.prepare(
          `SELECT chunk_index, level FROM progress WHERE user_id = ? AND book_id = ?`
        ).bind(userId, bookId).first();
        return json({ progress: p || { chunk_index: 0, level: "original" } });
      }

      // ─── Vokabel-Deck (user_cards) ─────────────────────────────────
      // Persistente Lernkarten pro User (anonym via X-User-Id). Die Tabelle
      // spiegelt das clientseitige Deck-Modell exakt (interval_hours, kein
      // SM-2-ease) — bewusst parallel zur ungenutzten user_words-Tabelle,
      // die für eine spätere SM-2-Migration reserviert bleibt.
      //
      //   GET    /api/deck               – ganzes Deck des Users laden
      //   POST   /api/deck/card          – einzelne Karte upsert (create/update/grade)
      //   DELETE /api/deck/card/:lemma   – einzelne Karte löschen
      const isDeckCall = path === "/api/deck" || path.startsWith("/api/deck/card");
      if (isDeckCall) {
        // Tabelle idempotent anlegen (wie bug_reports beim ersten Aufruf).
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS user_cards (
            id INTEGER PRIMARY KEY,
            user_id TEXT NOT NULL,
            lemma TEXT NOT NULL,
            lang TEXT NOT NULL,
            gloss TEXT,
            pos TEXT,
            inflected TEXT,
            sentence TEXT,
            surface_form TEXT,
            sentence_en TEXT,
            chunk_id INTEGER,
            interval_hours REAL DEFAULT 0,
            reps INTEGER DEFAULT 0,
            due TEXT,
            added TEXT,
            UNIQUE(user_id, lemma),
            FOREIGN KEY (user_id) REFERENCES users(id)
          )`
        ).run();
        await env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_user_cards_user ON user_cards(user_id)`
        ).run();
        // User anlegen falls noch nicht vorhanden (analog /api/progress).
        await env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, type) VALUES (?, 'anon')`
        ).bind(userId).run();
      }

      // GET /api/deck – ganzes Deck laden
      if (path === "/api/deck" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT lemma, lang, gloss, pos, inflected, sentence, surface_form,
                  sentence_en, chunk_id, interval_hours, reps, due, added
           FROM user_cards WHERE user_id = ? ORDER BY added`
        ).bind(userId).all();
        return json({ cards: r.results || [] });
      }

      // POST /api/deck/card – einzelne Karte upsert
      if (path === "/api/deck/card" && request.method === "POST") {
        const b = await request.json();
        const lemma = (b.lemma || "").toString().trim();
        if (!lemma) return json({ error: "lemma erforderlich" }, 400);
        await env.DB.prepare(
          `INSERT OR REPLACE INTO user_cards
           (user_id, lemma, lang, gloss, pos, inflected, sentence, surface_form,
            sentence_en, chunk_id, interval_hours, reps, due, added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          userId, lemma, (b.lang || "ru").toString().slice(0, 8),
          b.gloss || null, b.pos || null, b.inflected || null,
          b.sentence || null, b.surface_form || null, b.sentence_en || null,
          Number.isInteger(b.chunk_id) ? b.chunk_id : null,
          Number(b.interval_hours) || 0,
          Number.isInteger(b.reps) ? b.reps : 0,
          b.due || null, b.added || null
        ).run();
        return json({ ok: true });
      }

      // DELETE /api/deck/card/:lemma – einzelne Karte löschen
      const delCardMatch = path.match(/^\/api\/deck\/card\/(.+)$/);
      if (delCardMatch && request.method === "DELETE") {
        const lemma = decodeURIComponent(delCardMatch[1]);
        const r = await env.DB.prepare(
          `DELETE FROM user_cards WHERE user_id = ? AND lemma = ?`
        ).bind(userId, lemma).run();
        return json({ ok: true, deleted: r.meta?.changes || 0 });
      }

      // ─── User-Login / Registrierung (E-Mail als Identität, kein Passwort) ───
      // Wer zuerst eine E-Mail-Adresse angibt, bekommt sie als userId. Es gibt
      // keine Passwort-Prüfung — ER hat keine sensiblen Daten, die E-Mail allein
      // dient als geräteübergreifende Identität.
      if (path === "/api/user/login" && request.method === "POST") {
        const b = await request.json();
        const email = (b.email || "").toString().trim().toLowerCase();
        // Sehr einfache E-Mail-Validierung: muss @ und einen Punkt in der Domain haben.
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: "Bitte eine gültige E-Mail-Adresse eingeben." }, 400);
        }
        const existing = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(email).first();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, type, email) VALUES (?, 'email', ?)`
        ).bind(email, email).run();
        return json({ ok: true, email, new: !existing });
      }

      // ─── Öffentliche Ticket-Liste (für alle eingeloggten Nutzer) ───
      // Reduzierte Felder: KEIN screenshot (base64, zu groß + privat), KEIN
      // user_agent, KEIN note (Admin-Notiz), KEIN user_id (Datenschutz:
      // Reporter-Adressen sind nicht öffentlich).
      if (path === "/api/tickets" && request.method === "GET") {
        const r = await env.DB.prepare(
          `SELECT id, version, book_id, chunk_index, level,
                  description, created_at, updated_at,
                  type, title, status, priority,
                  (screenshot IS NOT NULL) AS has_screenshot
           FROM bug_reports ORDER BY created_at DESC LIMIT 200`
        ).all();
        return json({ tickets: r.results });
      }

      // ─── Einzelnes Ticket öffentlich (ohne sensitive Felder) ───
      const ticketMatch = path.match(/^\/api\/tickets\/(\d+)$/);
      if (ticketMatch && request.method === "GET") {
        const id = parseInt(ticketMatch[1], 10);
        const row = await env.DB.prepare(
          `SELECT id, version, book_id, chunk_index, level, description, created_at, updated_at,
                  type, title, status, priority,
                  (screenshot IS NOT NULL) AS has_screenshot
           FROM bug_reports WHERE id = ?`
        ).bind(id).first();
        if (!row) return json({ error: "nicht gefunden" }, 404);
        return json({ ticket: row });
      }

      // ─── TEMPORÄRER Migrations-Endpunkt: Legacy-User auf E-Mail umbiegen ───
      // Einmalig nach v7.32-Deploy aufrufen, danach kann der Block entfernt werden.
      // Auth via X-Admin-Key, damit niemand fremdes ausführt.
      if (path === "/api/admin/migrate-user" && request.method === "POST") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const b = await request.json();
        const fromId = (b.from || "").toString();
        const toId = (b.to || "").toString().toLowerCase();
        if (!fromId || !toId) return json({ error: "from und to erforderlich" }, 400);
        // 1. user_cards migrieren
        const uc = await env.DB.prepare(
          `UPDATE user_cards SET user_id = ? WHERE user_id = ?`
        ).bind(toId, fromId).run();
        // 2. progress migrieren
        const pr = await env.DB.prepare(
          `UPDATE progress SET user_id = ? WHERE user_id = ?`
        ).bind(toId, fromId).run();
        // 3. users: Ziel-Eintrag anlegen (falls nicht vorhanden), Quelle löschen
        await env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, type, email) VALUES (?, 'email', ?)`
        ).bind(toId, toId).run();
        await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(fromId).run();
        return json({
          ok: true, from: fromId, to: toId,
          migrated_cards: uc.meta?.changes || 0,
          migrated_progress: pr.meta?.changes || 0,
        });
      }

      // ─── Synonym für ein Wort (live GLM, ohne Cache) ───────────────
      // Liefert: ein semantisch ähnliches, aber häufigeres (Kelly-Rang niedriger)
      // Synonym + englische Glossen + semantische Übereinstimmung in %.
      // Zweck: didaktische Hilfe UND Live-Test der Kette WebApp→Worker→GLM.
      if (path === "/api/synonym" && request.method === "POST") {
        const { lemma, lang } = await request.json();
        if (!lemma) return json({ error: "lemma erforderlich" }, 400);
        const langCode = lang || "es";

        // 1. language_id für den Sprach-Code ('ru' liegt in D1; 'es' z.B. nicht).
        //    Ist die Sprache nicht in D1, fahren wir ohne serverseitige Ränge fort
        //    (für 'es' liefert das Frontend den Rang clientseitig via es_ranks.json).
        const langRow = await env.DB.prepare(
          `SELECT id FROM languages WHERE code = ?`
        ).bind(langCode).first();
        const languageId = langRow ? langRow.id : null;

        // 2. Original-Rang/CEFR aus Kelly-Wortliste (words-Tabelle) — nur wenn Sprache in D1
        let origRank = null, origCefr = null;
        if (languageId !== null) {
          const origRow = await env.DB.prepare(
            `SELECT rank, cefr_level FROM words WHERE language_id = ? AND lemma = ?`
          ).bind(languageId, lemma.toLowerCase()).first();
          if (origRow) { origRank = origRow.rank; origCefr = origRow.cefr_level; }
        }

        // 3. Prompt bauen — sprachenabhängig.
        //    Template mit den sprachspezifischen Beispiel-Wörtern gefüllt.
        const LANG_NAME = { ru: "Russian", es: "Spanish", de: "German" }[langCode] || langCode;
        const SCRIPT = { ru: "Cyrillic", es: "Latin", de: "Latin" }[langCode] || "Latin";
        const EX_WORD = { ru: "храбрый", es: "muchacho", de: "kaufmännisch" }[langCode] || "X";
        const EX_SYN = { ru: "смелый", es: "chico", de: "geschäftlich" }[langCode] || "Y";
        const synSystem =
          "You are an expert in " + LANG_NAME + " language and language pedagogy. " +
          "The reader is an English-speaking adult learner of " + LANG_NAME + " (CEFR A1/A2).\n\n" +
          "CRITICAL: You are working with " + LANG_NAME + " words. The input is a " +
          LANG_NAME + " word and the synonym you return MUST be a " + LANG_NAME +
          " word written in " + SCRIPT + " script. Do NOT translate to another language. " +
          "Do NOT return a Spanish/Latin synonym for a Russian word, or vice versa.\n\n" +
          "Your task: for the given " + LANG_NAME + " word, find ONE SIMPLER, MORE COMMON " +
          LANG_NAME + " synonym (in " + SCRIPT + " script) that such a learner would know, " +
          "and judge how well it preserves the meaning.\n\n" +
          "Return a JSON object with EXACTLY these keys:\n" +
          '  "synonym":      a SIMPLER, more common ' + LANG_NAME + ' lemma in ' + SCRIPT + ' script, or "" if none preserves the meaning\n' +
          '  "en_syn":       short English gloss of the synonym, or "" if synonym is ""\n' +
          '  "semantic_pct": integer 0-100: how completely the SYNONYM preserves the meaning. ' +
          "100 = perfect synonym (e.g. '" + EX_WORD + "'->'" + EX_SYN + "'). " +
          "Lower if it loses specificity, register, or nuance.\n" +
          '  "note":         very short reason if semantic_pct < 100, else ""\n\n' +
          "RULES:\n" +
          "- The synonym MUST be a real, common " + LANG_NAME + " word in lemma form, written in " + SCRIPT + " script.\n" +
          "- Prefer frequent everyday words over rare/literary ones.\n" +
          "- If no good simpler synonym exists, set synonym=\"\".\n" +
          "- Proper nouns, regionalisms, highly specific terms -> synonym=\"\".\n" +
          "- Return ONLY the JSON object. No prose, no code fences.";
        const synUser =
          LANG_NAME + ' word: "' + lemma + '"\n\nReturn ONLY the JSON object. The synonym must be a ' + LANG_NAME + ' word in ' + SCRIPT + ' script.';

        // 4. GLM aufrufen (Anthropic-Endpunkt, Retry + CJK-Validierung wie /api/simplify)
        let parsed = null;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
          try {
            const glmRes = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": env.GLM_API_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "glm-4.6",
                max_tokens: 300,
                system: synSystem,
                messages: [{ role: "user", content: synUser }],
                temperature: 0.3,
              }),
            });
            if (glmRes.ok) {
              const glmData = await glmRes.json();
              const contentParts = glmData.content || [];
              let candidate = contentParts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
                .trim();
              const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate);
              if (hasCJK) {
                lastError = "CJK-Zeichen in Ausgabe (Sprache verloren)";
                if (attempt > 0) break;
                continue;
              }
              // JSON aus der Antwort lösen (GLM packt es gelegentlich in Prosa/fences)
              let obj = null;
              try { obj = JSON.parse(candidate); }
              catch (_) {
                const start = candidate.indexOf("{");
                const end = candidate.lastIndexOf("}");
                if (start >= 0 && end > start) {
                  try { obj = JSON.parse(candidate.slice(start, end + 1)); } catch (__) {}
                }
              }
              if (obj && typeof obj === "object") {
                // Skript-Validierung: für Russisch muss das Synonym kyrillisch sein
                // (GLM driftet sonst ins Spanische/Lateinische ab, z.B. "grande").
                if (langCode === "ru" && obj.synonym) {
                  const synTrim = String(obj.synonym).trim();
                  const hasCyrillic = /[А-Яа-яЁё]/.test(synTrim);
                  if (!hasCyrillic) {
                    lastError = "Synonym nicht kyrillisch (Sprache verloren): " + synTrim.slice(0, 40);
                    if (attempt > 0) { parsed = obj; break; } // beim letzten Versuch trotzdem nehmen
                    continue; // retry
                  }
                }
                parsed = obj;
                break;
              }
              lastError = "Konnte JSON nicht parsen: " + candidate.slice(0, 120);
            } else {
              const errText = await glmRes.text();
              lastError = errText;
              if (!errText.includes("1302")) break;
            }
          } catch (e) {
            lastError = e.message;
          }
        }

        if (!parsed) {
          return json({ error: "GLM-Fehler: " + (lastError || "unbekannt") }, 502);
        }

        // 5. Synonym-Rang/CEFR nachschlagen (wenn ein Synonym geliefert wurde + Sprache in D1)
        let synRank = null, synCefr = null;
        const syn = (parsed.synonym || "").trim().toLowerCase();
        if (syn && languageId !== null) {
          const synRow = await env.DB.prepare(
            `SELECT rank, cefr_level FROM words WHERE language_id = ? AND lemma = ?`
          ).bind(languageId, syn).first();
          if (synRow) { synRank = synRow.rank; synCefr = synRow.cefr_level; }
        }

        return json({
          lemma,
          lang: langCode,
          orig_rank: origRank,
          orig_cefr: origCefr,
          synonym: parsed.synonym || "",
          en_syn: parsed.en_syn || "",
          semantic_pct: parsed.semantic_pct,
          note: parsed.note || "",
          syn_rank: synRank,
          syn_cefr: synCefr,
        });
      }

      // ─── Wörterbuch-Lookup via GLM (mit D1-Cache) ──────────────────
      // Ersatz für das frühere direkte Wiktionary-Popup im Frontend. GLM
      // liefert Lemma + POS + englische Gloss; das Ergebnis wird in
      // dict_cache pro (lemma, lang) gespeichert, sodass häufige Wörter
      // nach dem ersten Lookup kostenlos aus dem Cache kommen.
      if (path === "/api/dict" && request.method === "GET") {
        const url = new URL(request.url);
        const word = (url.searchParams.get("word") || "").trim();
        const langCode = (url.searchParams.get("lang") || "es").trim();
        if (!word) return json({ error: "word erforderlich" }, 400);

        // Tabelle idempotent anlegen (wie bug_reports / user_cards).
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS dict_cache (
            id INTEGER PRIMARY KEY,
            lemma TEXT NOT NULL,
            lang TEXT NOT NULL,
            pos TEXT,
            gloss TEXT,
            inflected TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(lemma, lang)
          )`
        ).run();
        await env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_dict_cache_lookup ON dict_cache(lemma, lang)`
        ).run();

        // 1) Cache prüfen (lowercase Lookup).
        const wordLc = word.toLowerCase();
        const cached = await env.DB.prepare(
          `SELECT lemma, pos, gloss, inflected FROM dict_cache WHERE lemma = ? AND lang = ?`
        ).bind(wordLc, langCode).first();
        if (cached) {
          return json({
            lemma: cached.lemma, pos: cached.pos || "", gloss: cached.gloss || "",
            inflected: cached.inflected || null, source: "cache",
          });
        }

        // 2) GLM aufrufen bei Cache-Miss.
        const LANG_NAME = { ru: "Russian", es: "Spanish", de: "German" }[langCode] || langCode;
        const SCRIPT = { ru: "Cyrillic", es: "Latin", de: "Latin" }[langCode] || "Latin";
        const dictSystem =
          "You are a bilingual " + LANG_NAME + "/English dictionary. " +
          "For the given " + LANG_NAME + " word (which may be inflected), return its base form " +
          "(lemma: infinitive for verbs, singular masculine for adjectives, singular for nouns) " +
          "and a concise English translation.\n\n" +
          "Return a JSON object with EXACTLY these keys:\n" +
          '  "lemma":  the ' + LANG_NAME + ' base form, in ' + SCRIPT + " script\n" +
          '  "pos":    part of speech (noun, verb, adjective, adverb, pronoun, etc.)\n' +
          '  "gloss":  the most common English meaning (1 short phrase, max 5 words)\n' +
          '  "notFound": true ONLY if the input is not a real ' + LANG_NAME + " word " +
          "(typo, proper noun, gibberish, or a word from another language)\n\n" +
          "RULES:\n" +
          "- The lemma MUST be written in " + SCRIPT + " script.\n" +
          "- Choose the everyday meaning; ignore rare senses.\n" +
          "- Return ONLY the JSON object. No prose, no code fences.";
        const dictUser =
          LANG_NAME + ' word: "' + word + '"\n\nReturn ONLY the JSON object.';

        let parsed = null;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
          try {
            const glmRes = await fetch("https://open.bigmodel.cn/api/anthropic/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": env.GLM_API_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "glm-4.6",
                max_tokens: 120,
                system: dictSystem,
                messages: [{ role: "user", content: dictUser }],
                temperature: 0.2,
              }),
            });
            if (!glmRes.ok) {
              const errText = await glmRes.text();
              if (!/1302|rate/i.test(errText)) {
                lastError = "HTTP " + glmRes.status;
                break;
              }
              lastError = "HTTP " + glmRes.status + " (rate?)";
              continue;
            }
            const gj = await glmRes.json();
            const candidate = (gj.content || [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("")
              .trim();
            // CJK-Guard: GLM hat die Sprache verloren.
            if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate)) {
              lastError = "CJK-Antwort";
              if (attempt < 2) continue;
            }
            // JSON extrahieren (mit Fallback auf {...}-Slice).
            try {
              parsed = JSON.parse(candidate);
            } catch (e) {
              const m = candidate.match(/\{[\s\S]*\}/);
              if (!m) { lastError = "kein JSON"; continue; }
              try { parsed = JSON.parse(m[0]); }
              catch (e2) { lastError = "JSON-Parse"; continue; }
            }
            // notFound kurzschließen — nicht cachen, nicht validieren.
            if (parsed.notFound === true) break;
            // Skript-Validierung für Russisch.
            if (langCode === "ru" && parsed.lemma && !/[А-Яа-яЁё]/.test(parsed.lemma)) {
              lastError = "Lemma nicht kyrillisch";
              if (attempt < 2) continue;
            }
            if (parsed.lemma && parsed.gloss) break;  // erfolgreich
            lastError = "unvollständig";
          } catch (e) {
            lastError = e.message;
          }
        }

        // 3) notFound → nicht cachen, Frontend zeigt „Nicht im Wörterbuch".
        if (parsed && parsed.notFound === true) {
          return json({ notFound: true });
        }
        if (!parsed || !parsed.lemma || !parsed.gloss) {
          return json({ error: "GLM-Fehler: " + (lastError || "unbekannt") }, 502);
        }

        // 4) Cache schreiben (lowercase Key, Original-Lemma im Wert).
        await env.DB.prepare(
          `INSERT OR REPLACE INTO dict_cache (lemma, lang, pos, gloss, inflected)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(wordLc, langCode, parsed.pos || null, parsed.gloss, parsed.inflected || null).run();

        return json({
          lemma: parsed.lemma, pos: parsed.pos || "", gloss: parsed.gloss,
          inflected: parsed.inflected || null, source: "glm",
        });
      }

      return json({ error: "Unbekannter Endpoint: " + path }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// Römische Zahlen für Chapter-Anzeige
function toRoman(num) {
  const map = [
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let result = "";
  for (const [v, s] of map) {
    while (num >= v) { result += s; num -= v; }
  }
  return result;
}

// RAG-Prompt bauen (v2 — dreistufiges Annotationssystem, bedeutungserhaltend)
function buildPrompt(text, level, hardWords) {
  const levelGuide = {
    C1: "C1 (advanced): Keep literary style, smooth nested sentences only slightly. Modern spelling.",
    B2: "B2 (intermediate): Break nested sentences into shorter ones. Replace rare words with common ones.",
    B1: "B1 (lower intermediate): Short simple sentences. Use basic vocabulary where possible.",
    A2: "A2 (elementary): Very simple sentences and basic vocabulary. Keep core meaning only.",
  };
  const guide = levelGuide[level] || levelGuide.B2;

  // Hard-Word-Liste als GUIDE (nicht als Befehl), nach CEFR absteigend sortiert
  let hardWordsSection = "";
  if (hardWords.length > 0) {
    const sorted = [...hardWords].sort(
      (a, b) => (CEFR_RANK[b.level] || 0) - (CEFR_RANK[a.level] || 0)
    );
    const list = sorted.map((w) => `- ${w.word} (${w.level})`).join("\n");
    hardWordsSection =
      `\n\nWords in this text that the Kelly dictionary tags ABOVE ${level} ` +
      `(use these as a GUIDE to spot difficulty, NOT as a command to replace):\n${list}\n`;
  }

  return {
    system:
      "You are an expert in Russian language and literature. " +
      "Your task is to SIMPLIFY Russian literary texts for German-speaking Russian learners, " +
      "while PRESERVING the exact meaning, historical accuracy, and social roles of all " +
      "characters and their titles.\n\n" +
      "The CEFR levels come from the Kelly project frequency dictionary (A1–C2 labels). " +
      "Use these levels as a GUIDE to spot potentially difficult words — NOT as a command " +
      "to replace them. A word's frequency in modern Russian does not determine whether " +
      "it can be replaced: meaning always wins over simplicity.\n\n" +
      "CRITICAL RULES:\n" +
      "- Your output MUST be in RUSSIAN only. Never translate to German or any other language.\n" +
      "- NEVER change the meaning. A simplification that alters meaning is a FAILURE.\n" +
      "- Return ONLY the simplified Russian text, no explanations, no introduction, no quotes.",
    user:
      `Simplify this Russian text to level ${level} (CEFR).\n\n` +
      `Style guide:\n- ${guide}\n\n` +
      `How to handle difficult words:\n` +
      `1. REPLACE a word if a true modern synonym with IDENTICAL meaning exists. ` +
      `This is the preferred action, especially for archaic everyday words ` +
      `(e.g. ибо → потому что, ежели → если, дабы → чтобы, зело → очень).\n` +
      `2. If no identical-meaning synonym exists AND the word is in the flag list below ` +
      `(it has a known Kelly level X), KEEP the original word and append [X] in square ` +
      `brackets — for example: князь [C2]. This signals "difficult, you may look it up."\n` +
      `3. If no identical-meaning synonym exists AND the word is NOT in the flag list ` +
      `(Kelly does not know it — very rare, archaic, or literary), KEEP the word and ` +
      `append [>C2] — for example: редчайше [>C2]. This signals "so rare it is not in the dictionary."\n\n` +
      `NEVER replace titles, ranks (князь, граф, император, государь...), proper names, ` +
      `or terms central to the story — even if they are rare today, they carry meaning ` +
      `that must not be lost. Mark them with [X] or [>C2] instead of replacing them.\n\n` +
      `General rules:\n` +
      `- Keep proper names (people, places)\n` +
      `- Output MUST be in Russian\n` +
      `- Return ONLY the simplified Russian text${hardWordsSection}\n\n` +
      `Text:\n${text}`,
  };
}
