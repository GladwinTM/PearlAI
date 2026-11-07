-- SmileDesk — AI front desk for Pearl Dental Care
-- Initial schema. All clinic-time logic uses clinic_settings.timezone (Asia/Kolkata).
-- Backend talks to the DB with the service_role key (bypasses RLS). Never ship that key to the browser.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;      -- pgvector, for RAG
create extension if not exists btree_gist with schema extensions;  -- uuid "=" inside exclusion constraints

-- ─────────────────────────────────────────────────────────────
-- Clinic configuration
-- ─────────────────────────────────────────────────────────────
create table public.clinic_settings (
  id                  boolean primary key default true check (id),  -- single-row table
  clinic_name         text not null,
  timezone            text not null default 'Asia/Kolkata',
  phone               text,
  address             text,
  lunch_start         time not null default '13:00',
  lunch_end           time not null default '14:00',
  new_patient_cutoff  time not null default '18:00',  -- new patients can't start at/after this
  slot_step_minutes   int  not null default 15 check (slot_step_minutes > 0),
  check (lunch_end > lunch_start)
);

create table public.dentists (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  specialty   text not null check (specialty in ('general', 'endodontist', 'orthodontist')),
  bio         text,
  avatar_url  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.appointment_types (
  id                text primary key,            -- 'checkup', 'root_canal', ...
  name              text not null,
  duration_minutes  int  not null check (duration_minutes > 0),
  price_inr         int  check (price_inr >= 0),
  description       text
);

-- Which dentist performs which appointment type
create table public.dentist_services (
  dentist_id           uuid not null references public.dentists on delete cascade,
  appointment_type_id  text not null references public.appointment_types on delete cascade,
  primary key (dentist_id, appointment_type_id)
);

-- Weekly working hours. weekday: 0 = Sunday … 6 = Saturday (matches extract(dow)).
-- No row for a weekday = not working that day (no Sunday rows = clinic closed Sunday).
create table public.dentist_schedules (
  id          bigint generated always as identity primary key,
  dentist_id  uuid not null references public.dentists on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  check (end_time > start_time),
  unique (dentist_id, weekday)
);

-- Leave / holidays. dentist_id null = whole clinic closed.
create table public.time_off (
  id          bigint generated always as identity primary key,
  dentist_id  uuid references public.dentists on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  check (ends_at > starts_at)
);

-- ─────────────────────────────────────────────────────────────
-- Patients & conversations
-- ─────────────────────────────────────────────────────────────
-- phone is NOT unique: family members often share one number.
create table public.patients (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  phone          text not null,          -- E.164, e.g. +919800000001
  email          text,
  date_of_birth  date,
  notes          text,
  created_at     timestamptz not null default now()
);
create index patients_phone_idx on public.patients (phone);

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null check (channel in ('voice', 'chat')),
  patient_id      uuid references public.patients on delete set null,
  prompt_version  text,
  model           text,
  outcome         text check (outcome in ('booked', 'rescheduled', 'cancelled', 'info', 'escalated', 'abandoned')),
  summary         text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);

create table public.messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references public.conversations on delete cascade,
  role             text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content          text,
  tool_name        text,
  tool_args        jsonb,
  tool_result      jsonb,
  latency_ms       int,
  created_at       timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, id);

-- ─────────────────────────────────────────────────────────────
-- Appointments — double booking is impossible at the DB level
-- ─────────────────────────────────────────────────────────────
create table public.appointments (
  id                    uuid primary key default gen_random_uuid(),
  patient_id            uuid not null references public.patients on delete cascade,
  dentist_id            uuid not null references public.dentists,
  appointment_type_id   text not null references public.appointment_types,
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  status                text not null default 'booked'
                          check (status in ('booked', 'cancelled', 'rescheduled', 'completed', 'no_show')),
  booked_by_patient_id  uuid references public.patients on delete set null,  -- e.g. parent booking for child
  rescheduled_from      uuid references public.appointments on delete set null,
  source                text not null default 'staff' check (source in ('voice', 'chat', 'staff')),
  conversation_id       uuid references public.conversations on delete set null,
  notes                 text,
  created_at            timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint no_dentist_double_booking exclude using gist (
    dentist_id with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'booked'),
  constraint no_patient_double_booking exclude using gist (
    patient_id with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'booked')
);
create index appointments_patient_idx on public.appointments (patient_id, starts_at);

create table public.escalations (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations on delete set null,
  patient_id       uuid references public.patients on delete set null,
  urgency          text not null default 'normal' check (urgency in ('urgent', 'normal')),
  reason           text not null,
  status           text not null default 'open' check (status in ('open', 'resolved')),
  created_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- RAG knowledge base (embeddings: nomic-embed-text via Ollama = 768 dims)
-- ─────────────────────────────────────────────────────────────
create table public.kb_documents (
  id          bigint generated always as identity primary key,
  title       text not null,
  category    text not null check (category in ('pricing', 'insurance', 'location', 'policy', 'services', 'aftercare')),
  content     text not null,
  embedding   extensions.vector(768),   -- filled by the ingest script
  updated_at  timestamptz not null default now()
);
create index kb_documents_embedding_idx on public.kb_documents
  using hnsw (embedding extensions.vector_cosine_ops);

-- ─────────────────────────────────────────────────────────────
-- Evals
-- ─────────────────────────────────────────────────────────────
create table public.prompt_versions (
  id             text primary key,        -- 'v1', 'v2', ...
  system_prompt  text not null,
  notes          text,
  created_at     timestamptz not null default now()
);

create table public.eval_cases (
  id          text primary key,           -- slug, e.g. 'thursday-full'
  title       text not null,
  category    text not null check (category in
                ('booking', 'availability', 'dates', 'safety', 'guardrails', 'multi_turn', 'injection', 'info')),
  user_turns  jsonb not null,             -- ["turn 1", "turn 2", ...]
  expected    jsonb not null,             -- {"must_call": [...], "must_not_call": [...], "behaviors": [...]}
  rubric      text not null,              -- instructions for the LLM judge
  is_active   boolean not null default true
);

create table public.eval_runs (
  id              uuid primary key default gen_random_uuid(),
  prompt_version  text references public.prompt_versions,
  model           text not null,
  channel         text not null default 'chat' check (channel in ('voice', 'chat')),
  total           int,
  passed          int,
  avg_latency_ms  int,
  notes           text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create table public.eval_results (
  id               bigint generated always as identity primary key,
  run_id           uuid not null references public.eval_runs on delete cascade,
  case_id          text not null references public.eval_cases on delete cascade,
  passed           boolean not null,
  score            numeric(4, 3) check (score between 0 and 1),
  judge_reasoning  text,
  transcript       jsonb,
  tool_calls       jsonb,
  latency_ms       int,
  created_at       timestamptz not null default now(),
  unique (run_id, case_id)
);

-- ─────────────────────────────────────────────────────────────
-- Functions (called by the agent's tools via supabase.rpc)
-- ─────────────────────────────────────────────────────────────

-- Every bookable start time on a date, honoring schedules, lunch, leave,
-- existing bookings, service eligibility and the new-patient cutoff.
create or replace function public.get_available_slots(
  p_date              date,
  p_appointment_type  text,
  p_dentist_id        uuid    default null,
  p_is_new_patient    boolean default false
)
returns table (dentist_id uuid, dentist_name text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = public
as $$
  with s as (select * from clinic_settings where id),
  t as (select * from appointment_types where id = p_appointment_type),
  candidates as (
    select d.id         as dentist_id,
           d.full_name  as dentist_name,
           g.slot_start,
           g.slot_start + make_interval(mins => t.duration_minutes) as slot_end
    from dentists d
    join dentist_services ds  on ds.dentist_id = d.id and ds.appointment_type_id = p_appointment_type
    join dentist_schedules sch on sch.dentist_id = d.id and sch.weekday = extract(dow from p_date)
    cross join s
    cross join t
    cross join lateral generate_series(
      (p_date + sch.start_time) at time zone s.timezone,
      (p_date + sch.end_time - make_interval(mins => t.duration_minutes)) at time zone s.timezone,
      make_interval(mins => s.slot_step_minutes)
    ) as g(slot_start)
    where d.is_active
      and (p_dentist_id is null or d.id = p_dentist_id)
  )
  select c.dentist_id, c.dentist_name, c.slot_start, c.slot_end
  from candidates c
  cross join s
  where c.slot_start > now()
    -- lunch break
    and not tstzrange(c.slot_start, c.slot_end, '[)') && tstzrange(
          (p_date + s.lunch_start) at time zone s.timezone,
          (p_date + s.lunch_end)   at time zone s.timezone, '[)')
    -- new patients can't start at/after the cutoff
    and not (p_is_new_patient and (c.slot_start at time zone s.timezone)::time >= s.new_patient_cutoff)
    -- existing bookings
    and not exists (
      select 1 from appointments a
      where a.dentist_id = c.dentist_id
        and a.status = 'booked'
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(c.slot_start, c.slot_end, '[)'))
    -- dentist leave or clinic closure
    and not exists (
      select 1 from time_off o
      where (o.dentist_id is null or o.dentist_id = c.dentist_id)
        and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(c.slot_start, c.slot_end, '[)'))
  order by c.slot_start, c.dentist_name;
$$;

-- Books only if the slot is genuinely available; raises a clear error otherwise
-- (the error text goes back to the LLM as the tool result).
create or replace function public.book_appointment(
  p_patient_id        uuid,
  p_dentist_id        uuid,
  p_appointment_type  text,
  p_starts_at         timestamptz,
  p_source            text default 'chat',
  p_conversation_id   uuid default null,
  p_booked_by         uuid default null,
  p_notes             text default null
)
returns public.appointments
language plpgsql
set search_path = public
as $$
declare
  v_tz     text;
  v_is_new boolean;
  v_row    appointments;
begin
  select timezone into v_tz from clinic_settings where id;

  if not exists (select 1 from patients where id = p_patient_id) then
    raise exception 'PATIENT_NOT_FOUND: %', p_patient_id using errcode = 'P0002';
  end if;

  v_is_new := not exists (
    select 1 from appointments where patient_id = p_patient_id and status = 'completed');

  if not exists (
    select 1
    from get_available_slots((p_starts_at at time zone v_tz)::date, p_appointment_type, p_dentist_id, v_is_new) s
    where s.starts_at = p_starts_at
  ) then
    raise exception 'SLOT_UNAVAILABLE: % with dentist % at % cannot be booked', p_appointment_type, p_dentist_id, p_starts_at
      using errcode = 'P0001', hint = 'Call get_available_slots and offer the closest alternatives.';
  end if;

  insert into appointments (patient_id, dentist_id, appointment_type_id, starts_at, ends_at,
                            source, conversation_id, booked_by_patient_id, notes)
  select p_patient_id, p_dentist_id, p_appointment_type, p_starts_at,
         p_starts_at + make_interval(mins => t.duration_minutes),
         p_source, p_conversation_id, p_booked_by, p_notes
  from appointment_types t
  where t.id = p_appointment_type
  returning * into v_row;

  return v_row;
end;
$$;

-- Atomic reschedule: frees the old slot, books the new one, or rolls back entirely.
create or replace function public.reschedule_appointment(
  p_appointment_id   uuid,
  p_new_starts_at    timestamptz,
  p_new_dentist_id   uuid default null,
  p_source           text default 'chat',
  p_conversation_id  uuid default null
)
returns public.appointments
language plpgsql
set search_path = public
as $$
declare
  v_old appointments;
  v_new appointments;
begin
  select * into v_old from appointments where id = p_appointment_id for update;
  if not found or v_old.status <> 'booked' then
    raise exception 'APPOINTMENT_NOT_ACTIVE: %', p_appointment_id using errcode = 'P0001';
  end if;

  update appointments set status = 'rescheduled' where id = p_appointment_id;

  v_new := book_appointment(v_old.patient_id, coalesce(p_new_dentist_id, v_old.dentist_id),
                            v_old.appointment_type_id, p_new_starts_at, p_source,
                            p_conversation_id, v_old.booked_by_patient_id, v_old.notes);

  update appointments set rescheduled_from = p_appointment_id
  where id = v_new.id
  returning * into v_new;

  return v_new;
end;
$$;

-- Vector search over the clinic FAQ
create or replace function public.match_kb(
  query_embedding  extensions.vector(768),
  match_count      int   default 4,
  min_similarity   float default 0.3
)
returns table (id bigint, title text, category text, content text, similarity float)
language sql
stable
set search_path = public, extensions
as $$
  select k.id, k.title, k.category, k.content,
         1 - (k.embedding <=> query_embedding) as similarity
  from kb_documents k
  where k.embedding is not null
    and 1 - (k.embedding <=> query_embedding) >= min_similarity
  order by k.embedding <=> query_embedding
  limit match_count;
$$;

-- ─────────────────────────────────────────────────────────────
-- RLS: on everywhere, no public policies. Only the backend (service_role) reads/writes.
-- ─────────────────────────────────────────────────────────────
alter table public.clinic_settings   enable row level security;
alter table public.dentists          enable row level security;
alter table public.appointment_types enable row level security;
alter table public.dentist_services  enable row level security;
alter table public.dentist_schedules enable row level security;
alter table public.time_off          enable row level security;
alter table public.patients          enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;
alter table public.appointments      enable row level security;
alter table public.escalations       enable row level security;
alter table public.kb_documents      enable row level security;
alter table public.prompt_versions   enable row level security;
alter table public.eval_cases        enable row level security;
alter table public.eval_runs         enable row level security;
alter table public.eval_results      enable row level security;
