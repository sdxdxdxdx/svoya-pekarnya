-- Server-only records: browsers authenticate with Supabase Auth, then use the
-- Edge Function, which performs membership and business validation on every call.
create table public.bakery_records (
  id text primary key,
  kind text not null check (kind in ('ingredient','product','employee','purchase','sale','recipe','shift','wagePayment','expense','cashMovement')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  created_by text not null,
  updated_by text not null,
  deleted_at timestamptz
);
create index bakery_records_kind_deleted on public.bakery_records (kind, deleted_at);
create unique index bakery_active_shift_date on public.bakery_records ((data ->> 'employeeId'), (data ->> 'date')) where kind = 'shift' and deleted_at is null;
create unique index bakery_active_recipe_date on public.bakery_records ((data ->> 'productId'), (data ->> 'effectiveFrom')) where kind = 'recipe' and deleted_at is null;
create table public.bakery_members (
  email text primary key check (email = lower(btrim(email))),
  active boolean not null default true
);
alter table public.bakery_records enable row level security;
alter table public.bakery_members enable row level security;
revoke all on public.bakery_records, public.bakery_members from public, anon, authenticated;
grant all on public.bakery_records, public.bakery_members to service_role;

create function public.bakery_write(p_action text, p_id text, p_kind text, p_data jsonb, p_revision bigint, p_actor text, p_now timestamptz)
returns public.bakery_records language plpgsql security invoker set search_path = '' as $$
declare
  existing public.bakery_records;
  result public.bakery_records;
begin
  select * into existing from public.bakery_records where id = p_id for update;
  if p_action = 'create' then
    if existing.id is not null then
      if existing.kind = p_kind and existing.data = p_data then return existing; end if;
      raise exception 'Record ID already used' using errcode = '40001';
    end if;
    begin
      insert into public.bakery_records(id,kind,data,revision,created_at,updated_at,created_by,updated_by)
      values(p_id,p_kind,p_data,1,p_now,p_now,p_actor,p_actor) returning * into result;
      return result;
    exception when unique_violation then
      -- A concurrent retry with the same ID/data is idempotent. A different ID
      -- colliding with an active shift/recipe date remains a business conflict.
      select * into existing from public.bakery_records where id = p_id;
      if existing.id is not null and existing.kind = p_kind and existing.data = p_data then return existing; end if;
      raise exception 'Duplicate active date or different payload for ID' using errcode = '23505';
    end;
  end if;
  if existing.id is null or existing.revision <> p_revision or existing.kind <> p_kind then
    raise exception 'Record revision changed' using errcode = '40001';
  end if;
  if p_action = 'update' then
    if existing.deleted_at is not null then raise exception 'Record deleted' using errcode = '40001'; end if;
    update public.bakery_records set data = p_data, revision = revision + 1, updated_at = p_now, updated_by = p_actor where id = p_id returning * into result;
  elsif p_action = 'delete' then
    if existing.deleted_at is not null then raise exception 'Record already deleted' using errcode = '40001'; end if;
    if existing.kind in ('ingredient','product','employee') then raise exception 'Catalogs must be archived' using errcode = '22023'; end if;
    update public.bakery_records set deleted_at = p_now, revision = revision + 1, updated_at = p_now, updated_by = p_actor where id = p_id returning * into result;
  elsif p_action = 'restore' then
    if existing.deleted_at is null then raise exception 'Record already active' using errcode = '40001'; end if;
    update public.bakery_records set deleted_at = null, revision = revision + 1, updated_at = p_now, updated_by = p_actor where id = p_id returning * into result;
  else
    raise exception 'Invalid action' using errcode = '22023';
  end if;
  return result;
end;
$$;
revoke all on function public.bakery_write(text,text,text,jsonb,bigint,text,timestamptz) from public, anon, authenticated;
grant execute on function public.bakery_write(text,text,text,jsonb,bigint,text,timestamptz) to service_role;
