'use strict';

const crypto = require('crypto');
const { vibeFetch } = require('./vibe');
const { parsePeriod, parseCategoryId, dealFilter } = require('./period');

const CACHE_TTL_MS = 45000;
const cacheStore = new Map();
const CRM_OPTS = { maxAttempts: 2 };
const AGG_OPTS = { timeoutMs: 20000, maxAttempts: 1 };
const AGG_BATCH_MS = 18000;

function cacheAuth(authorization) {
  return crypto.createHash('sha256').update(String(authorization || '')).digest('hex').slice(0, 16);
}

function cacheGet(key) {
  const hit = cacheStore.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    cacheStore.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cacheStore.size > 200) {
    const now = Date.now();
    for (const [k, v] of cacheStore) {
      if (now > v.exp) cacheStore.delete(k);
    }
    if (cacheStore.size > 200) {
      const oldest = cacheStore.keys().next().value;
      if (oldest !== undefined) cacheStore.delete(oldest);
    }
  }
  cacheStore.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
}

async function cached(key, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  cacheSet(key, value);
  return value;
}

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
  return cached(`stages:${cacheAuth(authorization)}:${categoryId}`, async () => {
    const entityId = categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
    const json = await vibeFetch(
      `/v1/statuses?filter[entityId]=${encodeURIComponent(entityId)}`,
      { authorization, ...CRM_OPTS },
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
  });
}

async function loadUsers(ids, authorization) {
  const unique = [...new Set(ids.filter((id) => id !== undefined && id !== null && id !== '').map(String))];
  const map = {};
  if (!unique.length) return map;

  try {
    const json = await vibeFetch('/v1/users/search', {
      method: 'POST',
      authorization,
      ...CRM_OPTS,
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
          const json = await vibeFetch(`/v1/users/${encodeURIComponent(id)}`, { authorization, ...CRM_OPTS });
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
  return cached(`categories:${cacheAuth(authorization)}`, async () => {
    const json = await vibeFetch('/v1/categories/2?limit=200', { authorization, ...CRM_OPTS });
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .filter((c) => c && (c.isLocked === undefined || c.isLocked === false))
      .sort((a, b) => num(a.sort) - num(b.sort))
      .map((c) => ({
        id: num(c.id),
        name: c.name || (num(c.id) === 0 ? 'Общая' : `Воронка ${c.id}`),
        isDefault: Boolean(c.isDefault),
      }));
  });
}

function currencyCode(value) {
  return String(value || 'RUB').trim().toUpperCase() || 'RUB';
}

async function loadCurrencies(authorization) {
  return cached(`currencies:${cacheAuth(authorization)}`, () => fetchCurrencies(authorization));
}

async function fetchCurrencies(authorization) {
  const json = await vibeFetch('/v1/currencies?limit=200', { authorization, ...CRM_OPTS });
  const rows = Array.isArray(json.data) ? json.data : [];
  const toBase = {};
  const codes = [];
  let baseId = 'RUB';
  for (const row of rows) {
    const id = currencyCode(row.id);
    if (!id) continue;
    const cnt = num(row.amountCnt) || 1;
    const amount = num(row.amount);
    if (row.base) {
      baseId = id;
      toBase[id] = 1;
      codes.push(id);
    } else if (cnt > 0 && amount > 0) {
      toBase[id] = amount / cnt;
      codes.push(id);
    }
  }
  const toRub = {};
  if (baseId === 'RUB') {
    Object.assign(toRub, toBase);
  } else {
    const rubToBase = toBase.RUB;
    if (!rubToBase) {
      return { rates: { RUB: 1 }, codes: codes.length ? codes : ['RUB'] };
    }
    for (const [id, rate] of Object.entries(toBase)) {
      toRub[id] = rate / rubToBase;
    }
  }
  if (!toRub.RUB) toRub.RUB = 1;
  return { rates: toRub, codes: codes.length ? [...new Set(codes)] : ['RUB'] };
}

function amountToRub(amount, currency, rates) {
  const code = currencyCode(currency);
  const rate = rates[code];
  if (rate == null) return { value: num(amount), converted: false, code };
  return { value: num(amount) * rate, converted: code !== 'RUB', code, rate };
}

function groupStageId(group) {
  return String(group.stageId || group.groupValue || group.id || '');
}

function groupCount(group) {
  return num(group.count ?? group.aggregates?.count);
}

function groupAmountSum(group) {
  return num(group.aggregates?.amount?.sum ?? group.amount?.sum ?? group.sum);
}

function summarizeAggError(err) {
  return {
    message: err && err.message ? String(err.message) : 'Ошибка агрегации',
    code: err && err.code ? String(err.code) : 'AGGREGATE_FAILED',
    status: Number(err && err.status) || 502,
  };
}

async function aggregateStages(filter, authorization) {
  return vibeFetch('/v1/deals/aggregate', {
    method: 'POST',
    authorization,
    ...AGG_OPTS,
    body: {
      aggregate: [{ field: 'amount', function: 'sum' }],
      filter,
      groupBy: 'stageId',
    },
  });
}

async function aggregateStagesForCurrency(filter, code, authorization, currencyField) {
  return aggregateStages({ ...filter, [currencyField]: code }, authorization);
}

function orderCurrencyCodes(codes) {
  const unique = [...new Set((codes || []).map(currencyCode).filter(Boolean))];
  const rest = unique.filter((code) => code !== 'RUB');
  return unique.includes('RUB') ? ['RUB', ...rest] : rest;
}

const SKIPPED_BUDGET = {
  message: 'Не осталось времени на агрегацию этой валюты',
  code: 'CRM_TIMEOUT',
  status: 504,
  skippedBudget: true,
};

async function runCurrencyAggregates(filter, codes, authorization, field, deadlineAt) {
  const results = [];
  for (const code of orderCurrencyCodes(codes)) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      results.push({ code, json: null, ok: false, error: { ...SKIPPED_BUDGET } });
      continue;
    }
    try {
      const json = await aggregateStagesForCurrency(filter, code, authorization, field);
      results.push({ code, json, ok: true, error: null });
    } catch (err) {
      results.push({ code, json: null, ok: false, error: summarizeAggError(err) });
    }
  }
  return results;
}

function throwAggregateFailed(results) {
  const failed = (results || []).filter((item) => !item.ok);
  const first = failed[0] || {};
  const detail = failed
    .map((item) => `${item.code}: ${item.error?.message || 'ошибка'}`)
    .join('; ');
  const err = new Error(detail || 'Не удалось посчитать суммы и стадии');
  err.code = first.error?.code || 'AGGREGATE_FAILED';
  err.status = first.error?.status >= 400 ? first.error.status : 502;
  throw err;
}

function isTransientAgg(error) {
  if (!error) return false;
  const status = Number(error.status) || 0;
  return (
    error.code === 'BITRIX_UNAVAILABLE' ||
    error.code === 'CRM_TIMEOUT' ||
    status === 0 ||
    status === 502 ||
    status === 504
  );
}

function isFieldNameError(error) {
  if (!error || isTransientAgg(error)) return false;
  const status = Number(error.status) || 0;
  const code = String(error.code || '');
  return status === 400 || status === 422 || code === 'VALIDATION';
}

function shouldProbeCurrencyId(results) {
  const rows = results || [];
  if (!rows.length || rows.some((item) => item.ok)) return false;
  if (rows.every((item) => isTransientAgg(item.error))) return false;
  return rows.every((item) => isFieldNameError(item.error));
}

async function loadCurrencyAggregates(filter, codes, authorization) {
  const deadlineAt = Date.now() + AGG_BATCH_MS;
  let results = await runCurrencyAggregates(filter, codes, authorization, 'currency', deadlineAt);
  if (results.some((item) => item.ok)) return results;
  if (!shouldProbeCurrencyId(results)) throwAggregateFailed(results);

  const probeCode = orderCurrencyCodes(codes)[0];
  if (!probeCode) throwAggregateFailed(results);

  const probe = await aggregateStagesForCurrency(filter, probeCode, authorization, 'currencyId')
    .then((json) => ({ json, ok: true, error: null }))
    .catch((err) => ({ json: null, ok: false, error: summarizeAggError(err) }));

  if (probe.ok) {
    results = await runCurrencyAggregates(
      filter,
      codes,
      authorization,
      'currencyId',
      Date.now() + AGG_BATCH_MS,
    );
    if (results.some((item) => item.ok)) return results;
  } else {
    results = results.length
      ? results
      : [{ code: probeCode, json: null, ok: false, error: probe.error }];
  }

  throwAggregateFailed(results);
}

async function loadDashboard(query, authorization) {
  const period = parsePeriod(query);
  const requestedId = parseCategoryId(query);

  let currencyFallback = false;
  const currencyPromise = loadCurrencies(authorization).catch(() => {
    currencyFallback = true;
    return { rates: { RUB: 1 }, codes: ['RUB'] };
  });
  const categories = await loadCategories(authorization);
  const known = new Set(categories.map((c) => c.id));
  const categoryId = known.has(requestedId)
    ? requestedId
    : (categories.find((c) => c.isDefault) || categories[0] || { id: 0 }).id;
  const category = categories.find((c) => c.id === categoryId) || { id: categoryId, name: 'Общая' };
  const filter = dealFilter(period, categoryId);

  const searchPromise = vibeFetch('/v1/deals/search', {
    method: 'POST',
    authorization,
    timeoutMs: 15000,
    maxAttempts: 1,
    body: {
      filter,
      limit: 20,
      order: { createdAt: 'desc' },
      select: ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'],
    },
  });
  const usersPromise = searchPromise
    .then((json) => {
      const recent = Array.isArray(json.data) ? json.data : [];
      return loadUsers(recent.map((d) => d.assignedById), authorization);
    })
    .catch(() => ({}));
  const aggregatesPromise = currencyPromise.then((pack) => {
    const currencyCodes = [...new Set((pack.codes || []).map(currencyCode).filter(Boolean))];
    const codes = currencyCodes.length ? currencyCodes : ['RUB'];
    return loadCurrencyAggregates(filter, codes, authorization).then((aggregates) => ({
      pack,
      aggregates,
    }));
  });

  const [stages, searchJson, aggPack, users] = await Promise.all([
    loadStages(categoryId, authorization),
    searchPromise,
    aggregatesPromise,
    usersPromise,
  ]);

  const currencyPack = aggPack.pack;
  const aggregates = aggPack.aggregates;
  const rates = currencyPack.rates || { RUB: 1 };
  const recentPreview = Array.isArray(searchJson.data) ? searchJson.data : [];
  const fromRecent = recentPreview.map((d) => currencyCode(d.currency || d.currencyId));

  const recent = Array.isArray(searchJson.data) ? searchJson.data : [];
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const stageStats = new Map();
  for (const stage of stages) {
    stageStats.set(stage.id, { count: 0, amount: 0, semantics: stage.semantics, name: stage.name });
  }

  const currencies = new Set(fromRecent.filter(Boolean));
  const convertedCodes = new Set();
  const unknownCodes = new Set();
  const failedAggregates = aggregates.filter(
    (item) => !item.ok && !item.error?.skippedBudget,
  );
  let totalRub = 0;
  let totalCount = 0;
  let openAmount = 0;
  let wonCount = 0;
  let truncated = false;

  for (const item of aggregates) {
    if (!item.ok || !item.json) continue;
    const data = item.json.data || {};
    truncated = truncated || Boolean(data.meta && data.meta.truncated);
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const code = currencyCode(item.code);
    let used = false;
    for (const group of groups) {
      const count = groupCount(group);
      if (!count) continue;
      used = true;
      const converted = amountToRub(groupAmountSum(group), code, rates);
      if (converted.converted) convertedCodes.add(code);
      if (rates[code] == null) unknownCodes.add(code);
      currencies.add(code);
      const rub = converted.value;
      totalRub += rub;
      totalCount += count;
      const stageId = groupStageId(group);
      if (!stageStats.has(stageId)) {
        const knownStage = stageById.get(stageId);
        stageStats.set(stageId, {
          count: 0,
          amount: 0,
          semantics: knownStage ? knownStage.semantics : null,
          name: knownStage ? knownStage.name : stageId || '—',
        });
      }
      const row = stageStats.get(stageId);
      row.count += count;
      row.amount += rub;
      const semantics = (stageById.get(stageId) || row).semantics;
      if (semantics === 'S') wonCount += count;
      else if (semantics !== 'F') openAmount += rub;
    }
    if (used) currencies.add(code);
  }

  const stagesOut = [...stageStats.entries()].map(([stageId, row]) => ({
    stageId,
    name: row.name,
    semantics: row.semantics,
    count: row.count,
    amount: row.amount,
  }));

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
  if (failedAggregates.length) {
    warnings.push(
      `Не удалось посчитать суммы для ${failedAggregates
        .map((item) => `${item.code} (${item.error?.message || 'ошибка'})`)
        .join(', ')}. KPI и стадии по этим валютам неполные.`,
    );
  }
  if (currencyFallback) {
    warnings.push('Справочник валют CRM не загрузился — агрегация только по RUB.');
  }
  if (truncated) {
    warnings.push('Агрегация обрезана лимитом 5000 сделок — цифры могут быть неполными.');
  }
  const mixCodes = [...currencies].filter((code) => code && code !== 'RUB');
  if (convertedCodes.size || mixCodes.length) {
    const shown = convertedCodes.size ? [...convertedCodes] : mixCodes;
    const rateHint = shown
      .map((code) => {
        const rate = rates[code];
        if (rate == null) return code;
        return `${code}: ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(rate)} ₽`;
      })
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
      avgCheck: totalCount ? totalRub / totalCount : 0,
    },
    stages: stagesOut,
    recentDeals,
    truncated,
    warnings,
    aggregateFailed: failedAggregates.length > 0,
    empty: totalCount === 0 && recent.length === 0 && failedAggregates.length === 0,
  };
}

module.exports = { loadDashboard };
