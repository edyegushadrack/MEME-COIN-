-- Run in the meme-scanner Supabase project's SQL editor.

create table if not exists tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  label text, -- e.g. "friend's wallet", "KOL - ansem", etc.
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists wallet_activity (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null references tracked_wallets(wallet_address) on delete cascade,
  mint_address text not null,
  activity_type text not null check (activity_type in ('buy', 'sell')),
  amount numeric,
  signature text not null unique,
  occurred_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tracked_wallets_active on tracked_wallets (active);
create index if not exists idx_wallet_activity_wallet on wallet_activity (wallet_address);
create index if not exists idx_wallet_activity_mint on wallet_activity (mint_address);
create index if not exists idx_wallet_activity_occurred_at on wallet_activity (occurred_at);

alter table tracked_wallets enable row level security;
alter table wallet_activity enable row level security;

create policy "service role full access" on tracked_wallets
  for all using (auth.role() = 'service_role');
create policy "service role full access" on wallet_activity
  for all using (auth.role() = 'service_role');
