const { bot, ensureInit } = require('../lib/bot');
const dbx = require('../lib/db');
const { formatReport } = require('../lib/reports');
const { budgetWarnings } = require('../lib/budgets');
const { daysAgoISO } = require('../lib/time');

// Vercel Cron: раз в день в 19:00 МСК (16:00 UTC).
// По воскресеньям рассылает недельный автоотчёт премиум-копилкам.
module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false });
    return;
  }

  try {
    if (new Date().getUTCDay() !== 0) {
      res.status(200).json({ ok: true, skipped: 'not sunday' });
      return;
    }

    await ensureInit();

    const households = await dbx.listHouseholds();
    let sent = 0;
    for (const hh of households) {
      try {
        if (!dbx.isPremium(hh)) continue; // автоотчёт — фича премиума
        const from = daysAgoISO(7);
        const prevFrom = daysAgoISO(14);
        const [txs, prevRows] = await Promise.all([
          dbx.rangeTotals(hh.id, from, new Date().toISOString()),
          dbx.rangeTotals(hh.id, prevFrom, from),
        ]);
        const prevTotal = prevRows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
        const warnings = await budgetWarnings(hh.id);
        const text = formatReport({ title: 'Отчёт за неделю', txs, prevTotal, warnings });

        if (hh.mode === 'group' && hh.chat_id) {
          await bot.api.sendMessage(hh.chat_id, text);
          sent += 1;
        } else {
          const members = await dbx.getMembers(hh.id);
          for (const m of members) {
            try {
              await bot.api.sendMessage(m.user_id, text);
            } catch (e) {
              // участник мог заблокировать бота — не падаем
            }
          }
          sent += 1;
        }
      } catch (e) {
        console.error('household report failed:', hh && hh.id, e);
      }
    }
    res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error('cron failed:', e);
    res.status(500).json({ ok: false });
  }
};
