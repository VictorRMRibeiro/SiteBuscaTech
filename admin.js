(() => {
  const config = window.BUSCATECH_CHAT_CONFIG || {};
  const loginView = document.getElementById('login-view');
  const dashboardView = document.getElementById('dashboard-view');
  const loginForm = document.getElementById('login-form');
  const loginMessage = document.getElementById('login-message');
  const orderList = document.getElementById('order-list');
  const orderForm = document.getElementById('order-form');
  const saveMessage = document.getElementById('save-message');
  const dashboardMessage = document.getElementById('dashboard-message');
  if (!loginView || !dashboardView || !loginForm || !orderList || !orderForm) return;

  const sessionKey = 'buscatech-admin-session';
  const terminalStatuses = new Set(['returned', 'cancelled']);
  const statusLabels = {
    received: 'Solicitação recebida',
    diagnosis: 'Em avaliação',
    quote_pending: 'Orçamento enviado',
    approved: 'Aprovado',
    in_service: 'Em andamento',
    ready: 'Pronto',
    returned: 'Devolvido',
    cancelled: 'Encerrado'
  };
  const quoteLabels = {
    not_ready: 'Ainda não enviado ao cliente.',
    pending: 'Aguardando resposta do cliente.',
    approved: 'Cliente aprovou este orçamento.',
    declined: 'Cliente recusou este orçamento.'
  };

  let session = null;
  let orders = [];
  let selectedId = '';
  let activeFilter = 'all';

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch { return null; }
  }

  function saveSession(value) {
    session = value;
    try { sessionStorage.setItem(sessionKey, JSON.stringify(value)); } catch {}
  }

  function clearSession() {
    session = null;
    try { sessionStorage.removeItem(sessionKey); } catch {}
    orders = [];
    selectedId = '';
    dashboardView.hidden = true;
    loginView.hidden = false;
  }

  function persistAuthResult(result) {
    if (!result?.access_token || !result?.refresh_token) throw new Error('O Supabase não retornou uma sessão válida.');
    const next = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000
    };
    saveSession(next);
  }

  async function authRequest(path, body) {
    if (!config.supabaseUrl || !config.publishableKey) throw new Error('A conexão com o Supabase ainda não está configurada.');
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || data.error_description || 'Não foi possível entrar. Confira seu e-mail e sua senha.');
    return data;
  }

  async function refreshSession() {
    if (!session?.refreshToken) throw new Error('Sua sessão expirou. Entre novamente.');
    const result = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    persistAuthResult(result);
  }

  async function edgeRequest(action, payload = {}, mayRefresh = true) {
    if (!session?.accessToken) throw new Error('Entre novamente para continuar.');
    if (session.expiresAt <= Date.now() + 30000) {
      try { await refreshSession(); } catch { clearSession(); throw new Error('Sua sessão expirou. Entre novamente.'); }
    }
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/buscatech-chat`, {
      method: 'POST',
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && mayRefresh && session?.refreshToken) {
      try { await refreshSession(); return edgeRequest(action, payload, false); }
      catch { clearSession(); throw new Error('Sua sessão expirou. Entre novamente.'); }
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir esta ação.');
    return data;
  }

  function showNotice(element, message, isError = true) {
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle('is-success', Boolean(message) && !isError);
  }

  function formatDate(value, withTime = false) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.valueOf())) return '—';
    return date.toLocaleString('pt-BR', withTime
      ? { dateStyle: 'short', timeStyle: 'short' }
      : { dateStyle: 'medium' });
  }

  function getVisibleOrders() {
    const query = document.getElementById('search-orders').value.trim().toLocaleLowerCase('pt-BR');
    return orders.filter(order => {
      const statusMatches = activeFilter === 'all'
        || (activeFilter === 'open' && !terminalStatuses.has(order.serviceStatus))
        || (activeFilter === 'quote' && order.quoteStatus === 'pending')
        || (activeFilter === 'ready' && order.serviceStatus === 'ready');
      const searchMatches = !query || [order.customerName, order.device, order.neighborhood]
        .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query));
      return statusMatches && searchMatches;
    });
  }

  function renderStats() {
    document.getElementById('stat-open').textContent = orders.filter(order => !terminalStatuses.has(order.serviceStatus)).length;
    document.getElementById('stat-quotes').textContent = orders.filter(order => order.quoteStatus === 'pending').length;
    document.getElementById('stat-ready').textContent = orders.filter(order => order.serviceStatus === 'ready').length;
  }

  function renderList() {
    const visible = getVisibleOrders();
    document.getElementById('orders-count').textContent = `${visible.length} ${visible.length === 1 ? 'atendimento' : 'atendimentos'}`;
    orderList.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'list-empty';
      empty.textContent = orders.length ? 'Nenhum atendimento neste filtro.' : 'Ainda não há atendimentos salvos.';
      orderList.append(empty);
      return;
    }

    visible.forEach(order => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `order-list-item${order.id === selectedId ? ' is-selected' : ''}`;
      const top = document.createElement('span');
      top.className = 'order-list-top';
      const name = document.createElement('strong');
      name.className = 'order-list-name';
      name.textContent = order.customerName || 'Cliente';
      const status = document.createElement('span');
      status.className = `status-pill status-${order.serviceStatus}`;
      status.textContent = statusLabels[order.serviceStatus] || 'Em atualização';
      const description = document.createElement('p');
      description.textContent = [order.device, order.neighborhood].filter(Boolean).join(' · ');
      const bottom = document.createElement('span');
      bottom.className = 'order-list-bottom';
      const date = document.createElement('time');
      date.textContent = formatDate(order.createdAt);
      const quote = document.createElement('span');
      quote.className = 'order-quote-state';
      quote.textContent = order.quoteStatus === 'pending' ? 'Orçamento pendente' : '';
      bottom.append(date, quote);
      top.append(name, status);
      item.append(top, description, bottom);
      item.addEventListener('click', () => selectOrder(order.id));
      orderList.append(item);
    });
  }

  function appendSummary(root, label, value, wide = false) {
    const item = document.createElement('div');
    item.className = `summary-field${wide ? ' wide' : ''}`;
    const caption = document.createElement('span');
    caption.textContent = label.toUpperCase();
    const content = document.createElement(wide ? 'p' : 'strong');
    content.textContent = value || 'Não informado';
    item.append(caption, content);
    root.append(item);
  }

  function selectOrder(id) {
    const order = orders.find(item => item.id === id);
    if (!order) return;
    selectedId = id;
    document.getElementById('empty-detail').hidden = true;
    orderForm.hidden = false;
    document.getElementById('detail-title').textContent = order.customerName || 'Atendimento';
    document.getElementById('detail-created').textContent = `Recebido ${formatDate(order.createdAt)}`;
    const summary = document.getElementById('customer-summary');
    summary.replaceChildren();
    appendSummary(summary, 'Equipamento', order.device);
    appendSummary(summary, 'Modalidade', order.modality);
    appendSummary(summary, 'Bairro', order.neighborhood);
    appendSummary(summary, 'Preferência de retirada', order.pickupDay);
    appendSummary(summary, 'Relato do cliente', order.symptom, true);
    document.getElementById('service-status').value = order.serviceStatus || 'received';
    document.getElementById('quote-description').value = order.quoteDescription || '';
    document.getElementById('quote-amount').value = order.quoteAmount === null || order.quoteAmount === undefined
      ? '' : Number(order.quoteAmount).toFixed(2);
    document.getElementById('publish-quote').checked = order.quoteStatus === 'pending';
    document.getElementById('quote-state-note').textContent = quoteLabels[order.quoteStatus] || '';
    showNotice(saveMessage, '');
    renderList();
  }

  async function loadOrders(keepSelection = true) {
    const response = await edgeRequest('admin_list');
    orders = Array.isArray(response.orders) ? response.orders : [];
    if (!keepSelection || !orders.some(order => order.id === selectedId)) selectedId = '';
    renderStats();
    renderList();
    if (selectedId) selectOrder(selectedId);
    else {
      orderForm.hidden = true;
      document.getElementById('empty-detail').hidden = false;
    }
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = loginForm.querySelector('button[type="submit"]');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    button.disabled = true;
    button.firstChild.textContent = 'Validando acesso… ';
    showNotice(loginMessage, '');
    try {
      const result = await authRequest('token?grant_type=password', { email, password });
      persistAuthResult(result);
      const identity = await edgeRequest('admin_list');
      orders = Array.isArray(identity.orders) ? identity.orders : [];
      loginView.hidden = true;
      dashboardView.hidden = false;
      renderStats();
      renderList();
      orderForm.hidden = true;
      document.getElementById('empty-detail').hidden = false;
      document.getElementById('login-password').value = '';
    } catch (error) {
      clearSession();
      showNotice(loginMessage, error.message || 'Não foi possível entrar. Confira suas credenciais.');
    } finally {
      button.disabled = false;
      button.firstChild.textContent = 'Entrar na área da equipe ';
    }
  });

  document.getElementById('refresh-orders').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    showNotice(dashboardMessage, '');
    try { await loadOrders(); }
    catch (error) { showNotice(dashboardMessage, error.message); }
    finally { button.disabled = false; }
  });

  document.getElementById('search-orders').addEventListener('input', renderList);
  document.querySelectorAll('.filter-chip').forEach(button => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter || 'all';
      document.querySelectorAll('.filter-chip').forEach(item => item.classList.toggle('is-active', item === button));
      renderList();
    });
  });

  document.getElementById('publish-quote').addEventListener('change', event => {
    const order = orders.find(item => item.id === selectedId);
    if (event.currentTarget.checked) {
      document.getElementById('service-status').value = 'quote_pending';
      document.getElementById('quote-state-note').textContent = order?.quoteStatus === 'pending'
        ? 'O cliente poderá ver o orçamento atualizado assim que você salvar.'
        : 'O orçamento ficará disponível imediatamente na página de acompanhamento do cliente.';
    } else {
      if (document.getElementById('service-status').value === 'quote_pending') {
        document.getElementById('service-status').value = 'diagnosis';
      }
      document.getElementById('quote-state-note').textContent = order?.quoteStatus === 'pending'
        ? 'Ao salvar, o orçamento deixará de aguardar resposta.'
        : quoteLabels[order?.quoteStatus] || '';
    }
  });

  orderForm.addEventListener('submit', async event => {
    event.preventDefault();
    const order = orders.find(item => item.id === selectedId);
    if (!order) return;
    const publishQuote = document.getElementById('publish-quote').checked;
    const quoteDescription = document.getElementById('quote-description').value.trim();
    const amountInput = document.getElementById('quote-amount').value;
    if (publishQuote && (!quoteDescription || amountInput === '' || !Number.isFinite(Number(amountInput)) || Number(amountInput) < 0)) {
      showNotice(saveMessage, 'Para enviar o orçamento, informe a descrição e um valor válido.');
      return;
    }
    if (publishQuote && !window.confirm('Enviar este orçamento para o cliente agora? Ele ficará disponível na página de acompanhamento.')) return;

    const button = document.getElementById('save-order');
    button.disabled = true;
    button.firstChild.textContent = 'Salvando… ';
    showNotice(saveMessage, '');
    try {
      const result = await edgeRequest('admin_update', {
        caseId: order.id,
        serviceStatus: document.getElementById('service-status').value,
        quoteDescription,
        quoteAmount: amountInput === '' ? null : Number(amountInput),
        publishQuote
      });
      orders = orders.map(item => item.id === result.order.id ? result.order : item);
      renderStats();
      renderList();
      selectOrder(result.order.id);
      showNotice(saveMessage, publishQuote ? 'Salvo. O orçamento já está disponível para o cliente.' : 'As informações do atendimento foram atualizadas.', false);
    } catch (error) {
      showNotice(saveMessage, error.message || 'Não foi possível salvar. Atualize os dados e tente novamente.');
    } finally {
      button.disabled = false;
      button.firstChild.textContent = 'Salvar alterações ';
    }
  });

  document.getElementById('logout-button').addEventListener('click', async () => {
    const token = session?.accessToken;
    clearSession();
    showNotice(loginMessage, '');
    if (!token || !config.supabaseUrl || !config.publishableKey) return;
    try {
      await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` }
      });
    } catch {}
  });

  session = readSession();
  if (session?.accessToken) {
    loginView.hidden = true;
    dashboardView.hidden = false;
    loadOrders(false).catch(error => {
      clearSession();
      showNotice(loginMessage, error.message || 'Sua sessão expirou. Entre novamente.');
    });
  }
})();
