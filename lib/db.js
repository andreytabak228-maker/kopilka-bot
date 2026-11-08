const { createClient } = require('@supabase/supabase-js');
const cfg = require('./config');
const { monthStartUTC } = require('./time');

let client = null;
function s() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть заданы (см. .env.example / Vercel Environment Variables)');
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

function isPremium(hh) {
  return Boolean(hh && hh.is_premium && hh.premium_until && new Date(hh.premium_until) > new Date());
}

// ---------- households ----------

async function getHouseholdByChatId(chatId) {
  const { data, error } = await s().from('households').select('*').eq('chat_id', chatId).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Групповой чат = копилка. Создаётся лениво, идемпотентно (гонка обработана).
async function getGroupHousehold(chatId, title) {
  const existing = await getHouseholdByChatId(chatId);
  if (existing) return existing;
  const { data, error } = await s()
    .from('households')
    .insert({ mode: 'group', chat_id: chatId, title: title || 'Семейная копилка' })
    .select('*')
    .single();
  if (!error) return data;
  const again = await getHouseholdByChatId(chatId);
  if (again) return again;
  throw error;
}

// Персональная/парная копилка: ищем по членству, последнее вступление выигрывает.
async function getPairHouseholdForUser(userId) {
  const { data: rows, error } = await s()
    .from('members')
    .select('joined_at, households(*)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false });
  if (error) throw error;
  for (const r of rows || []) {
    const hh = Array.isArray(r.households) ? r.households[0] : r.households;
    if (hh && hh.mode === 'pair') return hh;
  }
  return null;
}

async function createPairHousehold(user) {
  const title = `Копилка: ${user.first_name || user.username || 'пара'}`;
  const { data, error } = await s().from('households').insert({ mode: 'pair', title }).select('*').single();
  if (error) throw error;
  await addMember(data.id, user);
  return data;
}

async function listHouseholds() {
  const { data, error } = await s().from('households').select('*').order('created_at', { ascending: true }).limit(500);
  if (error) throw error;
  return data || [];
}

// ---------- members ----------

async function addMember(householdId, user) {
  const { error } = await s()
    .from('members')
    .upsert(
      {
        household_id: householdId,
        user_id: user.id,
        username: user.username || null,
        display_name:
          [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          (user.username ? '@' + user.username : 'Участник'),
      },
      { onConflict: 'household_id,user_id' }
    );
  if (error) throw error;
}

async function getMembers(householdId) {
  const { data, error } = await s()
    .from('members')
    .select('user_id, username, display_name, joined_at')
    .eq('household_id', householdId)
    .order('joined_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ---------- invite codes ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

async function createInvite(householdId, userId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    const { data, error } = await s()
      .from('invite_codes')
      .insert({ code, household_id: householdId, created_by: userId })
      .select('code')
      .single();
    if (!error) return data.code;
  }
  throw new Error('не удалось создать код приглашения');
}

async function redeemInvite(code, user) {
  const { data: inv, error } = await s()
    .from('invite_codes')
    .select('*, households(*)')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  const hh = inv && (Array.isArray(inv.households) ? inv.households[0] : inv.households);
  if (!inv || !hh) return { error: 'Такого кода я не нашёл. Проверь написание — например, /join ABC123.' };
  if (inv.used_by) return { error: 'Этот код уже сработал. Попроси новый — партнёру достаточно написать мне /link.' };
  if (new Date(inv.expires_at) < new Date()) return { error: 'Код устарел — он живёт сутки. Попроси партнёра прислать новый через /link.' };

  const members = await getMembers(hh.id);
  if (members.some((m) => m.user_id === user.id)) return { household: hh, createdBy: inv.created_by, already: true };
  if (members.length >= cfg.HOUSEHOLD_CAP) {
    return { error: `В этой копилке уже собралась вся компания: максимум ${cfg.HOUSEHOLD_CAP} участников.` };
  }
  await addMember(hh.id, user);
  await s().from('invite_codes').update({ used_by: user.id }).eq('code', inv.code);
  return { household: hh, createdBy: inv.created_by };
}

// ---------- transactions ----------

async function addTransaction({ householdId, userId, messageId, amount, description, category }) {
  const { data, error } = await s()
    .from('transactions')
    .insert({
      household_id: householdId,
      user_id: userId,
      message_id: messageId,
      amount,
      description,
      category,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getTxById(id) {
  const { data, error } = await s().from('transactions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function deleteTxById(id) {
  const { error } = await s().from('transactions').delete().eq('id', id);
  if (error) throw error;
}

async function undoLast(householdId, userId) {
  const { data: rows, error } = await s()
    .from('transactions')
    .select('*')
    .eq('household_id', householdId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const tx = rows && rows[0];
  if (!tx) return null;
  await deleteTxById(tx.id);
  return tx;
}

async function updateByMessage(householdId, messageId, patch) {
  const { data, error } = await s()
    .from('transactions')
    .update(patch)
    .eq('household_id', householdId)
    .eq('message_id', messageId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function countThisMonth(householdId) {
  const { count, error } = await s()
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .gte('spent_at', monthStartUTC().toISOString());
  if (error) throw error;
  return count || 0;
}

async function monthTotals(householdId) {
  const { data, error } = await s()
    .from('transactions')
    .select('amount, category')
    .eq('household_id', householdId)
    .gte('spent_at', monthStartUTC().toISOString());
  if (error) throw error;
  return data || [];
}

async function rangeTotals(householdId, fromISO, toISO) {
  const { data, error } = await s()
    .from('transactions')
    .select('amount, category')
    .eq('household_id', householdId)
    .gte('spent_at', fromISO)
    .lt('spent_at', toISO);
  if (error) throw error;
  return data || [];
}

// ---------- budgets ----------

async function setBudget(householdId, category, limit) {
  if (limit <= 0) {
    const { error } = await s().from('budgets').delete().eq('household_id', householdId).eq('category', category);
    if (error) throw error;
    return;
  }
  const { error } = await s()
    .from('budgets')
    .upsert({ household_id: householdId, category, monthly_limit: limit }, { onConflict: 'household_id,category' });
  if (error) throw error;
}

async function getBudgets(householdId) {
  const { data, error } = await s()
    .from('budgets')
    .select('category, monthly_limit')
    .eq('household_id', householdId)
    .order('category', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ---------- premium ----------

async function setPremium(householdId, days) {
  const { error } = await s()
    .from('households')
    .update({ is_premium: true, premium_until: new Date(Date.now() + days * 86400000).toISOString() })
    .eq('id', householdId);
  if (error) throw error;
}

// ---------- analytics ----------

async function logEvent(householdId, userId, type, payload = {}) {
  try {
    await s().from('events').insert({ household_id: householdId, user_id: userId, type, payload });
  } catch (e) {
    // аналитика не должна ломать продукт
  }
}

module.exports = {
  isPremium,
  getHouseholdByChatId,
  getGroupHousehold,
  getPairHouseholdForUser,
  createPairHousehold,
  listHouseholds,
  addMember,
  getMembers,
  createInvite,
  redeemInvite,
  addTransaction,
  getTxById,
  deleteTxById,
  undoLast,
  updateByMessage,
  countThisMonth,
  monthTotals,
  rangeTotals,
  setBudget,
  getBudgets,
  setPremium,
  logEvent,
};
