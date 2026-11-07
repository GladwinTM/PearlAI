-- M1: demo fixtures as a callable function + a masked calendar query for the public UI.
-- Both functions are server-only (service_role); the browser never calls Supabase directly.

-- ─────────────────────────────────────────────────────────────
-- reset_demo_fixtures(): restores the demo to a known state relative to *today*.
-- Called by POST /api/demo/reset, before every eval case, and by seed.sql.
-- ─────────────────────────────────────────────────────────────
create or replace function public.reset_demo_fixtures()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_filler    constant uuid := 'aaaaaaaa-0000-0000-0000-000000000099';
  v_priya     constant uuid := '11111111-1111-1111-1111-111111111111';
  v_arjun     constant uuid := '22222222-2222-2222-2222-222222222222';
  v_tz        text;
  v_today     date;
  v_next_thu  date;
  v_next_mon  date;
  v_deleted   int;
  v_patients  int;
  v_created   int := 0;
  ts timestamp;  -- local clinic time
begin
  select timezone into v_tz from clinic_settings where id;
  v_tz       := coalesce(v_tz, 'Asia/Kolkata');
  v_today    := (now() at time zone v_tz)::date;
  v_next_thu := v_today + 1 + ((3 - extract(dow from v_today)::int + 7) % 7);
  v_next_mon := v_today + 1 + ((0 - extract(dow from v_today)::int + 7) % 7);

  -- Wipe everything the demo / agent created. Staff history (e.g. Ravi's completed visit) stays.
  -- rescheduled_from points at rows we are deleting, so clear those links first.
  update appointments set rescheduled_from = null
  where rescheduled_from in (select id from appointments where patient_id = v_filler or source in ('voice', 'chat'));
  delete from appointments where patient_id = v_filler or source in ('voice', 'chat');
  get diagnostics v_deleted = row_count;

  -- Patients created by the agent (create_patient) would otherwise pile up and confuse lookups.
  -- Seeded patients all use the fixed 'aaaaaaaa-0000-0000-0000-…' ids.
  delete from patients where id::text not like 'aaaaaaaa-0000-0000-0000-%';
  get diagnostics v_patients = row_count;

  -- "Book me with Dr. Priya next Thursday" → Thursday is completely full
  for ts in select generate_series(v_next_thu + time '09:00', v_next_thu + time '17:30', interval '30 min') loop
    continue when ts::time >= time '13:00' and ts::time < time '14:00';  -- lunch
    insert into appointments (patient_id, dentist_id, appointment_type_id, starts_at, ends_at, source)
    values (v_filler, v_priya, 'checkup', ts at time zone v_tz, (ts + interval '30 min') at time zone v_tz, 'staff');
    v_created := v_created + 1;
  end loop;

  -- Dr. Arjun next Monday: the only free time is 15:00–16:00 → a 90-min root canal can't fit
  for ts in select generate_series(v_next_mon + time '10:00', v_next_mon + time '19:30', interval '30 min') loop
    continue when ts::time >= time '13:00' and ts::time < time '14:00';  -- lunch
    continue when ts::time >= time '15:00' and ts::time < time '16:00';  -- the 60-min gap
    insert into appointments (patient_id, dentist_id, appointment_type_id, starts_at, ends_at, source)
    values (v_filler, v_arjun, 'checkup', ts at time zone v_tz, (ts + interval '30 min') at time zone v_tz, 'staff');
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object(
    'deleted_appointments', v_deleted,
    'deleted_patients',     v_patients,
    'fixtures_created',     v_created,
    'next_thursday',        v_next_thu,
    'next_monday',          v_next_mon
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- get_calendar(from, to): appointments for the public calendar, patient names masked.
-- "Ravi Kumar" → "Ravi K."; fixture filler rows are flagged so the UI can grey them out.
-- ─────────────────────────────────────────────────────────────
create or replace function public.mask_name(p_full_name text)
returns text
language sql
immutable
as $$
  select case
    when p_full_name is null or btrim(p_full_name) = '' then 'Patient'
    when array_length(regexp_split_to_array(btrim(p_full_name), '\s+'), 1) = 1 then btrim(p_full_name)
    else split_part(btrim(p_full_name), ' ', 1) || ' '
         || upper(left((regexp_split_to_array(btrim(p_full_name), '\s+'))[2], 1)) || '.'
  end;
$$;

create or replace function public.get_calendar(p_from date, p_to date)
returns table (
  id                uuid,
  dentist_id        uuid,
  dentist_name      text,
  appointment_type  text,
  appointment_name  text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  status            text,
  source            text,
  patient_display   text,
  is_fixture        boolean,
  created_at        timestamptz
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_tz text;
begin
  if p_to < p_from then
    raise exception 'INVALID_RANGE: to (%) is before from (%)', p_to, p_from using errcode = '22023';
  end if;
  if p_to - p_from > 31 then
    raise exception 'RANGE_TOO_LARGE: at most 31 days' using errcode = '22023';
  end if;

  select s.timezone into v_tz from clinic_settings s where s.id;
  v_tz := coalesce(v_tz, 'Asia/Kolkata');

  return query
  select a.id, a.dentist_id, d.full_name, a.appointment_type_id, t.name,
         a.starts_at, a.ends_at, a.status, a.source,
         case when a.patient_id = 'aaaaaaaa-0000-0000-0000-000000000099' then 'Booked'
              else mask_name(p.full_name) end,
         a.patient_id = 'aaaaaaaa-0000-0000-0000-000000000099',
         a.created_at
  from appointments a
  join dentists d          on d.id = a.dentist_id
  join appointment_types t on t.id = a.appointment_type_id
  join patients p          on p.id = a.patient_id
  where a.status in ('booked', 'completed')
    and a.starts_at >= (p_from::timestamp)            at time zone v_tz
    and a.starts_at <  ((p_to + 1)::timestamp)        at time zone v_tz
  order by a.starts_at, d.full_name;
end;
$$;

-- Server-only: PostgREST exposes public functions to anon/authenticated by default.
revoke execute on function public.reset_demo_fixtures() from public, anon, authenticated;
revoke execute on function public.get_calendar(date, date) from public, anon, authenticated;
grant  execute on function public.reset_demo_fixtures() to service_role;
grant  execute on function public.get_calendar(date, date) to service_role;
