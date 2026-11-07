const dbx = require('./db');
const { money } = require('./reports');
const { catEmoji } = require('./categories');

// Предупреждения по превышенным месячным лимитам: «☕ Кафе: 12 400 ₽ из 10 000 ₽».
async function budgetWarnings(householdId) {
  const [budgets, txs] = await Promise.all([dbx.getBudgets(householdId), dbx.monthTotals(householdId)]);
  const byCat = {};
  for (const t of txs) {
    const cat = t.category || 'Прочее';
    byCat[cat] = (byCat[cat] || 0) + (Number(t.amount) || 0);
  }
  const out = [];
  for (const b of budgets || []) {
    const spent = byCat[b.category] || 0;
    const limit = Number(b.monthly_limit) || 0;
    if (limit > 0 && spent > limit) {
      out.push(`${catEmoji(b.category)} ${b.category}: ${money(spent)} из ${money(limit)}`);
    }
  }
  return out;
}

module.exports = { budgetWarnings };
