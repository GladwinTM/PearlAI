-- Server-only functions: the browser never talks to Supabase (all data goes through the agent API with the
-- service-role key), so nobody else needs EXECUTE. Supabase grants EXECUTE on new public functions to anon and
-- authenticated by default; the init migration didn't revoke it. These functions are SECURITY INVOKER, so RLS
-- already blocked anon from reading or writing anything through them; this removes the surface entirely.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('book_appointment', 'reschedule_appointment', 'get_available_slots', 'match_kb', 'mask_name')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- Functions created later in public (by future migrations) don't get EXECUTE for anon/authenticated by default.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
