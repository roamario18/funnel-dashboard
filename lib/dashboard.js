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
  } catch {
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

  const [stages, funnelJson, searchJson] = await Promise.all([
    loadStages(categoryId, authorization),
    vibeFetch('/v1/deals/aggregate', {
      method: 'POST',
      authorization,
      body: {
        aggregate: [
          { field: 'amount', function: 'sum' },
          { field: 'amount', function: 'avg' },
        ],
        filter,
        groupBy: 'stageId',
      },
    }),
    vibeFetch('/v1/deals/search', {
      method: 'POST',
      authorization,
      body: {
        filter,
        limit: 20,
        order: { createdAt: 'desc' },
        select: ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'],
      },
    }),
  ]);

  const funnel = funnelJson.data || {};
  const groups = Array.isArray(funnel.groups) ? funnel.groups : [];
  const byStage = new Map(groups.map((g) => [String(g.stageId), g]));
  const stageName = new Map(stages.map((s) => [s.id, s.name]));

  const seen = new Set();
  const stagesOut = stages.map((stage) => {
    seen.add(stage.id);
    const group = byStage.get(stage.id);
    return {
      stageId: stage.id,
      name: stage.name,
      semantics: stage.semantics,
      count: num(group?.count),
      amount: num(group?.aggregates?.amount?.sum),
    };
  });
  for (const group of groups) {
    const id = String(group.stageId);
    if (seen.has(id)) continue;
    stagesOut.push({
      stageId: id,
      name: id,
      semantics: null,
      count: num(group.count),
      amount: num(group.aggregates?.amount?.sum),
    });
  }

  let openAmount = 0;
  let wonCount = 0;
  for (const row of stagesOut) {
    if (row.semantics === 'S') wonCount += row.count;
    else if (row.semantics !== 'F') openAmount += row.amount;
  }

  const recent = Array.isArray(searchJson.data) ? searchJson.data : [];
  const users = await loadUsers(recent.map((d) => d.assignedById), authorization);

  const recentDeals = recent.map((deal) => {
    const id = String(deal.id);
    const assigned = deal.assignedById != null ? String(deal.assignedById) : '';
    return {
      id,
      title: deal.title || `Сделка ${id}`,
      amount: num(deal.amount),
      currency: deal.currency || deal.currencyId || 'RUB',
      stageId: deal.stageId || '',
      stageName: stageName.get(String(deal.stageId)) || deal.stageId || '—',
      assignedById: assigned,
      assignedName: assigned ? users[assigned] || `ID ${assigned}` : '—',
    };
  });

  const truncated = Boolean(funnel.meta && funnel.meta.truncated);
  const warnings = [];
  if (truncated) {
    warnings.push('Агрегация обрезана лимитом 5000 сделок — цифры могут быть неполными.');
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
    kpis: {
      openAmount,
      wonCount,
      avgCheck: num(funnel.aggregates?.amount?.avg),
    },
    stages: stagesOut,
    recentDeals,
    truncated,
    warnings,
    empty: stagesOut.every((s) => s.count === 0) && recentDeals.length === 0,
  };
}

module.exports = { loadDashboard };
