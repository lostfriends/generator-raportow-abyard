-- ============================================================================
--  UDOSTĘPNIANIE RAPORTÓW LINKIEM — instalacja / aktualizacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--  Skrypt jest idempotentny — można go puścić na świeżej bazie i na takiej,
--  gdzie tabela `udostepnienia` już istnieje (zaktualizuje politykę i schemat).
--
--  Zasady:
--   1. Tabela `udostepnienia` — tokeny linków (kto, kiedy, ile otwarć).
--      Linki NIE wygasają — żyją, dopóki admin ich nie unieważni.
--   2. RLS:
--        - każdy zalogowany widzi linki i może TWORZYĆ nowe,
--        - UNIEWAŻNIAĆ (update) może TYLKO admin,
--        - anonim NIE ma dostępu do tabeli.
--   3. Funkcja `raport_po_tokenie(tok)` — JEDYNE okno dla niezalogowanych:
--      zwraca raport tylko przy ważnym (nie wyłączonym) tokenie i przy okazji
--      zlicza otwarcia. SECURITY DEFINER omija RLS raportów.
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
  wylaczony         boolean not null default false,
  otwarcia          integer not null default 0,
  ostatnie_otwarcie timestamptz
);

-- Migracja istniejącej instalacji: linki bez wygasania — usuwamy kolumnę `wygasa`.
alter table public.udostepnienia drop column if exists wygasa;

create index if not exists udostepnienia_raport_idx on public.udostepnienia (raport_id);

alter table public.udostepnienia enable row level security;

-- ----------------------------------------------------------------------------
-- Pomocnik: czy bieżący użytkownik jest adminem? SECURITY DEFINER, więc czyta
-- tabelę `uzytkownicy` niezależnie od jej własnego RLS (brak rekurencji polityk).
-- ----------------------------------------------------------------------------
create or replace function public.jest_adminem()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.uzytkownicy
    where id = auth.uid() and rola = 'admin'
  );
$$;

-- Zalogowani: pełny wgląd w listę linków (spójnie z dostępem do archiwum).
drop policy if exists udost_select on public.udostepnienia;
create policy udost_select on public.udostepnienia
  for select to authenticated using (true);

-- Tworzenie linków: każdy zalogowany, ale tylko „na siebie" (utworzyl = auth.uid()).
drop policy if exists udost_insert on public.udostepnienia;
create policy udost_insert on public.udostepnienia
  for insert to authenticated with check (utworzyl = auth.uid());

-- Unieważnianie (update `wylaczony`): TYLKO admin.
drop policy if exists udost_update on public.udostepnienia;
create policy udost_update on public.udostepnienia
  for update to authenticated
  using (public.jest_adminem())
  with check (public.jest_adminem());

-- Anonim celowo BEZ żadnej polityki — tabela jest dla niego niewidoczna.

-- ----------------------------------------------------------------------------
-- Funkcja publiczna: raport po tokenie. Zwraca jsonb (wiersz raportu
-- + projekt_nazwa) albo NULL, gdy token nie istnieje / jest wyłączony.
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
