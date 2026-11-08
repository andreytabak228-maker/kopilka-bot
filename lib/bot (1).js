const fs = require('fs');
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const cfg = require('./config');
const dbx = require('./db');
const { parseExpense } = require('./parser');
const { detectCategory, findCategoryByName, catEmoji } = require('./categories');
const { formatReport, money } = require('./reports');
const { budgetWarnings } = require('./budgets');
const { prevMonthRangeUTC, monthLabel, daysAgoISO } = require('./time');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN не задан (проверь переменные окружения / .env)');
}

const bot = new Bot(process.env.BOT_TOKEN);
bot.catch((err) => console.error('bot error:', err.error || err));

// grammY требует botInfo для handleUpdate: при polling его получает bot.start(),
// в вебхуке и crone инициализируем сами — лениво, один раз на инстанс функции.
let initPromise = null;
async function ensureInit() {
  if (!initPromise) {
    initPromise = bot.init().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

// ---------- помощники ----------

function isPrivate(ctx) {
  return Boolean(ctx.chat && ctx.chat.type === 'private');
}

function botUsername() {
  return (bot.botInfo && bot.botInfo.username) || 'kopilka_vmeste_bot';
}

// Копилка для текущего контекста: личка -> парная по членству, группа -> по chat_id.
async function resolveHousehold(ctx, { createGroup = false } = {}) {
  if (isPrivate(ctx)) return dbx.getPairHouseholdForUser(ctx.from.id);
  if (createGroup) return dbx.getGroupHousehold(ctx.chat.id, ctx.chat.title);
  return dbx.getHouseholdByChatId(ctx.chat.id);
}

function memberLabel(from) {
  if (!from) return 'Участник';
  return (
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    (from.username ? '@' + from.username : 'Участник')
  );
}

// ---------- приветствие с картинкой-обложкой ----------

// Подпись к фото в Telegram вмещает до 1024 символов; если текст длиннее —
// уходим на схему «фото отдельно + текст отдельно».
const CAPTION_LIMIT = 1024;

function welcomePhoto() {
  // Приоритет: публичная ссылка на баннер -> file_id из Telegram -> локальный файл в assets/.
  if (cfg.WELCOME_IMAGE_URL) return cfg.WELCOME_IMAGE_URL;
  if (cfg.WELCOME_IMAGE_FILE_ID) return cfg.WELCOME_IMAGE_FILE_ID;
  const local = path.join(__dirname, 'assets', 'welcome.png');
  if (fs.existsSync(local)) return new InputFile(fs.readFileSync(local));
  return null;
}

async function sendWelcome(ctx, text) {
  try {
    const photo = welcomePhoto();
    if (photo) {
      if (text.length <= CAPTION_LIMIT) {
        await ctx.replyWithPhoto(photo, { caption: text });
        return;
      }
      await ctx.replyWithPhoto(photo);
      await ctx.reply(text);
      return;
    }
  } catch (e) {
    // картинка не отправилась — не беда, просто текст
  }
  await ctx.reply(text);
}

function helpText() {
  return [
    '🐷 Шпаргалка по копилке',
    '',
    'Записывать траты просто: пиши в чат, как обычно говоришь — «кофе 350» или «350 на продукты». Я запишу и разложу по категориям.',
    'Что-то пошло не так? Кнопка «↩️ Отменить» под тратой — или /undo.',
    '',
    'Команды:',
    '📊 /report — траты за месяц',
    '🗓 /week — траты за неделю',
    '🎯 /budget — лимиты: /budget кафе 5000 (0 — убрать лимит)',
    '⭐ /premium — безлимит за 99 ₽/мес',
    '',
    'Режимы копилки:',
    '💞 Пара — /link пришлёт код. Партнёр открывает бота в личке и пишет /join КОД.',
    '👨‍👩‍👧 Семья — просто добавь меня в групповой чат.',
    '',
    `Бесплатно — ${cfg.FREE_LIMIT} трат в месяц на копилку. Премиум снимает лимит и присылает автоотчёт по воскресеньям.`,
  ].join('\n');
}

async function sendPremiumInvoice(ctx, hh) {
  await ctx.replyWithInvoice({
    title: 'Премиум для копилки — 1 месяц',
    description: 'Убирает лимит трат для всей копилки и присылает автоотчёт по воскресеньям.',
    payload: 'premium:' + hh.id,
    currency: 'XTR',
    prices: [{ label: 'Премиум на месяц', amount: cfg.PREMIUM_PRICE_STARS }],
  });
}

// ---------- команды ----------

bot.command('start', async (ctx) => {
  if (isPrivate(ctx)) {
    let hh = await dbx.getPairHouseholdForUser(ctx.from.id);
    if (!hh) hh = await dbx.createPairHousehold(ctx.from);
    await dbx.addMember(hh.id, ctx.from);
    dbx.logEvent(hh.id, ctx.from.id, 'start');
    const members = await dbx.getMembers(hh.id);
    const status =
      members.length > 1
        ? `Сейчас вы считаете вместе в копилке «${hh.title}», участников: ${members.length}.`
        : 'Пока копилка только твоя. Позови вторую половинку через /link — и считать станет теплее вдвоём.';
    await sendWelcome(
      ctx,
      [
        `🏡 Привет, ${ctx.from.first_name || 'друг'}! Это твоя копилка — тихое место, где деньги становятся понятными.`,
        '',
        'Записывай траты просто, как говоришь: «кофе 350» или «350 на продукты». Больше ничего не нужно.',
        '',
        'А дальше — как удобнее:',
        '',
        '💞 Пара — отправь /link, бот пришлёт код. Партнёр открывает бота в личке и пишет /join КОД — и ваши траты живут в одной копилке.',
        '',
        '👨‍👩‍👧 Семья — просто добавь меня в групповой чат.',
        '',
        '/help — все команды под рукой.',
        '',
        status,
      ].join('\n')
    );
  } else {
    const hh = await dbx.getGroupHousehold(ctx.chat.id, ctx.chat.title);
    await sendWelcome(
      ctx,
      [
        `🏡 Копилка «${hh.title}» на связи.`,
        '',
        'Пишите траты прямо в чат, как обычно говорите: «обед 500» — я запишу и разложу по категориям.',
        '',
        '/help — все команды под рукой.',
      ].join('\n')
    );
  }
});

bot.command('help', (ctx) => ctx.reply(helpText()));

bot.command('link', async (ctx) => {
  if (!isPrivate(ctx)) {
    await ctx.reply('Код приглашения живёт в личке — напиши мне /link там.');
    return;
  }
  let hh = await dbx.getPairHouseholdForUser(ctx.from.id);
  if (!hh) hh = await dbx.createPairHousehold(ctx.from);
  const code = await dbx.createInvite(hh.id, ctx.from.id);
  dbx.logEvent(hh.id, ctx.from.id, 'link_created');
  await ctx.reply(
    [
      `💞 Код приглашения: ${code}`,
      '',
      `Отправь его партнёру — пусть откроет бота @${botUsername()} в личке и напишет:`,
      `/join ${code}`,
      '',
      'Код живёт 24 часа и срабатывает один раз. Каждому новому участнику — свой код: просто пришли /link ещё раз.',
    ].join('\n')
  );
});

bot.command('join', async (ctx) => {
  if (!isPrivate(ctx)) {
    await ctx.reply('Вход по коду работает в личке — напиши мне /join туда.');
    return;
  }
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) {
    await ctx.reply('Напиши код сразу после команды: /join ABC123. Код выдаёт партнёр — пусть пришлёт /link.');
    return;
  }
  const res = await dbx.redeemInvite(code, ctx.from);
  if (res.error) {
    await ctx.reply('🚫 ' + res.error);
    return;
  }
  const members = await dbx.getMembers(res.household.id);
  dbx.logEvent(res.household.id, ctx.from.id, 'joined');
  if (res.already) {
    await ctx.reply(`Ты уже в копилке «${res.household.title}» — и это хорошо. Просто пиши траты, как обычно: «кофе 350».`);
    return;
  }
  await ctx.reply(
    [
      `🏡 Готово! Теперь твои траты живут в копилке «${res.household.title}».`,
      '',
      `Участников: ${members.length}. Пиши, как обычно говоришь: «кофе 350» — всё попадёт в общую копилку.`,
    ].join('\n')
  );
  if (res.createdBy && res.createdBy !== ctx.from.id) {
    try {
      await bot.api.sendMessage(
        res.createdBy,
        `💞 В копилке «${res.household.title}» новый участник: ${memberLabel(ctx.from)}. Теперь вы считаете вместе.`
      );
    } catch (e) {
      // не критично
    }
  }
});

bot.command('budget', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала напиши /start — заведём копилку.');
    return;
  }
  const args = (ctx.match || '').trim();
  if (!args) {
    const [budgets, txs] = await Promise.all([dbx.getBudgets(hh.id), dbx.monthTotals(hh.id)]);
    if (!budgets.length) {
      await ctx.reply('Лимитов пока нет. Поставь первый: /budget кафе 5000 — и я начну следить за этой категорией.');
      return;
    }
    const byCat = {};
    for (const t of txs) {
      const cat = t.category || 'Прочее';
      byCat[cat] = (byCat[cat] || 0) + (Number(t.amount) || 0);
    }
    const lines = budgets.map((b) => {
      const spent = byCat[b.category] || 0;
      return `${catEmoji(b.category)} ${b.category}: ${money(spent)} из ${money(Number(b.monthly_limit))}`;
    });
    await ctx.reply('📊 Лимиты на этот месяц:\n' + lines.join('\n'));
    return;
  }
  const m = args.match(/^(\S+)\s+(\d+(?:[.,]\d+)?)$/);
  if (!m) {
    await ctx.reply('Напиши так: /budget кафе 5000. А чтобы убрать лимит — вместо суммы поставь 0.');
    return;
  }
  const cat = findCategoryByName(m[1]);
  if (!cat) {
    await ctx.reply(`С категорией «${m[1]}» я пока не знаком. Есть, например: продукты, кафе, транспорт, дом.`);
    return;
  }
  const limit = Math.round(parseFloat(m[2].replace(',', '.')));
  await dbx.setBudget(hh.id, cat.name, limit);
  await ctx.reply(
    limit > 0
      ? `✅ Лимит поставлен: ${cat.emoji} ${cat.name} — ${money(limit)} в месяц. Выйдешь за границу — подскажу.`
      : `🗑 Лимит на ${cat.emoji} ${cat.name} убран — теперь без ограничений.`
  );
});

bot.command('report', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала напиши /start — заведём копилку.');
    return;
  }
  const prev = prevMonthRangeUTC();
  const [txs, prevRows] = await Promise.all([
    dbx.monthTotals(hh.id),
    dbx.rangeTotals(hh.id, prev.start.toISOString(), prev.end.toISOString()),
  ]);
  const prevTotal = prevRows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const warnings = await budgetWarnings(hh.id);
  await ctx.reply(formatReport({ title: `Траты за ${monthLabel()}`, txs, prevTotal, warnings }));
});

bot.command('week', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала напиши /start — заведём копилку.');
    return;
  }
  const from = daysAgoISO(7);
  const prevFrom = daysAgoISO(14);
  const [txs, prevRows] = await Promise.all([
    dbx.rangeTotals(hh.id, from, new Date().toISOString()),
    dbx.rangeTotals(hh.id, prevFrom, from),
  ]);
  const prevTotal = prevRows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const warnings = await budgetWarnings(hh.id);
  await ctx.reply(formatReport({ title: 'Траты за 7 дней', txs, prevTotal, warnings }));
});

bot.command('undo', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) return;
  const tx = await dbx.undoLast(hh.id, ctx.from.id);
  await ctx.reply(
    tx
      ? `↩️ Убрал: ${money(Number(tx.amount))}${tx.description ? ' — ' + tx.description : ''}. Словно её и не было.`
      : 'Отменять пока нечего — в этой копилке нет твоих трат.'
  );
});

bot.command('premium', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала напиши /start — заведём копилку.');
    return;
  }
  if (dbx.isPremium(hh)) {
    await ctx.reply(
      [
        `🎉 Премиум уже активен — до ${new Date(hh.premium_until).toLocaleDateString('ru-RU')}.`,
        '',
        'Ничего докупать не нужно, просто пользуйся.',
      ].join('\n')
    );
    return;
  }
  await sendPremiumInvoice(ctx, hh);
});

// ---------- платежи (Telegram Stars) ----------

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery());

bot.on('message:successful_payment', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) return;
  await dbx.setPremium(hh.id, cfg.PREMIUM_DAYS);
  dbx.logEvent(hh.id, ctx.from && ctx.from.id, 'premium_paid', {
    stars: ctx.message.successful_payment.total_amount,
  });
  await ctx.reply(
    [
      `🎉 Премиум активирован — до ${new Date(Date.now() + cfg.PREMIUM_DAYS * 86400000).toLocaleDateString('ru-RU')}.`,
      '',
      'Лимит снят для всей копилки, автоотчёт по воскресеньям включён. Спасибо, что поддерживаешь копилку! 💛',
    ].join('\n')
  );
});

// ---------- inline-кнопки ----------

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  if (data === 'buy') {
    const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
    await ctx.answerCallbackQuery();
    if (hh) await sendPremiumInvoice(ctx, hh);
    return;
  }
  if (data.startsWith('undo:')) {
    const id = data.slice('undo:'.length);
    const tx = await dbx.getTxById(id).catch(() => null);
    if (!tx) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (tx.user_id !== ctx.from.id) {
      await ctx.answerCallbackQuery();
      await ctx.reply('↩️ Убрать трату может только тот, кто её записал.');
      return;
    }
    await dbx.deleteTxById(tx.id);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        `↩️ Убрал: ${money(Number(tx.amount))}${tx.description ? ' — ' + tx.description : ''}. Словно её и не было.`
      );
    } catch (e) {
      // сообщение могло уже быть отредактировано
    }
    return;
  }
  await ctx.answerCallbackQuery();
});

// ---------- системные события ----------

bot.on('my_chat_member', async (ctx) => {
  const now = ctx.myChatMember && ctx.myChatMember.new_chat_member && ctx.myChatMember.new_chat_member.status;
  if (!['group', 'supergroup'].includes(ctx.chat.type)) return;
  if (!['member', 'administrator'].includes(now)) return;
  await dbx.getGroupHousehold(ctx.chat.id, ctx.chat.title);
  await sendWelcome(
    ctx,
    [
      `🏡 Копилка теперь живёт в чате «${ctx.chat.title || 'чате'}».`,
      '',
      'Пишите траты прямо сюда, как обычно говорите: «обед 500» — я запишу и разложу по категориям.',
      '',
      'Один технический момент: чтобы я видел сообщения, владелец бота должен открыть @BotFather → /setprivacy → Disable → выбрать меня.',
    ].join('\n')
  );
});

// ---------- правки сообщений ----------

bot.on('edited_message', async (ctx) => {
  const msg = ctx.editedMessage;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) return;
  const parsed = parseExpense(text);
  if (!parsed) return;
  const cat = detectCategory(parsed.description || text);
  const updated = await dbx.updateByMessage(hh.id, msg.message_id, {
    amount: parsed.amount,
    description: parsed.description,
    category: cat.name,
  });
  if (updated && isPrivate(ctx)) {
    await ctx.reply(`✏️ Обновил: ${money(parsed.amount)} — ${cat.emoji} ${cat.name}.`);
  }
});

// ---------- обычные сообщения (запись трат) ----------

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (msg.successful_payment) return; // обработано выше
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    if (isPrivate(ctx)) await ctx.reply('Такую команду я не знаю. /help — все команды под рукой.');
    return;
  }

  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Напиши /start — заведём твою копилку.');
    return;
  }
  if (!isPrivate(ctx)) await dbx.addMember(hh.id, ctx.from);

  const parsed = parseExpense(text);
  if (!parsed) {
    if (isPrivate(ctx) && /\d/.test(text)) {
      await ctx.reply('Не понял трату 🤔 Попробуй, как обычно говоришь: «кофе 350» или «350 на продукты».');
    }
    return; // в группах молчим: это просто болтовня
  }

  if (!dbx.isPremium(hh)) {
    const used = await dbx.countThisMonth(hh.id);
    if (used >= cfg.FREE_LIMIT) {
      const kb = new InlineKeyboard().text(`⭐ Премиум — ${cfg.PREMIUM_PRICE_STARS} звёзд`, 'buy');
      await ctx.reply(
        [
          `🏡 Бесплатный лимит — ${cfg.FREE_LIMIT} трат в месяц, и на этом месяце он закончился.`,
          '',
          `Премиум (${cfg.PREMIUM_PRICE_STARS} звёзд ≈ ${cfg.PREMIUM_PRICE_STARS} ₽) снимает лимит для всей копилки и присылает автоотчёт по воскресеньям.`,
          '',
          'Кнопка ниже — если решились. 💛',
        ].join('\n'),
        { reply_markup: kb }
      );
      return;
    }
  }

  const cat = detectCategory(parsed.description || text);
  const tx = await dbx.addTransaction({
    householdId: hh.id,
    userId: ctx.from.id,
    messageId: msg.message_id,
    amount: parsed.amount,
    description: parsed.description,
    category: cat.name,
  });
  dbx.logEvent(hh.id, ctx.from.id, 'expense', { amount: parsed.amount, category: cat.name });

  const warnings = await budgetWarnings(hh.id).catch(() => []);
  const warnLine = warnings.find((w) => w.includes(cat.name));
  const kb = new InlineKeyboard().text('↩️ Отменить', 'undo:' + tx.id);
  await ctx.reply(
    `✅ Записал: ${money(parsed.amount)} — ${cat.emoji} ${cat.name}` +
      (parsed.description ? `\n«${parsed.description}»` : '') +
      (warnLine ? `\n⚠️ Лимит превышен: ${warnLine}` : ''),
    { reply_markup: kb }
  );
});

module.exports = { bot, ensureInit, handleUpdate: async (update) => { await ensureInit(); return bot.handleUpdate(update); } };
