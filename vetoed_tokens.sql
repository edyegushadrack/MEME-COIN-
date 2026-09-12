-- Run this in the Supabase SQL editor for your existing project.
-- Stores every token the pre-score filter rejected, and why — this becomes
-- your backtest data for tuning veto thresholds later (e.g. was the
-- "8 unique buyers in 2 slots" bundling cutoff too strict or too loose).

create table if not exists vetoed_tokens (
  id uuid primary key default gen_random_uuid(),
  mint_address text not null,
  veto_reasons text[] not null default '{}',
  checked_at timestamptz not null default now(),
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_vetoed_tokens_mint on vetoed_tokens (mint_address);
create index if not exists idx_vetoed_tokens_checked_at on vetoed_tokens (checked_at);
