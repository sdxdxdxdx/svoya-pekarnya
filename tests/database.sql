-- Run on the new Supabase project. Every test record is rolled back.
begin;
do $$
declare r public.bakery_records; d jsonb := '{"date":"2026-01-01","category":"Synthetic test","amountKopecks":100}';
begin
  if has_table_privilege('anon','public.bakery_records','SELECT') or has_table_privilege('authenticated','public.bakery_records','UPDATE') then raise exception 'Client table access leaked'; end if;
  if has_function_privilege('authenticated','public.bakery_write(text,text,text,jsonb,bigint,text,timestamptz)','EXECUTE') then raise exception 'Client RPC access leaked'; end if;
  if not (select relrowsecurity from pg_class where oid='public.bakery_records'::regclass) then raise exception 'RLS disabled'; end if;
  r := public.bakery_write('create','00000000-0000-4000-8000-000000000001','expense',d,null,'synthetic-test',now());
  if r.revision <> 1 then raise exception 'Create failed'; end if;
  r := public.bakery_write('create',r.id,'expense',d,null,'synthetic-test',now());
  if r.revision <> 1 then raise exception 'Retry duplicated'; end if;
  r := public.bakery_write('update',r.id,'expense',d || '{"amountKopecks":200}',1,'synthetic-test',now());
  if r.revision <> 2 or r.data->>'amountKopecks' <> '200' then raise exception 'Update failed'; end if;
  begin
    perform public.bakery_write('update',r.id,'expense',d,1,'synthetic-test',now());
    raise exception 'Stale revision accepted';
  exception when serialization_failure then null; end;
  r := public.bakery_write('delete',r.id,'expense',null,2,'synthetic-test',now());
  if r.deleted_at is null or r.revision <> 3 then raise exception 'Delete failed'; end if;
  r := public.bakery_write('restore',r.id,'expense',null,3,'synthetic-test',now());
  if r.deleted_at is not null or r.revision <> 4 then raise exception 'Restore failed'; end if;
  perform public.bakery_write('create','00000000-0000-4000-8000-000000000003','shift','{"date":"2026-01-01","employeeId":"test-only"}',null,'synthetic-test',now());
  begin
    perform public.bakery_write('create','00000000-0000-4000-8000-000000000004','shift','{"date":"2026-01-01","employeeId":"test-only"}',null,'synthetic-test',now());
    raise exception 'Duplicate shift accepted';
  exception when unique_violation then null; end;
  perform public.bakery_write('create','00000000-0000-4000-8000-000000000005','recipe','{"effectiveFrom":"2026-01-01","productId":"test-only"}',null,'synthetic-test',now());
  begin
    perform public.bakery_write('create','00000000-0000-4000-8000-000000000006','recipe','{"effectiveFrom":"2026-01-01","productId":"test-only"}',null,'synthetic-test',now());
    raise exception 'Duplicate recipe accepted';
  exception when unique_violation then null; end;
end;
$$;
rollback;
select 'PASS: permissions, RLS, idempotency, revisions, delete/restore, unique dates; test rows rolled back' as result;
