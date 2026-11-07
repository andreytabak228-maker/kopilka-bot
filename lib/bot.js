const { Bot, InlineKeyboard } = require('grammy');
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

function helpText() {
  return [
    '🐷 Как пользоваться копилкой',
    '',
    'Траты: просто пиши в чат «кофе 350», «350 продукты», «обед -500» — запишу и разложу по категориям.',
    'Отмена: кнопка ↩️ под тратой или /undo.',
    '',
    '/report — траты за месяц',
    '/week — траты за неделю',
    '/budget — лимиты: /budget кафе 5000 (0 — убрать лимит)',
    '/premium — безлимит за 99 ₽/мес',
    '',
    'Режимы:',
    '• Соло — просто пиши мне в личку.',
    '• Пара — /link выдаст код. Партнёр открывает бота в личке и отправляет /join КОД.',
    '• Семья — добавь меня в групповой чат и тратьте прямо там.',
    '',
    `Бесплатно — ${cfg.FREE_LIMIT} трат/мес на копилку. Премиум снимает лимит и включает автоотчёт по воскресеньям.`,
  ].join('\n');
}

async function sendPremiumInvoice(ctx, hh) {
  await ctx.replyWithInvoice({
    title: 'Копилка Премиум — 1 месяц',
    description: 'Без лимита трат и автоотчёт по воскресеньям для всей копилки.',
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
        ? `Сейчас ты в копилке «${hh.title}», участников: ${members.length}.`
        : 'Сейчас копилка только твоя — позови вторую половинку через /link.';
    await ctx.reply(
      [
        `🐷 Привет, ${ctx.from.first_name || 'друг'}! Это ваша копилка.`,
        '',
        'Кидай траты прямо в чат: «кофе 350» или «350 на продукты».',
        '',
        'Дальше на выбор:',
        '1) Пара — /link пришлёт код. Партнёр открывает бота в личке и пишет /join КОД — ваши траты идут в одну копилку.',
        '2) Семья — добавь меня в групповой чат.',
        '',
        '/help — все команды.',
        status,
      ].join('\n')
    );
  } else {
    const hh = await dbx.getGroupHousehold(ctx.chat.id, ctx.chat.title);
    await ctx.reply(`🐷 Копилка «${hh.title}» на связи. Кидайте траты прямо в чат: «обед 500». /help — команды.`);
  }
});

bot.command('help', (ctx) => ctx.reply(helpText()));

bot.command('link', async (ctx) => {
  if (!isPrivate(ctx)) {
    await ctx.reply('Код выдаётся в личке у бота — напиши мне /link.');
    return;
  }
  let hh = await dbx.getPairHouseholdForUser(ctx.from.id);
  if (!hh) hh = await dbx.createPairHousehold(ctx.from);
  const code = await dbx.createInvite(hh.id, ctx.from.id);
  dbx.logEvent(hh.id, ctx.from.id, 'link_created');
  await ctx.reply(
    [
      `🔗 Код приглашения: ${code}`,
      '',
      `Партнёр открывает @${botUsername()} в личке и отправляет: /join ${code}`,
      'Код действует 24 часа и срабатывает один раз. Для каждого нового участника — новый /link.',
    ].join('\n')
  );
});

bot.command('join', async (ctx) => {
  if (!isPrivate(ctx)) {
    await ctx.reply('Вход по коду — в личке у бота.');
    return;
  }
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) {
    await ctx.reply('Формат: /join ABC123. Код выдаёт партнёр командой /link.');
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
    await ctx.reply(`Ты уже в копилке «${res.household.title}». Просто пиши мне траты: «кофе 350».`);
    return;
  }
  await ctx.reply(
    `🐷 Готово! Теперь твои траты идут в копилку «${res.household.title}».\nУчастников: ${members.length}. Просто пиши мне траты: «кофе 350».`
  );
  if (res.createdBy && res.createdBy !== ctx.from.id) {
    try {
      await bot.api.sendMessage(
        res.createdBy,
        `👤 ${memberLabel(ctx.from)} присоединился к копилке «${res.household.title}».`
      );
    } catch (e) {
      // не критично
    }
  }
});

bot.command('budget', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала /start — заведём копилку.');
    return;
  }
  const args = (ctx.match || '').trim();
  if (!args) {
    const [budgets, txs] = await Promise.all([dbx.getBudgets(hh.id), dbx.monthTotals(hh.id)]);
    if (!budgets.length) {
      await ctx.reply('Лимитов нет. Поставь: /budget кафе 5000');
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
    await ctx.reply('📊 Лимиты на месяц:\n' + lines.join('\n'));
    return;
  }
  const m = args.match(/^(\S+)\s+(\d+(?:[.,]\d+)?)$/);
  if (!m) {
    await ctx.reply('Формат: /budget кафе 5000 (0 — убрать лимит).');
    return;
  }
  const cat = findCategoryByName(m[1]);
  if (!cat) {
    await ctx.reply(`Не знаю категорию «${m[1]}». Примеры: продукты, кафе, транспорт, дом.`);
    return;
  }
  const limit = Math.round(parseFloat(m[2].replace(',', '.')));
  await dbx.setBudget(hh.id, cat.name, limit);
  await ctx.reply(limit > 0 ? `✅ Лимит ${cat.emoji} ${cat.name}: ${money(limit)}/мес` : `🗑 Лимит ${cat.emoji} ${cat.name} убран`);
});

bot.command('report', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала /start — заведём копилку.');
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
    await ctx.reply('Сначала /start — заведём копилку.');
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
      ? `↩️ Отменил: ${money(Number(tx.amount))}${tx.description ? ' — ' + tx.description : ''}`
      : 'Отменять нечего — твоих трат в этой копилке нет.'
  );
});

bot.command('premium', async (ctx) => {
  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Сначала /start — заведём копилку.');
    return;
  }
  if (dbx.isPremium(hh)) {
    await ctx.reply(`🎉 Премиум уже активен до ${new Date(hh.premium_until).toLocaleDateString('ru-RU')}.`);
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
    `🎉 Премиум активирован до ${new Date(Date.now() + cfg.PREMIUM_DAYS * 86400000).toLocaleDateString('ru-RU')}. Спасибо, что кормишь свинку!`
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
      await ctx.reply('↩️ Отменить трату может только её автор.');
      return;
    }
    await dbx.deleteTxById(tx.id);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(`↩️ Отменил: ${money(Number(tx.amount))}${tx.description ? ' — ' + tx.description : ''}`);
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
  await ctx.api.sendMessage(
    ctx.chat.id,
    [
      `🐷 Копилка подключена к «${ctx.chat.title || 'чату'}».`,
      '',
      'Кидайте траты прямо в чат: «обед 500».',
      '',
      'Важно: чтобы я видел сообщения, владелец бота должен открыть @BotFather → /setprivacy → Disable → выбрать меня.',
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
    await ctx.reply(`✏️ Обновил: ${money(parsed.amount)} — ${cat.emoji} ${cat.name}`);
  }
});

// ---------- обычные сообщения (запись трат) ----------

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (msg.successful_payment) return; // обработано выше
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    if (isPrivate(ctx)) await ctx.reply('Не знаю такую команду. /help — список команд.');
    return;
  }

  const hh = await resolveHousehold(ctx, { createGroup: !isPrivate(ctx) });
  if (!hh) {
    await ctx.reply('Нажми /start — заведём твою копилку.');
    return;
  }
  if (!isPrivate(ctx)) await dbx.addMember(hh.id, ctx.from);

  const parsed = parseExpense(text);
  if (!parsed) {
    if (isPrivate(ctx) && /\d/.test(text)) {
      await ctx.reply('Не понял трату 🤔 Формат: «кофе 350» или «350 кофе».');
    }
    return; // в группах молчим: это просто болтовня
  }

  if (!dbx.isPremium(hh)) {
    const used = await dbx.countThisMonth(hh.id);
    if (used >= cfg.FREE_LIMIT) {
      const kb = new InlineKeyboard().text(`⭐ Оплатить ${cfg.PREMIUM_PRICE_STARS} звёзд`, 'buy');
      await ctx.reply(
        [
          `🐷 Бесплатный лимит — ${cfg.FREE_LIMIT} трат в месяц, и он кончился.`,
          '',
          `Премиум (${cfg.PREMIUM_PRICE_STARS} звёзд ≈ 99 ₽) снимает лимит для всей копилки и включает автоотчёт по воскресеньям.`,
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
    `✅ ${money(parsed.amount)} — ${cat.emoji} ${cat.name}` +
      (parsed.description ? `\n«${parsed.description}»` : '') +
      (warnLine ? `\n⚠️ ${warnLine}` : ''),
    { reply_markup: kb }
  );
});

module.exports = { bot, handleUpdate: (update) => bot.handleUpdate(update) };
