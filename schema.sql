-- Run this in a NEW Supabase project's SQL editor (keep this separate from
-- your booking SaaS project — different purpose, don't mix the data).

create table if not exists launches (
  id uuid primary key default gen_random_uuid(),
  source text not null,                 -- 'pumpfun' | 'raydium'
  mint_address text not null unique,
  name text,
  symbol text,
  detected_at timestamptz not null default now(),

  -- raw signals used for scoring, kept for later analysis/tuning
  mint_authority_renounced boolean,
  freeze_authority_renounced boolean,
  lp_sol_amount numeric,
  lp_locked_or_burned boolean,
  top10_holder_pct numeric,
  dev_holder_pct numeric,
  buys_first_90s integer,
  market_cap_sol numeric,
  has_socials boolean,

  -- output of the scoring function
  score numeric not null,
  score_breakdown jsonb,

  -- did the paper trader "buy" this
  paper_bought boolean default false,
  paper_entry_price numeric,

  raw_payload jsonb
);

create index if not exists idx_launches_score on launches (score desc);
create index if not exists idx_launches_detected_at on launches (detected_at desc);

create table if not exists price_snapshots (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid references launches(id) on delete cascade,
  taken_at timestamptz not null default now(),
  minutes_after_launch numeric not null,
  price_usd numeric,
  market_cap_usd numeric
);

create index if not exists idx_snapshots_launch on price_snapshots (launch_id);

-- ============================================================
-- Wallet monitoring + private alpha-wallet discovery additions
-- ============================================================

create table if not exists tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  label text, -- e.g. "friend's wallet", "discovered - early on 5 winners"
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists wallet_activity (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  mint_address text not null,
  activity_type text not null check (activity_type in ('buy', 'sell')),
  amount numeric,
  signature text not null unique,
  occurred_at timestamptz,
  created_at timestamptz not null default now()
);

-- Every early buyer on every scored launch (not just tracked wallets) —
-- the raw material discoverAlphaWallets.js mines later. Intentionally NOT
-- foreign-keyed to `launches`: this fills in during the 90s scoring
-- window, before a launch may or may not end up inserted there.
create table if not exists token_early_buyers (
  id uuid primary key default gen_random_uuid(),
  mint_address text not null,
  buyer_address text not null,
  seconds_after_launch numeric,
  created_at timestamptz not null default now(),
  unique (mint_address, buyer_address)
);

create index if not exists idx_tracked_wallets_active on tracked_wallets (active);
create index if not exists idx_wallet_activity_wallet on wallet_activity (wallet_address);
create index if not exists idx_wallet_activity_mint on wallet_activity (mint_address);
create index if not exists idx_early_buyers_mint on token_early_buyers (mint_address);
create index if not exists idx_early_buyers_buyer on token_early_buyers (buyer_address);

alter table tracked_wallets enable row level security;
alter table wallet_activity enable row level security;
alter table token_early_buyers enable row level security;

create policy "service role full access" on tracked_wallets
  for all using (auth.role() = 'service_role');
create policy "service role full access" on wallet_activity
  for all using (auth.role() = 'service_role');
create policy "service role full access" on token_early_buyers
  for all using (auth.role() = 'service_role');
