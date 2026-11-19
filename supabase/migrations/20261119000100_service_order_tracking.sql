alter table public.chatbot_cases
  add column if not exists tracking_token text not null default replace(gen_random_uuid()::text, '-', ''),
  add column if not exists service_status text not null default 'received',
  add column if not exists quote_status text not null default 'not_ready',
  add column if not exists quote_description text,
  add column if not exists quote_amount numeric(10, 2),
  add column if not exists quote_decided_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists chatbot_cases_tracking_token_key
  on public.chatbot_cases (tracking_token);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chatbot_cases_service_status_check'
      and conrelid = 'public.chatbot_cases'::regclass
  ) then
    alter table public.chatbot_cases
      add constraint chatbot_cases_service_status_check
      check (service_status in ('received', 'diagnosis', 'quote_pending', 'approved', 'in_service', 'ready', 'returned', 'cancelled'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chatbot_cases_quote_status_check'
      and conrelid = 'public.chatbot_cases'::regclass
  ) then
    alter table public.chatbot_cases
      add constraint chatbot_cases_quote_status_check
      check (quote_status in ('not_ready', 'pending', 'approved', 'declined'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chatbot_cases_quote_amount_check'
      and conrelid = 'public.chatbot_cases'::regclass
  ) then
    alter table public.chatbot_cases
      add constraint chatbot_cases_quote_amount_check
      check (quote_amount is null or quote_amount >= 0);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chatbot_cases_pending_quote_details_check'
      and conrelid = 'public.chatbot_cases'::regclass
  ) then
    alter table public.chatbot_cases
      add constraint chatbot_cases_pending_quote_details_check
      check (quote_status <> 'pending' or (quote_description is not null and quote_amount is not null));
  end if;
end;
$$;

create or replace function private.set_chatbot_case_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists chatbot_cases_set_updated_at on public.chatbot_cases;
create trigger chatbot_cases_set_updated_at
before update on public.chatbot_cases
for each row execute function private.set_chatbot_case_updated_at();

create table if not exists private.service_order_daily_usage (
  usage_day date primary key,
  request_count integer not null default 0 check (request_count >= 0)
);

create or replace function public.consume_service_order_daily_limit(p_limit integer default 2000)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_count integer;
begin
  insert into private.service_order_daily_usage (usage_day, request_count)
  values (current_date, 1)
  on conflict (usage_day) do update
    set request_count = private.service_order_daily_usage.request_count + 1
  returning request_count into v_count;

  delete from private.service_order_daily_usage
  where usage_day < current_date - 30;

  return v_count <= greatest(1, least(p_limit, 10000));
end;
$$;

revoke all on function public.consume_service_order_daily_limit(integer) from public, anon, authenticated;
grant execute on function public.consume_service_order_daily_limit(integer) to service_role;
