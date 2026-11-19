# Supabase do chatbot e dos registros internos

O site público apresenta os serviços da BuscaTech e oferece o assistente de triagem. A consulta pública por código de rastreio e a aprovação de orçamento pelo site foram retiradas. O andamento, os orçamentos e os agendamentos são combinados diretamente pelo WhatsApp.

## 1. Criar as tabelas

No Supabase, abra **SQL Editor > New query** e execute primeiro migrations/20261118000100_chatbot_cases.sql. Depois execute migrations/20261119000100_service_order_tracking.sql para os campos de andamento e orçamento usados internamente pela área da equipe. A tabela fica protegida por RLS e não pode ser lida ou gravada diretamente pelo navegador.

Se o banco já recebeu a versão anterior, os campos e os códigos antigos de rastreio permanecem guardados no banco, mas o site e a Edge Function atuais não os mostram nem os consultam. Não execute comandos para apagar esses dados.

## 2. Publicar a Edge Function

Abra **Edge Functions > Deploy a new function > Via Editor**, crie a função buscatech-chat e substitua o código de exemplo pelo conteúdo de functions/buscatech-chat/index.ts. Clique em **Deploy function**. Depois, nas configurações da função, desative **Verify JWT**: o endpoint confere a chave publishable no código.

Em **Edge Functions > Secrets**, confirme que existe GEMINI_API_KEY. O Supabase fornece SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY ao ambiente da função; eles não devem ser copiados para o site.

## 3. Conectar o site

Em **Project Settings > API Keys**, copie o **Project URL** e a **Publishable key** (prefixo sb_publishable_). Preencha supabaseUrl e publishableKey em chatbot-config.js. Esses dois valores são destinados ao navegador. Não copie a chave Gemini, sb_secret_ ou service_role para esse arquivo.

## 4. Publicar atualizações

Para atualizar o bot, abra **Edge Functions > buscatech-chat > Code/Edit**, cole o conteúdo atual de functions/buscatech-chat/index.ts e clique em **Deploy updates**. Mantenha **Verify JWT** desativado.

As alterações visuais do site são publicadas no GitHub Pages. A função aceita chamadas de https://victorrmribeiro.github.io.

## Área interna da equipe

A página admin.html consulta os registros autorizados do chatbot e permite atualizar internamente a etapa do serviço e guardar informações do orçamento. A área não envia o orçamento ao cliente. Combine valores, aprovações e andamento diretamente pelo WhatsApp.

1. Em **Authentication > Users**, crie e confirme um usuário para o e-mail administrador. Use uma senha forte e guarde-a no gerenciador de senhas.
2. Em **Edge Functions > Secrets**, crie BUSCATECH_ADMIN_EMAIL com exatamente o mesmo e-mail do usuário autorizado.
3. Publique a versão atual de functions/buscatech-chat/index.ts. Sem esse deploy e o secret de e-mail, a área da equipe não consegue carregar os atendimentos.
4. Acesse https://victorrmribeiro.github.io/SiteBuscaTech/admin.html e entre com o e-mail e senha autorizados. Selecione um atendimento para registrar o andamento e as informações internas do orçamento; depois fale com o cliente pelo WhatsApp.

O painel lista até 250 atendimentos recentes. Ele não mantém uma linha do tempo das alterações.

## Como o assistente usa os dados

- O cliente escolhe se quer conversar com a IA; só então o equipamento e as mensagens do problema são enviados ao Gemini.
- Nome e bairro não são enviados ao Gemini.
- O cliente escolhe separadamente se autoriza salvar o resumo na BuscaTech.
- O limite de uso da IA é de 200 chamadas por dia.
- A tabela não guarda transcrição nem telefone; guarda o resumo autorizado com nome, equipamento, problema, modalidade e bairro.