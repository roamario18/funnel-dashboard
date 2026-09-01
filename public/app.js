(function () {
  const statusLine = document.getElementById('statusLine');
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
    errorBanner.hidden = !message;
    errorBanner.textContent = message || '';
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
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      statusLine.textContent = 'Ключ не проверен';
      showError(json.error?.message || 'Не удалось прочитать ключ');
      return;
    }
    const d = json.data || {};
    portal = d.portal || '';
    statusLine.textContent = [d.portal, d.type, d.accessMode].filter(Boolean).join(' · ');
    showWarnings(d.warnings);
  }

  async function loadDashboard() {
    showError('');
    loginBanner.hidden = true;
    statusLine.textContent = (statusLine.textContent || '') + '';
    const res = await fetch(
      `/api/dashboard?period=${encodeURIComponent(period)}&categoryId=${encodeURIComponent(categoryId)}`,
      { credentials: 'same-origin' },
    );
    const json = await res.json().catch(() => ({}));
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
      showError(json.error?.message || 'Не удалось загрузить воронку');
      return;
    }
    const d = json.data || {};
    fillCategories(d.categories, d.categoryId);
    showWarnings(d.warnings);
    kpiOpen.textContent = money(d.kpis?.openAmount);
    kpiWon.textContent = String(d.kpis?.wonCount ?? 0);
    kpiAvg.textContent = money(d.kpis?.avgCheck);

    const stageRows = (d.stages || []).map((s) => `
      <tr>
        <td>${escapeHtml(s.name || s.stageId)}</td>
        <td>${escapeHtml(s.count)}</td>
        <td>${escapeHtml(money(s.amount))}</td>
      </tr>`).join('');
    fillTable(stagesTable, stagesEmpty, stageRows, (d.stages || []).some((s) => s.count > 0));
    if (!(d.stages || []).some((s) => s.count > 0)) {
      stagesEmpty.textContent = 'Нет сделок за выбранный период.';
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
  }

  chips.forEach((btn) => {
    btn.addEventListener('click', () => {
      period = btn.dataset.period;
      setActiveChip();
      loadDashboard().catch(() => showError('Сервер приложения недоступен'));
    });
  });

  categorySelect.addEventListener('change', () => {
    categoryId = categorySelect.value;
    loadDashboard().catch(() => showError('Сервер приложения недоступен'));
  });

  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  if (authError) {
    showError(`Ошибка входа: ${authError}`);
  }

  setActiveChip();
  loadMe()
    .then(() => loadDashboard())
    .catch(() => {
      statusLine.textContent = 'Нет связи с сервером';
      showError('Сервер приложения недоступен');
    });
})();
