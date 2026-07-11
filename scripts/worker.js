// EasyReader2 – Cloudflare Worker API
// Endpoints:
//   GET  /                        – health check
//   GET  /api/books               – alle Bücher
//   GET  /api/books/:id           – Buch mit allen Chunks + fertigen Levels
//   POST /api/simplify            – RAG-Vereinfachung { chunk_id, level }
//   POST /api/progress            – Lesefortschritt speichern
//   GET  /api/progress/:bookId    – Lesefortschritt laden

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

      // ─── Buch-Detail mit Chunks (nur Originaltext, ohne Vereinfachungen) ───
      // Vereinfachungen werden on-demand pro Chunk geladen (siehe /api/chunk/:id)
      // Sonst wird der Response zu gross und bricht ab.
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
          C1: "", B2: "", B1: "", A2: "",  // leer, werden on-demand geladen
        }));

        return json({ book, chunks: chunksOut });
      }

      // ─── Einzelner Chunk mit allen Vereinfachungen ───
      const chunkMatch = path.match(/^\/api\/chunk\/(\d+)$/);
      if (chunkMatch && request.method === "GET") {
        const chunkId = parseInt(chunkMatch[1], 10);
        const chunk = await env.DB.prepare(
          `SELECT id, book_id, original_text FROM chunks WHERE id = ?`
        ).bind(chunkId).first();
        if (!chunk) return json({ error: "Chunk nicht gefunden" }, 404);

        const sims = await env.DB.prepare(
          `SELECT level, simplified_text FROM simplifications WHERE chunk_id = ?`
        ).bind(chunkId).all();

        const levels = {};
        for (const s of sims.results) levels[s.level] = s.simplified_text;

        return json({
          id: chunk.id,
          original: chunk.original_text,
          C1: levels.C1 || "",
          B2: levels.B2 || "",
          B1: levels.B1 || "",
          A2: levels.A2 || "",
        });
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
        // Alle Wörter im Chunk gegen die Wortliste prüfen
        const targetRank = CEFR_RANK[level];
        const wordRegex = new RegExp("[А-Яа-яЁё]+", "g");
        const tokens = chunk.original_text.match(wordRegex) || [];
        const uniqueTokens = [...new Set(tokens.map((t) => t.toLowerCase()))];

        const hardWords = [];
        for (const token of uniqueTokens.slice(0, 40)) {
          const word = await env.DB.prepare(
            `SELECT lemma, cefr_level FROM words WHERE language_id = ? AND lemma = ?`
          ).bind(chunk.language_id, token).first();
          if (word && CEFR_RANK[word.cefr_level] > targetRank) {
            hardWords.push({ word: word.lemma, level: word.cefr_level });
          }
        }

        // 4. Prompt bauen
        const prompt = buildPrompt(chunk.original_text, level, hardWords);

        // 5. GLM aufrufen (mit Retry bei Rate-Limit)
        let simplified = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
          try {
            const glmRes = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + env.GLM_API_KEY,
              },
              body: JSON.stringify({
                model: "glm-4.5-flash",
                messages: [
                  { role: "system", content: prompt.system },
                  { role: "user", content: prompt.user },
                ],
                temperature: 0.3,
              }),
            });
            if (glmRes.ok) {
              const glmData = await glmRes.json();
              simplified = glmData.choices[0].message.content.trim();
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
           VALUES (?, ?, ?, 'rag', 'glm-4.5-flash')`
        ).bind(chunk_id, level, simplified).run();

        return json({ simplified, source: "rag", hard_words: hardWords.length });
      }

      // ─── Lesefortschritt speichern ───
      if (path === "/api/progress" && request.method === "POST") {
        const { book_id, chunk_index, level } = await request.json();
        if (!book_id) return json({ error: "book_id erforderlich" }, 400);
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

// RAG-Prompt bauen
function buildPrompt(text, level, hardWords) {
  const levelGuide = {
    C1: "C1 (advanced): Keep literary style, smooth nested sentences only slightly. Modern spelling.",
    B2: "B2 (intermediate): Break nested sentences into shorter ones. Replace rare words with common ones.",
    B1: "B1 (lower intermediate): Short simple sentences. Replace rare words with basic vocabulary.",
    A2: "A2 (elementary): Very simple sentences and basic vocabulary. Keep core meaning only.",
  };
  const guide = levelGuide[level] || levelGuide.B2;

  let hardWordsSection = "";
  if (hardWords.length > 0) {
    const list = hardWords.map((w) => `- ${w.word} (${w.level})`).join("\n");
    hardWordsSection = `\n\nThese words are ABOVE ${level} and MUST be replaced with simpler equivalents:\n${list}\n`;
  }

  return {
    system:
      "You are an expert in Russian language and literature. " +
      "Your task is to SIMPLIFY Russian literary texts for German-speaking Russian learners. " +
      "CRITICAL: Your output MUST be in RUSSIAN only. Never translate to German or any other language. " +
      "Return ONLY the simplified Russian text, no explanations, no quotes, no introduction.",
    user:
      `Simplify this Russian text to level ${level} (CEFR).\n\nRules:\n- ${guide}\n- Keep proper names (people, places)\n- Output MUST be in Russian\n- Return ONLY the simplified Russian text${hardWordsSection}\n\nText:\n${text}`,
  };
}
