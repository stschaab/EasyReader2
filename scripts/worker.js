export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!env.GLM_API_KEY) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const { text, level } = await request.json();
      const prompt = buildPrompt(text, level);

      // GLM mit automatischer Wiederholung bei Rate-Limit (Code 1302)
      // bis zu 2 Versuche (Original + 1 Wiederholung), kurze Pause
      let glmData = null;
      let lastError = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          // Kurz warten vor dem Wiederholungsversuch (1s)
          await new Promise((r) => setTimeout(r, 1000));
        }

        const glmResponse = await fetch(
          "https://api.z.ai/api/paas/v4/chat/completions",
          {
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
          }
        );

        if (glmResponse.ok) {
          glmData = await glmResponse.json();
          break; // Erfolg
        }

        const errText = await glmResponse.text();
        // Rate-Limit? → warten und erneut versuchen
        if (errText.includes('"code":"1302"') || errText.includes('"code": 1302')) {
          lastError = "rate-limit";
          continue; // nächster Versuch
        }
        // Anderer Fehler → nicht wiederholen
        lastError = errText;
        break;
      }

      if (!glmData) {
        const msg =
          lastError === "rate-limit"
            ? "Rate-Limit erreicht, bitte in wenigen Sekunden erneut tippen."
            : "GLM API error: " + lastError;
        return new Response(JSON.stringify({ error: msg }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const simplified = glmData.choices[0].message.content.trim();

      return new Response(JSON.stringify({ simplified }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};

function buildPrompt(text, level) {
  const levelGuide = {
    C1: "C1 (advanced): Keep the literary style and almost all vocabulary. Only slightly smooth nested sentences for better readability. Modern spelling.",
    B2: "B2 (intermediate): Break nested sentences into shorter ones. Replace rare or archaic words with more common ones. Keep the meaning and tone, but simplify the structure clearly.",
    B1: "B1 (lower intermediate): Use short, simple sentences. Replace rare words with basic vocabulary. Keep the meaning clear. Reduce complex grammar.",
    A2: "A2 (elementary): Use very simple sentences and basic vocabulary. Keep only the core meaning. Simple grammar only.",
  };

  const guide = levelGuide[level] || levelGuide.B2;

  return {
    system:
      "You are an expert in Russian language and literature. " +
      "Your task is to SIMPLIFY Russian literary texts for German-speaking Russian learners. " +
      "CRITICAL: Your output MUST be in RUSSIAN only. Never translate to German or any other language. " +
      "Return ONLY the simplified Russian text, no explanations, no quotes, no introduction.",
    user:
      "Simplify this Russian text to level " +
      level +
      " (CEFR).\n\nRules:\n- " +
      guide +
      "\n- Keep proper names (people, places)\n- Output MUST be in Russian\n- Return ONLY the simplified Russian text\n\nText:\n" +
      text,
  };
}
