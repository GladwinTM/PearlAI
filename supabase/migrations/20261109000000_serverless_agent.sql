-- Serverless agent (Next.js on Vercel): state that the Python agent keeps in memory has to live in the database,
-- and FAQ retrieval can't load an embedding model per request.

-- Per-conversation agent state: LLM message history and the guards' memory (patient handles, offered slots, phones
-- the caller said, grounded times). Server-side only, so a client can't tamper with what the guards check.
alter table public.conversations add column if not exists agent_state jsonb;

-- Full-text FAQ search (title weighted above body, OR-matched stems, ranked). No embedding model needed, so it runs
-- in a serverless function instantly. The Python agent keeps using vector search (match_kb).
create or replace function public.search_kb(p_query text, p_limit int default 4)
returns table (id bigint, title text, content text, rank real)
language sql
stable
set search_path = public, pg_catalog
as $$
  with terms as (
    select string_agg(distinct w, ' | ') as q
    from regexp_split_to_table(lower(coalesce(p_query, '')), '[^a-z0-9]+') as w
    where length(w) >= 3
  ),
  query as (
    select to_tsquery('english', q) as tsq from terms where q is not null
  ),
  docs as (
    select k.id, k.title, k.content,
           setweight(to_tsvector('english', k.title), 'A') || setweight(to_tsvector('english', k.content), 'B') as doc
    from public.kb_documents k
  )
  select d.id, d.title, d.content, ts_rank_cd(d.doc, query.tsq)::real as rank
  from docs d, query
  where d.doc @@ query.tsq
  order by rank desc, d.id
  limit greatest(1, least(coalesce(p_limit, 4), 10));
$$;

revoke execute on function public.search_kb(text, int) from public, anon, authenticated;
grant execute on function public.search_kb(text, int) to service_role;
