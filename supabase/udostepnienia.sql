-- ============================================================================
--  UDOSTĘPNIANIE RAPORTÓW LINKIEM — jednorazowa instalacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--
--  Co robi:
--   1. Tabela `udostepnienia` — tokeny linków (kto, kiedy, ile otwarć).
--   2. RLS: zalogowani zarządzają linkami; anonim NIE ma dostępu do tabeli.
--   3. Funkcja `raport_po_tokenie(tok)` — JEDYNE okno dla niezalogowanych:
--      zwraca raport tylko przy ważnym tokenie (nie wyłączony, nie wygasły)
--      i przy okazji zlicza otwarcia. SECURITY DEFINER omija RLS raportów.
--
--  Link pokazuje ŻYWĄ wersję raportu (decyzja projektowa) — po edycji
--  raportu inwestor pod tym samym linkiem widzi stan aktualny.
-- ============================================================================

create table if not exists public.udostepnienia (
  id                uuid primary key default gen_random_uuid(),
  raport_id         uuid not null references public.raporty(id) on delete cascade,
  token             text not null unique,
  utworzyl          uuid references auth.users(id) on delete set null,
  utworzono         timestamptz not null default now(),
  wygasa            timestamptz not null default now() + interval '90 days',
  wylaczony         boolean not null default false,
  otwarcia          integer not null default 0,
  ostatnie_otwarcie timestamptz
);

create index if not exists udostepnienia_raport_idx on public.udostepnienia (raport_id);

alter table public.udostepnienia enable row level security;

-- Zalogowani: pełny wgląd i zarządzanie linkami (spójnie z dostępem do archiwum).
drop policy if exists udost_select on public.udostepnienia;
create policy udost_select on public.udostepnienia
  for select to authenticated using (true);

drop policy if exists udost_insert on public.udostepnienia;
create policy udost_insert on public.udostepnienia
  for insert to authenticated with check (utworzyl = auth.uid());

drop policy if exists udost_update on public.udostepnienia;
create policy udost_update on public.udostepnienia
  for update to authenticated using (true);

-- Anonim celowo BEZ żadnej polityki — tabela jest dla niego niewidoczna.

-- ----------------------------------------------------------------------------
-- Funkcja publiczna: raport po tokenie. Zwraca jsonb (wiersz raportu
-- + projekt_nazwa) albo NULL, gdy token nie istnieje / wygasł / wyłączony.
-- ----------------------------------------------------------------------------
create or replace function public.raport_po_tokenie(tok text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u      public.udostepnienia%rowtype;
  wynik  jsonb;
begin
  select * into u
    from public.udostepnienia
    where token = tok
      and not wylaczony
      and wygasa > now()
    limit 1;

  if not found then
    return null;
  end if;

  update public.udostepnienia
    set otwarcia = otwarcia + 1,
        ostatnie_otwarcie = now()
    where id = u.id;

  select to_jsonb(r) || jsonb_build_object('projekt_nazwa', p.nazwa)
    into wynik
    from public.raporty r
    left join public.projekty p on p.id = r.projekt_id
    where r.id = u.raport_id;

  return wynik;
end;
$$;

revoke all on function public.raport_po_tokenie(text) from public;
grant execute on function public.raport_po_tokenie(text) to anon, authenticated;
