// Локальный запуск в режиме long polling — без Vercel и вебхука.
// Использование: npm run dev   (эквивалент: node --env-file=.env dev.js)
// ВАЖНО: polling и вебхук одновременно работать не могут. Пока бот задеплоен
// на Vercel с вебхуком, локальный запуск выдаст конфликт 409 — сначала удали вебхук:
// https://api.telegram.org/bot<ТОКЕН>/deleteWebhook

console.log('🐷 Kopilka bot: запуск в polling-режиме. Ctrl+C — стоп.');

const { bot } = require('./lib/bot');

bot.start({ drop_pending_updates: true }).catch((e) => {
  console.error('Ошибка запуска:', e.message || e);
  process.exit(1);
});
