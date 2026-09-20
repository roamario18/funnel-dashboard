'use strict';

const MESSAGES = {
  WRITE_BLOCKED_READONLY_KEY: 'Ключ только для чтения — запись недоступна',
  BITRIX_ACCESS_DENIED: 'Нет прав на операцию в CRM',
  KEY_EXPIRED: 'Сессия или ключ недействительны — войдите снова',
  TOKEN_MISSING: 'Нет сессии пользователя — откройте приложение из Битрикс24',
  RATE_LIMITED: 'Слишком много запросов — подождите и повторите',
  QUEUE_OVERFLOW: 'Очередь портала занята — повторите через несколько секунд',
  BITRIX_UNAVAILABLE: 'Битрикс24 временно недоступен',
  CRM_TIMEOUT: 'CRM не успел посчитать воронку. Подождите несколько секунд и обновите страницу.',
  MISSING_API_KEY: 'На сервере не задан ключ приложения',
  SESSION_REQUIRED: 'Нужна сессия пользователя портала',
  SCOPE_DENIED: 'Не хватает прав ключа для этого запроса',
  VALIDATION: 'Некорректные параметры запроса',
};

function sendApiError(res, err) {
  const status = Number(err.status) || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = MESSAGES[code] || err.message || 'Ошибка';
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  res.status(safeStatus).json({
    success: false,
    error: { code, message },
  });
}

module.exports = { sendApiError, MESSAGES };
