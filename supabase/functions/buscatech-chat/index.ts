import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://victorrmribeiro.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

function json(body: Record<string, unknown>, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function env(name: string) {
  return Deno.env.get(name)?.trim() ?? "";
}

function allowedPublishableKeys() {
  const rawKeys = env("SUPABASE_PUBLISHABLE_KEYS");
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(rawKeys || "{}");
    keys = Object.values(parsed).filter((value): value is string => typeof value === "string");
  } catch {
    // Continue with the legacy anon key if the new key map is unavailable.
  }
  const legacyAnonKey = env("SUPABASE_ANON_KEY");
  if (legacyAnonKey) keys.push(legacyAnonKey);
  return keys;
}

function boundedText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function redactLikelyContactDetails(value: string) {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, "[e-mail removido]")
    .replace(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-.\s]?\d{4}/g, "[telefone removido]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}[-.]?\d{2}\b/g, "[documento removido]");
}

function getAdminClient() {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Supabase server credentials are not configured.");
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function checkDailyLimit(admin: ReturnType<typeof getAdminClient>) {
  const { data, error } = await admin.rpc("consume_chatbot_daily_limit", { p_limit: 200 });
  if (error) throw new Error("Unable to check the chatbot usage limit.");
  return data === true;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, origin);

  const apiKey = request.headers.get("apikey") ?? "";
  if (!apiKey || !allowedPublishableKeys().includes(apiKey)) {
    return json({ error: "Chave pública do Supabase inválida." }, 401, origin);
  }

  let body: Record<string, unknown>;
  try {
    const rawBody = await request.text();
    if (rawBody.length > 12000) return json({ error: "Mensagem muito longa." }, 413, origin);
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Não consegui ler essa mensagem." }, 400, origin);
  }

  let admin: ReturnType<typeof getAdminClient>;
  try {
    admin = getAdminClient();
    if (!(await checkDailyLimit(admin))) {
      return json({ error: "O assistente atingiu o limite diário. Você pode continuar pelo WhatsApp." }, 429, origin);
    }
  } catch {
    return json({ error: "O assistente está indisponível no momento." }, 503, origin);
  }

  if (body.action === "save") {
    if (body.consent !== true) return json({ error: "É necessário autorizar o registro." }, 400, origin);
    const row = {
      customer_name: boundedText(body.name, 80),
      device: boundedText(body.device, 80),
      symptom: boundedText(body.symptom, 500),
      modality: boundedText(body.modality, 80),
      pickup_day: boundedText(body.pickupDay, 40) || null,
      neighborhood: boundedText(body.neighborhood, 100),
      ai_consent: body.aiConsent === true,
      consent_at: new Date().toISOString(),
      privacy_notice_version: "2026-11-18",
    };
    if (!row.customer_name || !row.device || !row.symptom || !row.modality || !row.neighborhood) {
      return json({ error: "Faltam informações para registrar o atendimento." }, 400, origin);
    }
    const { error } = await admin.from("chatbot_cases").insert(row);
    if (error) return json({ error: "Não foi possível salvar o resumo agora." }, 503, origin);
    return json({ saved: true }, 200, origin);
  }

  if (body.action !== "chat") return json({ error: "Ação desconhecida." }, 400, origin);
  if (body.consent !== true) return json({ error: "É necessário autorizar o uso da IA." }, 400, origin);

  const device = boundedText(body.device, 80);
  const allMessages = Array.isArray(body.messages) ? body.messages : [];
  const messagesInput = allMessages.length > 8 ? [allMessages[0], ...allMessages.slice(-7)] : allMessages;
  const messages = messagesInput.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const role = record.role === "model" ? "model" : record.role === "user" ? "user" : "";
    const content = redactLikelyContactDetails(boundedText(record.content, 600));
    return role && content ? [{ role, parts: [{ text: content }] }] : [];
  });
  const firstUserMessage = messages.findIndex((message) => message.role === "user");
  if (!device || firstUserMessage < 0) return json({ error: "Informe o equipamento e o sintoma." }, 400, origin);
  const firstSymptom = messages[firstUserMessage].parts[0].text;
  const conversation = [
    { role: "user", parts: [{ text: `Equipamento: ${device}. Relato inicial: ${firstSymptom}` }] },
    ...messages.slice(firstUserMessage + 1),
  ];

  const geminiKey = env("GEMINI_API_KEY");
  if (!geminiKey) return json({ error: "A IA ainda não foi configurada." }, 503, origin);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "Você é o assistente de triagem da BuscaTech, assistência técnica de computadores no Distrito Federal. Converse em português do Brasil, com tom simples e acolhedor. Ajude a entender o sintoma, explique possibilidades sem afirmar um diagnóstico e faça uma pergunta curta por vez quando isso ajudar. Não peça nome, endereço, telefone, senha, código de verificação, dados bancários ou documentos. Não oriente a abrir fonte de alimentação, mexer em bateria inchada, tocar em componentes energizados, remover malware manualmente ou fazer algo que possa causar dano ou perda de dados. Se houver fumaça, cheiro de queimado, líquido ou bateria estufada, recomende desligar e desconectar da tomada se isso puder ser feito com segurança e procurar um técnico. Não prometa preço ou prazo; encaminhe orçamento e confirmação à equipe. Responda em até 4 frases." }],
          },
          contents: conversation,
          generationConfig: { temperature: 0.35, maxOutputTokens: 220 },
        }),
      },
    );
    if (!response.ok) return json({ error: "A IA não respondeu agora. Você pode continuar com a equipe." }, 502, origin);
    const result = await response.json();
    const reply = boundedText(
      result?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join(" "),
      1200,
    );
    if (!reply) return json({ error: "A IA não retornou uma orientação. Você pode continuar com a equipe." }, 502, origin);
    return json({ reply }, 200, origin);
  } catch {
    return json({ error: "A IA não está disponível agora. Você pode continuar com a equipe." }, 502, origin);
  }
});
