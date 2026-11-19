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
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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

async function checkServiceOrderDailyLimit(admin: ReturnType<typeof getAdminClient>) {
  const { data, error } = await admin.rpc("consume_service_order_daily_limit", { p_limit: 2000 });
  if (error) throw new Error("Unable to check the service order usage limit.");
  return data === true;
}

function publicOrder(order: Record<string, unknown>) {
  return {
    serviceStatus: order.service_status,
    quoteStatus: order.quote_status,
    quoteDescription: order.quote_description,
    quoteAmount: order.quote_amount,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

const serviceStatuses = new Set([
  "received", "diagnosis", "quote_pending", "approved",
  "in_service", "ready", "returned", "cancelled",
]);

const adminOrderColumns = "id, customer_name, device, symptom, modality, pickup_day, neighborhood, service_status, quote_status, quote_description, quote_amount, created_at, updated_at";

function adminOrder(order: Record<string, unknown>) {
  return {
    id: order.id,
    customerName: order.customer_name,
    device: order.device,
    symptom: order.symptom,
    modality: order.modality,
    pickupDay: order.pickup_day,
    neighborhood: order.neighborhood,
    serviceStatus: order.service_status,
    quoteStatus: order.quote_status,
    quoteDescription: order.quote_description,
    quoteAmount: order.quote_amount,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function authorizedAdmin(request: Request, apiKey: string) {
  const expectedEmail = env("BUSCATECH_ADMIN_EMAIL").toLowerCase();
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!expectedEmail || !bearer) return false;

  const authClient = createClient(env("SUPABASE_URL"), apiKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(bearer);
  return !error && data.user?.email_confirmed_at != null &&
    data.user.email?.toLowerCase() === expectedEmail;
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
  } catch {
    return json({ error: "O assistente está indisponível no momento." }, 503, origin);
  }

  if (body.action === "chat") {
    try {
      if (!(await checkDailyLimit(admin))) {
        return json({ error: "O assistente atingiu o limite diário. Você pode continuar pelo WhatsApp." }, 429, origin);
      }
    } catch {
      return json({ error: "O assistente está indisponível no momento." }, 503, origin);
    }
  }

  if (body.action === "order_lookup" || body.action === "quote_response") {
    try {
      if (!(await checkServiceOrderDailyLimit(admin))) {
        return json({ error: "O limite diário de consultas foi atingido. Tente novamente mais tarde ou fale com a equipe." }, 429, origin);
      }
    } catch {
      return json({ error: "O acompanhamento está indisponível no momento." }, 503, origin);
    }
  }

  if (body.action === "admin_list" || body.action === "admin_update") {
    try {
      if (!(await authorizedAdmin(request, apiKey))) {
        return json({ error: "Esta conta não tem acesso à área da equipe." }, 403, origin);
      }
    } catch {
      return json({ error: "Não foi possível validar o acesso da equipe." }, 503, origin);
    }

    if (body.action === "admin_list") {
      const { data, error } = await admin
        .from("chatbot_cases")
        .select(adminOrderColumns)
        .order("created_at", { ascending: false })
        .limit(250);
      if (error) return json({ error: "Não foi possível carregar os atendimentos." }, 503, origin);
      return json({ orders: (data ?? []).map((order) => adminOrder(order)) }, 200, origin);
    }

    const caseId = boundedText(body.caseId, 36);
    const serviceStatus = boundedText(body.serviceStatus, 32);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(caseId)) {
      return json({ error: "Atendimento inválido." }, 400, origin);
    }
    if (!serviceStatuses.has(serviceStatus)) {
      return json({ error: "Escolha um status de atendimento válido." }, 400, origin);
    }

    const { data: current, error: currentError } = await admin
      .from("chatbot_cases")
      .select(adminOrderColumns)
      .eq("id", caseId)
      .maybeSingle();
    if (currentError) return json({ error: "Não foi possível abrir este atendimento." }, 503, origin);
    if (!current) return json({ error: "Atendimento não encontrado." }, 404, origin);

    const publishQuote = body.publishQuote === true;
    const isQuoteDecisionFinal = current.quote_status === "approved" || current.quote_status === "declined";
    const quoteDescription = boundedText(body.quoteDescription, 1000) || null;
    const rawAmount = body.quoteAmount;
    const quoteAmount = rawAmount === null || rawAmount === undefined || rawAmount === ""
      ? null
      : Number(rawAmount);

    if (quoteAmount !== null && (!Number.isFinite(quoteAmount) || quoteAmount < 0 || quoteAmount > 99999999.99)) {
      return json({ error: "Informe um valor de orçamento válido." }, 400, origin);
    }
    if (publishQuote && (!quoteDescription || quoteAmount === null || !Number.isFinite(quoteAmount) || quoteAmount < 0 || quoteAmount > 99999999.99)) {
      return json({ error: "Para enviar o orçamento, informe a descrição e um valor válido." }, 400, origin);
    }

    const quoteStatus = publishQuote
      ? "pending"
      : current.quote_status === "pending" ? "not_ready" : current.quote_status;
    const update = {
      service_status: serviceStatus,
      quote_status: quoteStatus,
      quote_description: isQuoteDecisionFinal && !publishQuote ? current.quote_description : quoteDescription,
      quote_amount: isQuoteDecisionFinal && !publishQuote ? current.quote_amount : quoteAmount,
      quote_decided_at: publishQuote ? null : current.quote_decided_at,
    };
    const { data: updated, error: updateError } = await admin
      .from("chatbot_cases")
      .update(update)
      .eq("id", caseId)
      .eq("quote_status", current.quote_status)
      .select(adminOrderColumns)
      .maybeSingle();
    if (updateError) return json({ error: "Não foi possível salvar as alterações." }, 503, origin);
    if (!updated) return json({ error: "Este atendimento mudou enquanto estava aberto. Atualize a lista e tente novamente." }, 409, origin);
    return json({ order: adminOrder(updated) }, 200, origin);
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
      privacy_notice_version: "2026-11-19",
    };
    if (!row.customer_name || !row.device || !row.symptom || !row.modality || !row.neighborhood) {
      return json({ error: "Faltam informações para registrar o atendimento." }, 400, origin);
    }
    const { data, error } = await admin.from("chatbot_cases").insert(row).select("tracking_token").single();
    if (error) return json({ error: "Não foi possível salvar o resumo agora." }, 503, origin);
    return json({ saved: true, trackingToken: data.tracking_token }, 200, origin);
  }

  if (body.action === "order_lookup" || body.action === "quote_response") {
    const trackingToken = boundedText(body.trackingToken, 64).toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(trackingToken)) {
      return json({ error: "Confira o código de acompanhamento e tente novamente." }, 400, origin);
    }

    const { data: order, error } = await admin
      .from("chatbot_cases")
      .select("id, service_status, quote_status, quote_description, quote_amount, created_at, updated_at")
      .eq("tracking_token", trackingToken)
      .maybeSingle();
    if (error) return json({ error: "Não foi possível consultar o atendimento agora." }, 503, origin);
    if (!order) return json({ error: "Não encontrei um atendimento com esse código. Confira os caracteres e tente de novo." }, 404, origin);

    if (body.action === "order_lookup") {
      return json({ order: publicOrder(order) }, 200, origin);
    }

    if (body.decision !== "approve" && body.decision !== "decline") {
      return json({ error: "Escolha aprovar ou recusar o orçamento." }, 400, origin);
    }
    if (order.quote_status !== "pending") {
      return json({ error: "Este orçamento não está aguardando uma resposta." }, 409, origin);
    }

    const approved = body.decision === "approve";
    const { data: updatedOrder, error: updateError } = await admin
      .from("chatbot_cases")
      .update({
        quote_status: approved ? "approved" : "declined",
        service_status: approved ? "approved" : "cancelled",
        quote_decided_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("quote_status", "pending")
      .select("service_status, quote_status, quote_description, quote_amount, created_at, updated_at")
      .maybeSingle();
    if (updateError) return json({ error: "Não foi possível registrar sua resposta agora." }, 503, origin);
    if (!updatedOrder) return json({ error: "Este orçamento já recebeu uma resposta." }, 409, origin);
    return json({ order: publicOrder(updatedOrder) }, 200, origin);
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
            parts: [{ text: "Você é o assistente de triagem da BuscaTech, assistência técnica de computadores no Distrito Federal. Converse em português do Brasil, com tom simples e acolhedor. Ajude a entender o sintoma, explique possibilidades sem afirmar um diagnóstico e faça uma pergunta curta por vez quando isso ajudar. A BuscaTech oferece formatação com ou sem backup, limpeza de desktop e notebook, instalação de SSD ou RAM, remoção de vírus, diagnóstico, montagem de computador, configuração inicial e transferência de até 100 GB para computador novo, instalação de impressora por USB ou Wi-Fi, configuração básica de rede Wi-Fi doméstica e atualização de sistema e drivers. Os preços publicados são valores iniciais de mão de obra, sujeitos à confirmação conforme o escopo; peças, licenças, cabeamento e deslocamento podem ser cobrados à parte. O atendimento pode ser em casa ou com retirada combinada para a oficina. Não invente serviços, preço final, cobertura ou horário; confirme com a equipe. Não peça nome, endereço, telefone, senha, código de verificação, dados bancários ou documentos. Não oriente a abrir fonte de alimentação, mexer em bateria inchada, tocar em componentes energizados, remover malware manualmente ou fazer algo que possa causar dano ou perda de dados. Se houver fumaça, cheiro de queimado, líquido ou bateria estufada, recomende desligar e desconectar da tomada se isso puder ser feito com segurança e procurar um técnico. Não prometa preço ou prazo; encaminhe orçamento e confirmação à equipe. Responda em até 4 frases." }],
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
