// Подключает вебхук к твоему деплою на Vercel.
// Использование: npm run set-webhook   (в .env должны быть VERCEL_URL, BOT_TOKEN, WEBHOOK_SECRET)
const TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const BASE = process.env.VERCEL_URL;

if (!TOKEN || !SECRET || !BASE) {
  console.error('Нужны переменные VERCEL_URL, BOT_TOKEN, WEBHOOK_SECRET (в .env или окружении).');
  process.exit(1);
}

const url = `${BASE.replace(/\/+$/, '')}/api/webhook?secret_token=${encodeURIComponent(SECRET)}`;

fetch('https://api.telegram.org/bot' + TOKEN + '/setWebhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url,
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
  }),
})
  .then((r) => r.json())
  .then((j) => {
    console.log(JSON.stringify(j, null, 2));
    if (!j.ok) process.exit(1);
    console.log('✅ Вебхук подключён: ' + url);
  })
  .catch((e) => {
    console.error('Ошибка запроса:', e.message);
    process.exit(1);
  });
