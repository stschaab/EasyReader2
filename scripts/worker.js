// EasyReader2 – Cloudflare Worker API
// Endpoints:
//   GET  /                        – health check
//   GET  /api/books               – alle Bücher
//   GET  /api/books/:id           – Buch mit allen Chunks + fertigen Levels
//   POST /api/simplify            – RAG-Vereinfachung { chunk_id, level }
//   POST /api/progress            – Lesefortschritt speichern
//   GET  /api/progress/:bookId    – Lesefortschritt laden
//   POST /api/bug-report          – Bug-Report mit optionalem Screenshot speichern
//   POST /api/synonym             – Synonym+Rang+EN für ein spanisches Wort (GLM, live)
//   GET  /api/admin/bug-reports   – Bug-Report-Liste (X-Admin-Key geschützt)
//   GET  /api/admin/bug-reports/:id – Einzelner Bug-Report mit Screenshot
//   POST /api/admin/words         – Kelly-Wortlisten-Import (X-Admin-Key geschützt)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Id",
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

        const chunksOut = chunks.results.map((c) => ({
          id: c.id,
          order_index: c.order_index,
          chapter: c.chapter_num ? "Т." + (c.volume || 1) + " · Ч." + (c.part || 1) + " · Гл. " + toRoman(c.chapter_num) : null,
          original: c.original_text,
          word_count: c.word_count,
          C1: "", B2: "", B1: "", A2: "",
        }));

        return json({ book, chunks: chunksOut });
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

      // ─── Admin: Bug-Report-Liste (letzte 50, ohne Screenshots) ───
      if (path === "/api/admin/bug-reports" && request.method === "GET") {
        const adminKey = request.headers.get("X-Admin-Key");
        if (adminKey !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
        const r = await env.DB.prepare(
          `SELECT id, user_id, version, book_id, chunk_index, level, description, user_agent, created_at,
                  (screenshot IS NOT NULL) AS has_screenshot
           FROM bug_reports ORDER BY created_at DESC LIMIT 50`
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
