-- Копилка: схема БД (Supabase / Postgres).
-- Запуск: Supabase -> SQL Editor -> New query -> вставить весь файл -> Run.

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('group', 'pair')),
  chat_id bigint unique,              -- для группового режима; у парных копилок NULL
  title text not null default 'Семейная копилка',
  is_premium boolean not null default false,
  premium_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id bigint not null,
  username text,
  display_name text,
  joined_at timestamptz not null default now(),
  unique (household_id, user_id)
);
create index if not exists members_user_idx on members (user_id);

create table if not exists invite_codes (
  code text primary key,
  household_id uuid not null references households(id) on delete cascade,
  created_by bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_by bigint                       -- NULL = код ещё не использован (одноразовый)
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id bigint not null,
  message_id bigint,                   -- чтобы обновлять трату при правке сообщения
  amount numeric(12,2) not null check (amount > 0),
  description text,
  category text not null default 'Прочее',
  spent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists tx_household_time_idx on transactions (household_id, spent_at desc);

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  category text not null,
  monthly_limit numeric(12,2) not null,
  unique (household_id, category)
);

create table if not exists events (
  id bigint generated always as identity primary key,
  household_id uuid,
  user_id bigint,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Закрываем таблицы от анонимного ключа: сервер ходит через service_role,
-- который RLS не соблюдает, так что работа бота не меняется.
alter table households enable row level security;
alter table members enable row level security;
alter table invite_codes enable row level security;
alter table transactions enable row level security;
alter table budgets enable row level security;
alter table events enable row level security;
