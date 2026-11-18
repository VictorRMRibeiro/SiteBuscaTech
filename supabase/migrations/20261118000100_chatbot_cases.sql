create schema if not exists private;

create table if not exists private.chatbot_daily_usage (
  usage_day date primary key,
  request_count integer not null default 0 check (request_count >= 0)
);

create or replace function public.consume_chatbot_daily_limit(p_limit integer default 200)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_count integer;
begin
  insert into private.chatbot_daily_usage (usage_day, request_count)
  values (current_date, 1)
  on conflict (usage_day) do update
    set request_count = private.chatbot_daily_usage.request_count + 1
  returning request_count into v_count;

  delete from private.chatbot_daily_usage
  where usage_day < current_date - 30;

  return v_count <= greatest(1, least(p_limit, 500));
end;
$$;

revoke all on function public.consume_chatbot_daily_limit(integer) from public, anon, authenticated;
grant execute on function public.consume_chatbot_daily_limit(integer) to service_role;

create table if not exists public.chatbot_cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  device text not null check (char_length(device) between 1 and 80),
  symptom text not null check (char_length(symptom) between 1 and 500),
  modality text not null check (char_length(modality) between 1 and 80),
  pickup_day text check (pickup_day is null or char_length(pickup_day) <= 40),
  neighborhood text not null check (char_length(neighborhood) between 1 and 100),
  ai_consent boolean not null default false,
  consent_at timestamptz not null,
  privacy_notice_version text not null default '2026-11-18'
);

alter table public.chatbot_cases enable row level security;
revoke all on table public.chatbot_cases from anon, authenticated;
grant all on table public.chatbot_cases to service_role;
