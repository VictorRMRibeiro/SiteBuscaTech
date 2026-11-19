# Ativar o assistente com Gemini e salvar atendimentos

O site está preparado para chamar o Gemini somente pelo servidor do Supabase. A chave Gemini fica nos Secrets do Supabase, nunca no JavaScript público do site. O resumo do atendimento só é registrado quando o cliente escolhe “Sim, salvar o resumo”.

## 1. Criar as tabelas e os limites de uso

No Supabase, abra **SQL Editor > New query**. Primeiro, copie o conteúdo de `migrations/20261118000100_chatbot_cases.sql`, cole na consulta e clique em **Run**. Depois repita o processo com `migrations/20261119000100_service_order_tracking.sql` para habilitar os códigos privados de acompanhamento, status e orçamento. A tabela de atendimentos fica protegida por RLS e não pode ser lida ou gravada diretamente pelo navegador.

## 2. Publicar a Edge Function

Abra **Edge Functions > Deploy a new function > Via Editor**, crie a função `buscatech-chat` e substitua o código de exemplo pelo conteúdo de `functions/buscatech-chat/index.ts`. Clique em **Deploy function**. Depois, nas configurações da função, desative **Verify JWT**: o endpoint confere a chave publishable no código, e a verificação JWT antiga não aceita corretamente as novas chaves `sb_publishable_...`.

Em **Edge Functions > Secrets**, confirme que existe `GEMINI_API_KEY`. O Supabase fornece `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` ao ambiente da função; eles não devem ser copiados para o site.

## 3. Conectar o site

Em **Project Settings > API Keys**, copie o **Project URL** e a **Publishable key** (prefixo `sb_publishable_`). Preencha `supabaseUrl` e `publishableKey` em `chatbot-config.js`. Esses dois valores são destinados ao navegador. Não copie a Gemini API key, `sb_secret_...` ou `service_role` para esse arquivo.

## 4. Atualizar a Edge Function para acompanhamento

Se a função `buscatech-chat` já estiver publicada, abra **Edge Functions > buscatech-chat > Code** (ou **Edit**) e substitua o conteúdo pelo arquivo atualizado `functions/buscatech-chat/index.ts`. Clique em **Deploy updates**. Mantenha **Verify JWT** desativado, como descrito acima.

## 5. Publicar o site

Depois que a função e a configuração estiverem prontas, publique os arquivos atualizados do site no GitHub Pages. A função permite chamadas a partir de `https://victorrmribeiro.github.io`.

## Acompanhar um atendimento e responder ao orçamento

Quando o cliente autoriza salvar o resumo no chatbot, a função gera um código privado aleatório e o mostra ao cliente. Esse código permite consultar o andamento e aprovar ou recusar um orçamento pendente. A página retorna apenas status e dados do orçamento; nome, bairro e relato continuam privados. O cliente deve guardar o código e não compartilhá-lo.

Para atualizar um atendimento, no painel Supabase abra **Table Editor > public.chatbot_cases** e localize o cadastro. Edite a linha e salve:

- `service_status`: `received` (recebido), `diagnosis` (em avaliação), `quote_pending` (orçamento enviado), `approved` (aprovado), `in_service` (em execução), `ready` (pronto), `returned` (devolvido) ou `cancelled` (encerrado).
- Para oferecer orçamento, preencha `quote_description` e `quote_amount`, e defina `quote_status` como `pending`. Preencha os três campos juntos para cumprir as validações da tabela.
- A resposta do cliente altera `quote_status` para `approved` ou `declined`. Em caso de aprovação, `service_status` passa para `approved`; em caso de recusa, passa para `cancelled`. Depois, atualize o status de serviço conforme o trabalho avança.
- `updated_at` é atualizado automaticamente. Não altere `tracking_token`; ele funciona como credencial privada do cliente.

O histórico é um MVP operado pelo Table Editor; ainda não há painel administrativo próprio no site.

## Como o chat usa os dados

- O cliente escolhe se quer conversar com a IA; só então o equipamento e as mensagens do problema são enviados ao Gemini.
- O nome e o bairro não são enviados ao Gemini.
- O cliente escolhe separadamente se quer salvar o resumo na BuscaTech.
- O uso da IA tem um limite global de 200 chamadas por dia.
- As consultas e respostas de orçamento têm um limite global de 2.000 chamadas por dia.
- A tabela não guarda transcrição nem telefone; guarda o resumo autorizado com nome, equipamento, problema, modalidade e bairro.
