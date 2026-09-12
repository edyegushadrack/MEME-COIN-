-- Run in the meme-scanner Supabase project.
-- Records EVERY early buyer on EVERY token your scanner detects — not just
-- wallets you're already tracking. This is the raw material for finding
-- your own alpha wallets later, privately, instead of using a public
-- leaderboard that thousands of other traders already watch.

create table if not exists token_early_buyers (
  id uuid primary key default gen_random_uuid(),
  mint_address text not null references tokens(mint_address) on delete cascade,
  buyer_address text not null,
  slot bigint,
  buy_amount numeric,
  seconds_after_launch numeric, -- how early relative to pool creation
  created_at timestamptz not null default now(),
  unique (mint_address, buyer_address)
);

create index if not exists idx_early_buyers_mint on token_early_buyers (mint_address);
create index if not exists idx_early_buyers_buyer on token_early_buyers (buyer_address);

alter table token_early_buyers enable row level security;
create policy "service role full access" on token_early_buyers
  for all using (auth.role() = 'service_role');
