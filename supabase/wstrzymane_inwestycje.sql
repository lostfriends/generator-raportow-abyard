-- ============================================================================
--  WSTRZYMANIE INWESTYCJI (koordynacja PM) — instalacja / aktualizacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--  Skrypt jest idempotentny — można go puścić wielokrotnie.
--
--  Kontekst:
--   W panelu koordynacji (sekcja „Inwestycje — zakres i punkty PM") admin może
--   przełączyć inwestycję chipem Aktywna/Wstrzymana. Wstrzymana inwestycja
--   ZOSTAJE na liście (nadal aktywna, można raportować), ale jej punkty NIE
--   liczą się do obciążenia kierowników. Po przywróceniu na „Aktywna" punkty
--   naliczają się z powrotem — bez ręcznego zerowania.
--
--  Zapis pola wykonuje istniejąca ścieżka ustawKoordynacjeProjektu() (UPDATE
--  na projekty), objęta dotychczasowymi politykami RLS tabeli projekty.
-- ============================================================================

alter table public.projekty
  add column if not exists wstrzymana boolean not null default false;
