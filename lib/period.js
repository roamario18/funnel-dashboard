'use strict';

const ALLOWED = new Set(['7', '30', 'all']);

function parsePeriod(query) {
  const raw = query && query.period != null ? String(query.period) : '30';
  const period = ALLOWED.has(raw) ? raw : '30';
  if (period === 'all') {
    return { period, from: null, to: null, label: 'все время' };
  }
  const days = Number(period);
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    period,
    from: from.toISOString(),
    to: to.toISOString(),
    label: `${days} дн.`,
  };
}

function parseCategoryId(query) {
  const raw = query && query.categoryId != null ? String(query.categoryId).trim() : '0';
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    const err = new Error('Некорректный идентификатор воронки');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  return id;
}

function dealFilter(period, categoryId) {
  const filter = { categoryId };
  if (period.from && period.to) {
    filter.createdAt = { $gte: period.from, $lte: period.to };
  }
  return filter;
}

module.exports = { parsePeriod, parseCategoryId, dealFilter };
