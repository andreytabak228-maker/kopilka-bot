// Диагностика: показывает, жив ли токен и куда сейчас подключён вебхук.
// Использование: npm run check-webhook
const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error('Нужен BOT_TOKEN (в .env или окружении).');
  process.exit(1);
}

async function call(method) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method);
  return r.json();
}

(async () => {
  const me = await call('getMe');
  console.log('getMe:', JSON.stringify(me, null, 2));
  const hook = await call('getWebhookInfo');
  console.log('getWebhookInfo:', JSON.stringify(hook, null, 2));
  if (hook.ok && hook.result.url) {
    const pending = hook.result.pending_update_count || 0;
    console.log(
      hook.result.last_error_message
        ? `⚠️ Последняя ошибка доставки: ${hook.result.last_error_message}`
        : '✅ Вебхук установлен и ошибок доставки нет.'
    );
    if (pending > 0) console.log(`Необработанных апдейтов в очереди: ${pending}`);
  } else {
    console.log('ℹ️ Вебхук не установлен — бот сейчас нигде не слушает апдейты.');
  }
})().catch((e) => {
  console.error('Ошибка запроса:', e.message);
  process.exit(1);
});
