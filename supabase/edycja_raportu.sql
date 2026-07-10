-- ============================================================================
--  ODBLOKOWANIE EDYCJI RAPORTU PRZEZ ADMINA — instalacja / aktualizacja
--  Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run.
--  Skrypt jest idempotentny — można go puścić wielokrotnie.
--
--  Kontekst:
--   Domyślnie PM może edytować swój raport tylko przez 24h od utworzenia
--   (limit liczony po stronie aplikacji). Ten skrypt dodaje możliwość
--   ODBLOKOWANIA edycji przez admina: admin ustawia `raporty.edycja_do`
--   na now()+24h, a wtedy — do tego terminu — raport może edytować:
--     - AUTOR raportu (utworzony_przez = auth.uid()), oraz
--     - PM PRZYPISANI do budowy (wpis w `przypisania` dla tego projektu).
--
--  RLS:
--   Dokładamy JEDNĄ dodatkową politykę UPDATE (permisywne polityki łączą się
--   przez OR), więc istniejące reguły (admin, okno 24h autora) zostają
--   nietknięte — nowa polityka tylko poszerza dostęp w przyznanym oknie.
-- ============================================================================

-- Kolumna z terminem, do którego edycja jest odblokowana (NULL = brak okna).
alter table public.raporty
  add column if not exists edycja_do timestamptz;

-- Edycja w oknie przyznanym przez admina: autor LUB przypisany PM.
drop policy if exists rap_update_okno_edycji on public.raporty;
create policy rap_update_okno_edycji on public.raporty
  for update to authenticated
  using (
    edycja_do is not null
    and edycja_do > now()
    and (
      utworzony_przez = auth.uid()
      or exists (
        select 1 from public.przypisania pr
        where pr.projekt_id = raporty.projekt_id
          and pr.uzytkownik = auth.uid()
      )
    )
  )
  with check (
    edycja_do is not null
    and edycja_do > now()
    and (
      utworzony_przez = auth.uid()
      or exists (
        select 1 from public.przypisania pr
        where pr.projekt_id = raporty.projekt_id
          and pr.uzytkownik = auth.uid()
      )
    )
  );
