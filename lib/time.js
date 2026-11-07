// Время считаем по Москве (UTC+3, перехода на летнее время нет).
const MSK_OFFSET = 3 * 60 * 60 * 1000;

// Начало текущего месяца (по МСК) в виде UTC-даты для фильтров БД.
function monthStartUTC() {
  const msk = new Date(Date.now() + MSK_OFFSET);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1) - MSK_OFFSET);
}

// Диапазон прошлого месяца (по МСК).
function prevMonthRangeUTC() {
  const msk = new Date(Date.now() + MSK_OFFSET);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 1, 1) - MSK_OFFSET);
  const end = new Date(Date.UTC(y, m, 1) - MSK_OFFSET);
  return { start, end };
}

// «ноябрь» / «декабрь» для заголовков отчётов.
function monthLabel() {
  const msk = new Date(Date.now() + MSK_OFFSET);
  return msk.toLocaleString('ru-RU', { month: 'long', timeZone: 'UTC' });
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

module.exports = { MSK_OFFSET, monthStartUTC, prevMonthRangeUTC, monthLabel, daysAgoISO };
