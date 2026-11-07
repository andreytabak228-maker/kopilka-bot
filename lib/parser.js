// Разбор траты из текста: «кофе 350», «350 кофе», «обед -500», «потратил 350 на кофе».
// Возвращает { amount, description } или null, если это не похоже на трату.
const { detectCategory } = require('./categories');

const MIN_AMOUNT = 10; // отсекаем «встретимся в 6»
const MAX_AMOUNT = 99999999;
const SPEND_PREFIX = /^(потратил|потратила|купил|купила|оплатил|оплатила|заплатил|заплатила|накинул|скинул|отдал|внес)/i;

function parseExpense(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text || text.length > 200 || text.startsWith('/')) return null;

  // «2 350» -> «2350» (тысячные разделители пробелом/неразрывным пробелом)
  const w = text.replace(/(\d)[ \u00A0](?=\d{3}(\D|$))/g, '$1');

  const matches = [...w.matchAll(/\d+(?:[.,]\d+)?/g)];
  if (!matches.length) return null;

  const last = matches[matches.length - 1];
  const amount = Math.round(parseFloat(last[0].replace(',', '.')) * 100) / 100;
  if (!(amount >= MIN_AMOUNT && amount <= MAX_AMOUNT)) return null;

  const trimmed = w.trimEnd();
  const firstIsNum = /^\d/.test(trimmed);
  const lastIsNum = /\d(?:[.,]\d+)?\s*[.!?]?$/.test(trimmed);
  if (!(firstIsNum || lastIsNum || SPEND_PREFIX.test(w))) return null;

  // Описание = текст без суммы.
  let desc = (w.slice(0, last.index) + ' ' + w.slice(last.index + last[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  desc = desc.replace(/^[-+.,\s]+|[-+.,\s]+$/g, '').trim();
  if (/^(р|руб|rub|₽|рубл\w*)$/i.test(desc)) desc = '';

  return { amount, description: desc ? desc.slice(0, 100) : null };
}

module.exports = { parseExpense };
