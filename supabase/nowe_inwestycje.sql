-- ============================================================================
--  DATA DODANIA INWESTYCJI (karencja na pierwszy raport) — instalacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--  Skrypt jest idempotentny — można go puścić wielokrotnie.
--
--  Kontekst:
--   Kafle w archiwum wyróżniają inwestycje bez aktualnego raportu (ponad 14 dni)
--   razem z nazwiskiem kierownika. Inwestycja dodana kilka dni temu nie miała
--   jeszcze KIEDY dostać raportu — gdyby od razu świeciła na czerwono, alarm
--   straciłby wiarygodność i PM przestaliby go czytać. Dlatego przez pierwsze
--   14 dni od dodania inwestycja pokazuje się jako „nowa", a nie „zalega".
--
--   Aplikacja czyta datę dodania z kolumny `utworzona` LUB `created_at` — bierze
--   tę, która istnieje (patrz dataDodaniaInwestycji w GeneratorRaportowABYARD.jsx).
--   Gdy nie ma żadnej z nich, karencja po prostu nie działa i wszystko zachowuje
--   się jak wcześniej. Ten skrypt dokłada kolumnę tylko wtedy, gdy brakuje obu.
--
--  Uzupełnienie istniejących wierszy:
--   - inwestycje, które już mają raporty  -> data najstarszego raportu,
--   - pozostałe                            -> 2026-07-10, czyli start cyklu
--     raportowego z funkcji przypomnienia-raporty. Dzięki temu inwestycje
--     istniejące przed wdrożeniem nie dostają świeżej karencji „na starcie".
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name  = 'projekty'
       and column_name in ('created_at', 'utworzona')
  ) then
    alter table public.projekty
      add column utworzona timestamptz not null default now();

    update public.projekty p
       set utworzona = coalesce(
             (select min(coalesce(r.utworzono, r.data_opracowania::timestamptz))
                from public.raporty r
               where r.projekt_id = p.id),
             timestamptz '2026-07-10 00:00:00+02'
           );

    raise notice 'Dodano kolumnę projekty.utworzona i uzupełniono istniejące wiersze.';
  else
    raise notice 'Tabela projekty ma już kolumnę z datą dodania — nic nie zmieniam.';
  end if;
end $$;
