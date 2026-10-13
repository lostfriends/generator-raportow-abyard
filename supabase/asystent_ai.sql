-- ============================================================================
--  ASYSTENT AI (Claude API) — instalacja / aktualizacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--  Skrypt jest idempotentny — można go puścić wielokrotnie.
--
--  Kontekst:
--   Edge Function `asystent-ai` obsługuje trzy funkcje oparte na Claude API:
--     1) analiza portfela inwestycji (tylko admin, archiwum raportów) —
--        generowana na żądanie, najwyżej RAZ NA DZIEŃ (czas polski); wynik
--        widzą wszyscy admini, aż ktoś wygeneruje kolejny,
--     2) kontrola spójności raportu przed zapisem (wszyscy zalogowani),
--     3) redakcja stylu pól opisowych (wszyscy zalogowani).
--
--   Tabele:
--     - analizy_portfela — zapisane analizy (1 aktywna na dzień: indeks
--       unikalny częściowy na `dzien where not uniewazniona`). Zapisuje WYŁĄCZNIE
--       Edge Function (service_role omija RLS); klient tylko czyta (admin).
--     - ai_uzycie — dziennik wywołań (tokeny, szacowany koszt) — do limitu
--       dziennego na osobę i do podglądu kosztów w panelu admina.
--
--   Reset limitu dziennego: funkcja `ustaw_reset_analizy_portfela(wlacz)`
--   (przełącznik w panelu admina). Włączenie unieważnia dzisiejszą analizę
--   (zostaje widoczna, ale blokada znika); wyłączenie — przywraca ją, o ile
--   w międzyczasie nikt nie wygenerował nowej.
-- ============================================================================

-- Pomocnik: czy bieżący użytkownik jest adminem? (identyczny jak w udostepnienia.sql
-- — powtórzony, by skrypt działał także na bazie bez tamtej instalacji).
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

-- ----------------------------------------------------------------------------
-- 1) Analizy portfela
-- ----------------------------------------------------------------------------
create table if not exists public.analizy_portfela (
  id                uuid primary key default gen_random_uuid(),
  -- Dzień limitu liczony w czasie polskim — jedno źródło prawdy dla „raz dziennie".
  dzien             date not null default ((now() at time zone 'Europe/Warsaw')::date),
  status            text not null default 'w_toku' check (status in ('w_toku', 'gotowa', 'blad')),
  uniewazniona      boolean not null default false,
  utworzono         timestamptz not null default now(),
  zakonczono        timestamptz,
  utworzyl          uuid references auth.users(id) on delete set null,
  utworzyl_nazwa    text,
  liczba_inwestycji integer,
  tresc             jsonb,
  model             text,
  blad              text,
  zresetowal        uuid references auth.users(id) on delete set null,
  zresetowano       timestamptz
);

-- Najwyżej jedna NIEunieważniona analiza na dzień. Chroni też przed wyścigiem,
-- gdy dwóch adminów kliknie „Generuj" w tej samej chwili — drugi INSERT odpada.
create unique index if not exists analizy_portfela_jedna_na_dzien
  on public.analizy_portfela (dzien) where not uniewazniona;

create index if not exists analizy_portfela_utworzono_idx
  on public.analizy_portfela (utworzono desc);

alter table public.analizy_portfela enable row level security;

-- Odczyt: tylko admini. Zapis: brak polityk — wyłącznie Edge Function (service_role).
drop policy if exists analizy_portfela_select on public.analizy_portfela;
create policy analizy_portfela_select on public.analizy_portfela
  for select to authenticated using (public.jest_adminem());

-- ----------------------------------------------------------------------------
-- 2) Dziennik użycia AI
-- ----------------------------------------------------------------------------
create table if not exists public.ai_uzycie (
  id          bigint generated always as identity primary key,
  utworzono   timestamptz not null default now(),
  uzytkownik  uuid references auth.users(id) on delete set null,
  tryb        text not null,          -- portfel | kontrola | styl
  model       text,
  tokeny_we   integer,
  tokeny_wy   integer,
  koszt_usd   numeric(10, 4)          -- szacunek wg cennika API (bez rabatów)
);

create index if not exists ai_uzycie_uzytkownik_idx on public.ai_uzycie (uzytkownik, utworzono desc);
create index if not exists ai_uzycie_utworzono_idx on public.ai_uzycie (utworzono desc);

alter table public.ai_uzycie enable row level security;

drop policy if exists ai_uzycie_select on public.ai_uzycie;
create policy ai_uzycie_select on public.ai_uzycie
  for select to authenticated using (public.jest_adminem());

-- ----------------------------------------------------------------------------
-- 3) Przełącznik resetu dziennej analizy (panel admina)
-- ----------------------------------------------------------------------------
create or replace function public.ustaw_reset_analizy_portfela(wlacz boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  dzis date := (now() at time zone 'Europe/Warsaw')::date;
begin
  if not public.jest_adminem() then
    raise exception 'Brak uprawnień administratora';
  end if;

  if wlacz then
    -- Unieważniamy dzisiejszą gotową analizę — znika blokada „raz dziennie".
    update public.analizy_portfela
       set uniewazniona = true, zresetowal = auth.uid(), zresetowano = now()
     where dzien = dzis and not uniewazniona and status = 'gotowa';
  else
    -- Cofnięcie resetu: przywracamy ostatnią zresetowaną dzisiejszą analizę,
    -- ale tylko gdy nikt w międzyczasie nie wygenerował nowej.
    if not exists (
      select 1 from public.analizy_portfela where dzien = dzis and not uniewazniona
    ) then
      update public.analizy_portfela
         set uniewazniona = false, zresetowal = null, zresetowano = null
       where id = (
         select id from public.analizy_portfela
          where dzien = dzis and uniewazniona and status = 'gotowa' and zresetowano is not null
          order by utworzono desc
          limit 1
       );
    end if;
  end if;
end;
$$;

revoke all on function public.ustaw_reset_analizy_portfela(boolean) from public, anon;
grant execute on function public.ustaw_reset_analizy_portfela(boolean) to authenticated;
