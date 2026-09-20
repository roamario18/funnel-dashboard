(function () {
  const statusLine = document.getElementById('statusLine');
  const loadBanner = document.getElementById('loadBanner');
  const errorBanner = document.getElementById('errorBanner');
  const warnList = document.getElementById('warnList');
  const loginBanner = document.getElementById('loginBanner');
  const kpiOpen = document.getElementById('kpiOpen');
  const kpiWon = document.getElementById('kpiWon');
  const kpiAvg = document.getElementById('kpiAvg');
  const stagesEmpty = document.getElementById('stagesEmpty');
  const stagesTable = document.getElementById('stagesTable');
  const dealsEmpty = document.getElementById('dealsEmpty');
  const dealsTable = document.getElementById('dealsTable');
  const chips = [...document.querySelectorAll('.chip[data-period]')];
  const categorySelect = document.getElementById('categorySelect');

  let period = '30';
  let categoryId = '0';
  let portal = '';
  let dashSeq = 0;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(amount, currency) {
    const n = Number(amount) || 0;
    try {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: currency || 'RUB',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `${n.toFixed(2)} ${currency || ''}`.trim();
    }
  }

  function showError(message) {
    const text = String(message || '');
    const friendly = /gateway did not get a response/i.test(text)
      ? 'Шлюз не дождался ответа приложения. Подождите и обновите страницу, не переключайте период повторно.'
      : text;
    if (!errorBanner) return;
    errorBanner.hidden = !friendly;
    errorBanner.textContent = friendly;
  }

  async function readBody(res) {
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { json, text };
  }

  function setLoading(on) {
    document.body.classList.toggle('is-loading', on);
    if (loadBanner) loadBanner.hidden = !on;
    chips.forEach((btn) => {
      btn.disabled = on;
    });
    if (categorySelect) categorySelect.disabled = on;
    if (on) {
      if (kpiOpen) kpiOpen.textContent = '…';
      if (kpiWon) kpiWon.textContent = '…';
      if (kpiAvg) kpiAvg.textContent = '…';
      if (stagesEmpty) {
        stagesEmpty.hidden = false;
        stagesEmpty.textContent = 'Считаем суммы по стадиям…';
      }
      if (stagesTable) stagesTable.hidden = true;
      if (dealsTable && dealsEmpty && !(dealsTable.tBodies[0] && dealsTable.tBodies[0].rows.length)) {
        dealsEmpty.hidden = false;
        dealsEmpty.textContent = 'Загрузка сделок…';
        dealsTable.hidden = true;
      }
    }
  }

  function showWarnings(items) {
    if (!items || !items.length) {
      warnList.hidden = true;
      warnList.innerHTML = '';
      return;
    }
    warnList.hidden = false;
    warnList.innerHTML = '';
    items.forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      warnList.appendChild(li);
    });
  }

  function fillCategories(list, selectedId) {
    const items = Array.isArray(list) && list.length ? list : [{ id: 0, name: 'Общая' }];
    const current = String(selectedId ?? categoryId);
    categorySelect.innerHTML = items
      .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
      .join('');
    categorySelect.value = items.some((c) => String(c.id) === current) ? current : String(items[0].id);
    categoryId = categorySelect.value;
  }

  function setActiveChip() {
    chips.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.period === period);
    });
  }

  function fillTable(table, emptyEl, rowsHtml, hasRows) {
    emptyEl.hidden = hasRows;
    table.hidden = !hasRows;
    table.tBodies[0].innerHTML = rowsHtml;
  }

  async function loadMe() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const { json } = await readBody(res);
    if (!res.ok || !json.success) {
      statusLine.textContent = 'Ключ не проверен';
      return;
    }
    const d = json.data || {};
    portal = d.portal || '';
    statusLine.textContent = [d.portal, d.type, d.accessMode].filter(Boolean).join(' · ');
  }

  async function loadDashboard() {
    const seq = ++dashSeq;
    setLoading(true);
    showError('');
    try {
    const res = await fetch(
      `/api/dashboard?period=${encodeURIComponent(period)}&categoryId=${encodeURIComponent(categoryId)}`,
      { credentials: 'same-origin' },
    );
    const { json, text } = await readBody(res);
    if (seq !== dashSeq) return;
    loginBanner.hidden = true;
    if (res.status === 401 || json.error?.code === 'TOKEN_MISSING' || json.error?.code === 'SESSION_REQUIRED') {
      loginBanner.hidden = false;
      fillTable(stagesTable, stagesEmpty, '', false);
      fillTable(dealsTable, dealsEmpty, '', false);
      stagesEmpty.textContent = 'Нужна авторизация.';
      dealsEmpty.textContent = 'Нужна авторизация.';
      kpiOpen.textContent = '—';
      kpiWon.textContent = '—';
      kpiAvg.textContent = '—';
      if (json.error?.message) showError(json.error.message);
      return;
    }
    if (!res.ok || !json.success) {
      const failText = json.error?.message || text || 'Не удалось загрузить воронку';
      showError(failText);
      fillTable(stagesTable, stagesEmpty, '', false);
      fillTable(dealsTable, dealsEmpty, '', false);
      stagesEmpty.textContent = failText;
      dealsEmpty.textContent = failText;
      kpiOpen.textContent = '—';
      kpiWon.textContent = '—';
      kpiAvg.textContent = '—';
      return;
    }
    showError('');
    const d = json.data || {};
    fillCategories(d.categories, d.categoryId);
    showWarnings(d.warnings);
    kpiOpen.textContent = money(d.kpis?.openAmount);
    kpiWon.textContent = String(d.kpis?.wonCount ?? 0);
    kpiAvg.textContent = money(d.kpis?.avgCheck);

    const hasStageCounts = (d.stages || []).some((s) => s.count > 0);
    const stageRows = (d.stages || []).map((s) => `
      <tr>
        <td>${escapeHtml(s.name || s.stageId)}</td>
        <td>${escapeHtml(s.count)}</td>
        <td>${escapeHtml(money(s.amount))}</td>
      </tr>`).join('');
    fillTable(stagesTable, stagesEmpty, stageRows, hasStageCounts);
    if (!hasStageCounts) {
      stagesEmpty.textContent = d.aggregateFailed
        ? 'Не удалось полностью посчитать стадии.'
        : 'Нет сделок за выбранный период.';
    }

    const dealRows = (d.recentDeals || []).map((deal) => {
      const href = portal
        ? `https://${portal}/crm/deal/details/${encodeURIComponent(deal.id)}/`
        : '';
      const title = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(deal.title)}</a>`
        : escapeHtml(deal.title);
      return `
        <tr>
          <td>${title}</td>
          <td>${escapeHtml(money(deal.amount, deal.currency))}</td>
          <td>${escapeHtml(deal.stageName || deal.stageId)}</td>
          <td>${escapeHtml(deal.assignedName || '—')}</td>
        </tr>`;
    }).join('');
    fillTable(dealsTable, dealsEmpty, dealRows, (d.recentDeals || []).length > 0);
    if (!(d.recentDeals || []).length) {
      dealsEmpty.textContent = 'Нет сделок за выбранный период.';
    }
    } finally {
      if (seq === dashSeq) setLoading(false);
    }
  }

  chips.forEach((btn) => {
    btn.addEventListener('click', () => {
      period = btn.dataset.period;
      setActiveChip();
      loadDashboard().catch((err) => showError(err && err.message ? err.message : 'Не удалось обновить воронку'));
    });
  });

  if (categorySelect) {
    categorySelect.addEventListener('change', () => {
      categoryId = categorySelect.value;
      loadDashboard().catch((err) => showError(err && err.message ? err.message : 'Не удалось обновить воронку'));
    });
  }

  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  if (authError) {
    showError(`Ошибка входа: ${authError}`);
  }

  setActiveChip();
  loadMe().catch(() => {
    if (statusLine) statusLine.textContent = 'Ключ не проверен';
  });
  loadDashboard().catch((err) => {
    showError(err && err.message ? err.message : 'Не удалось загрузить воронку');
  });
})();
