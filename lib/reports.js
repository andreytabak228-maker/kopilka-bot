const { catEmoji } = require('./categories');

function money(n) {
  const v = Math.round(Number(n) || 0);
  // ru-RU использует неразрывный пробел как разделитель — заменяем на обычный
  return v.toLocaleString('ru-RU').replace(/[\u00A0\u202F]/g, ' ') + ' ₽';
}

// Универсальный текстовый отчёт: топ категорий, сравнение с прошлым периодом, лимиты.
function formatReport({ title, txs, prevTotal = null, warnings = [] }) {
  const byCat = new Map();
  let total = 0;
  for (const t of txs || []) {
    const a = Number(t.amount) || 0;
    total += a;
    const cat = t.category || 'Прочее';
    byCat.set(cat, (byCat.get(cat) || 0) + a);
  }

  const lines = [`🐷 ${title}`];
  if (!txs || !txs.length) {
    lines.push('', 'Пока пусто. Запиши первую трату — «кофе 350» — и отчёт начнёт наполняться.');
    return lines.join('\n');
  }

  lines.push('', `Всего: ${money(total)}`, '');
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
  for (const [cat, sum] of top) {
    const share = total ? Math.round((sum / total) * 100) : 0;
    lines.push(`${catEmoji(cat)} ${cat} — ${money(sum)} (${share}%)`);
  }

  if (prevTotal !== null && prevTotal > 0) {
    const diff = Math.round(((total - prevTotal) / prevTotal) * 100);
    lines.push('', diff >= 0 ? `К прошлому периоду: +${diff}% 📈` : `К прошлому периоду: ${diff}% 📉`);
  }

  if (warnings && warnings.length) {
    lines.push('', 'Превышенные лимиты:');
    for (const wmsg of warnings) lines.push(`⚠️ ${wmsg}`);
  }

  return lines.join('\n');
}

module.exports = { formatReport, money };
