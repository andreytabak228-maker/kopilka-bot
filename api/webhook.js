const { handleUpdate } = require('../lib/bot');

// Вебхук Telegram. Защита: секрет в query-параметре ?secret_token=...
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, bot: 'kopilka_vmeste' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.secret_token !== secret) {
    res.status(401).end();
    return;
  }
  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error('update failed:', e);
  }
  res.status(200).json({ ok: true });
};
