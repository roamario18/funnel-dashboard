'use strict';

const { vibeFetch } = require('./vibe');
const { parsePeriod, parseCategoryId, dealFilter } = require('./period');

function formatUser(user) {
  if (!user || typeof user !== 'object') return '';
  const parts = [user.lastName, user.name, user.secondName].filter((p) => p && String(p).trim());
  return parts.join(' ').trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function loadStages(categoryId, authorization) {
  const entityId = categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
  const json = await vibeFetch(
    `/v1/statuses?filter[entityId]=${encodeURIComponent(entityId)}`,
    { authorization },
  );
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .slice()
    .sort((a, b) => num(a.sort) - num(b.sort))
    .map((s) => ({
      id: String(s.statusId || s.id || ''),
      name: s.name || String(s.statusId || ''),
      semantics: s.semantics || null,
      sort: num(s.sort),
    }))
    .filter((s) => s.id);
}

async function loadUsers(ids, authorization) {
  const unique = [...new Set(ids.filter((id) => id !== undefined && id !== null && id !== '').map(String))];
  const map = {};
  if (!unique.length) return map;

  try {
    const json = await vibeFetch('/v1/users/search', {
      method: 'POST',
      authorization,
      body: {
        filter: { id: { $in: unique.map((id) => Number(id)).filter(Number.isFinite) } },
        select: ['id', 'name', 'lastName', 'secondName'],
        limit: Math.min(50, unique.length),
      },
    });
    for (const user of json.data || []) {
      map[String(user.id)] = formatUser(user) || `ID ${user.id}`;
    }
  } catch (err) {
    const status = Number(err.status) || 0;
    const transient = status === 0 || status >= 500;
    if (!transient) {
      for (const id of unique) map[id] = `ID ${id}`;
      return map;
    }
    await Promise.all(
      unique.slice(0, 20).map(async (id) => {
        try {
          const json = await vibeFetch(`/v1/users/${encodeURIComponent(id)}`, { authorization });
          const user = json.data || {};
          map[id] = formatUser(user) || `ID ${id}`;
        } catch {
          map[id] = `ID ${id}`;
        }
      }),
    );
  }

  for (const id of unique) {
    if (!map[id]) map[id] = `ID ${id}`;
  }
  return map;
}

async function loadCategories(authorization) {
  const json = await vibeFetch('/v1/categories/2?limit=200', { authorization });
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows
    .filter((c) => c && (c.isLocked === undefined || c.isLocked === false))
    .sort((a, b) => num(a.sort) - num(b.sort))
    .map((c) => ({
      id: num(c.id),
      name: c.name || (num(c.id) === 0 ? 'Общая' : `Воронка ${c.id}`),
      isDefault: Boolean(c.isDefault),
    }));
}

function currencyCode(value) {
  return String(value || 'RUB').trim().toUpperCase() || 'RUB';
}

async function loadRubRates(authorization) {
  const json = await vibeFetch('/v1/currencies?limit=200', { authorization });
  const rows = Array.isArray(json.data) ? json.data : [];
  const toBase = {};
  let baseId = 'RUB';
  for (const row of rows) {
    const id = currencyCode(row.id);
    const cnt = num(row.amountCnt) || 1;
    const amount = num(row.amount);
    if (row.base) {
      baseId = id;
      toBase[id] = 1;
    } else if (cnt > 0 && amount > 0) {
      toBase[id] = amount / cnt;
    }
  }
  const toRub = {};
  if (baseId === 'RUB') {
    Object.assign(toRub, toBase);
  } else {
    const rubToBase = toBase.RUB;
    if (!rubToBase) return { RUB: 1 };
    for (const [id, rate] of Object.entries(toBase)) {
      toRub[id] = rate / rubToBase;
    }
  }
  if (!toRub.RUB) toRub.RUB = 1;
  return toRub;
}

function amountToRub(amount, currency, rates) {
  const code = currencyCode(currency);
  const rate = rates[code];
  if (rate == null) return { value: num(amount), converted: false, code };
  return { value: num(amount) * rate, converted: code !== 'RUB', code, rate };
}

async function loadDashboard(query, authorization) {
  const period = parsePeriod(query);
  const requestedId = parseCategoryId(query);
  const categories = await loadCategories(authorization);
  const known = new Set(categories.map((c) => c.id));
  const categoryId = known.has(requestedId)
    ? requestedId
    : (categories.find((c) => c.isDefault) || categories[0] || { id: 0 }).id;
  const category = categories.find((c) => c.id === categoryId) || { id: categoryId, name: 'Общая' };
  const filter = dealFilter(period, categoryId);

  const [stages, searchJson, rates] = await Promise.all([
    loadStages(categoryId, authorization),
    vibeFetch('/v1/deals/search', {
      method: 'POST',
      authorization,
      body: {
        filter,
        limit: 5000,
        order: { createdAt: 'desc' },
        select: ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'],
      },
    }),
    loadRubRates(authorization).catch(() => ({ RUB: 1 })),
  ]);

  const deals = Array.isArray(searchJson.data) ? searchJson.data : [];
  const meta = searchJson.meta || {};
  const truncated = Boolean(meta.truncated || meta.hasMore || deals.length >= 5000);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const stageStats = new Map();
  for (const stage of stages) {
    stageStats.set(stage.id, { count: 0, amount: 0, semantics: stage.semantics, name: stage.name });
  }

  const currencies = new Set();
  const convertedCodes = new Set();
  const unknownCodes = new Set();
  let totalRub = 0;
  let openAmount = 0;
  let wonCount = 0;

  for (const deal of deals) {
    const code = currencyCode(deal.currency || deal.currencyId);
    currencies.add(code);
    const converted = amountToRub(deal.amount, code, rates);
    if (converted.converted) convertedCodes.add(code);
    if (rates[code] == null) unknownCodes.add(code);
    const rub = converted.value;
    totalRub += rub;
    const stageId = String(deal.stageId || '');
    if (!stageStats.has(stageId)) {
      stageStats.set(stageId, { count: 0, amount: 0, semantics: null, name: stageId || '—' });
    }
    const row = stageStats.get(stageId);
    row.count += 1;
    row.amount += rub;
    const semantics = (stageById.get(stageId) || row).semantics;
    if (semantics === 'S') wonCount += 1;
    else if (semantics !== 'F') openAmount += rub;
  }

  const stagesOut = [...stageStats.entries()].map(([stageId, row]) => ({
    stageId,
    name: row.name,
    semantics: row.semantics,
    count: row.count,
    amount: row.amount,
  }));

  const recent = deals.slice(0, 20);
  const users = await loadUsers(recent.map((d) => d.assignedById), authorization);
  const recentDeals = recent.map((deal) => {
    const id = String(deal.id);
    const assigned = deal.assignedById != null ? String(deal.assignedById) : '';
    return {
      id,
      title: deal.title || `Сделка ${id}`,
      amount: num(deal.amount),
      currency: currencyCode(deal.currency || deal.currencyId),
      stageId: deal.stageId || '',
      stageName: stageName.get(String(deal.stageId)) || deal.stageId || '—',
      assignedById: assigned,
      assignedName: assigned ? users[assigned] || `ID ${assigned}` : '—',
    };
  });

  const warnings = [];
  if (truncated) {
    warnings.push('Выборка обрезана лимитом 5000 сделок — цифры могут быть неполными.');
  }
  if (convertedCodes.size) {
    const rateHint = [...convertedCodes]
      .map((code) => `${code}: ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(rates[code])} ₽`)
      .join(', ');
    warnings.push(
      `Суммы открытых, средний чек и стадии в рублях по курсу валют CRM (${rateHint}). В списке сделок — исходная валюта.`,
    );
  }
  if (unknownCodes.size) {
    warnings.push(
      `Нет курса CRM для ${[...unknownCodes].join(', ')} — эти суммы вошли в KPI без пересчёта.`,
    );
  }

  return {
    implemented: true,
    period: {
      id: period.period,
      from: period.from,
      to: period.to,
      label: period.label,
    },
    categoryId,
    categoryName: category.name,
    categories,
    currencies: [...currencies],
    kpis: {
      openAmount,
      wonCount,
      avgCheck: deals.length ? totalRub / deals.length : 0,
    },
    stages: stagesOut,
    recentDeals,
    truncated,
    warnings,
    empty: deals.length === 0,
  };
}

module.exports = { loadDashboard };
