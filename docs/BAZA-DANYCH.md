# Baza danych (Supabase) — co jest zapisane dla każdej inwestycji

Projekt Supabase: `fkhdahzreannrunlsphr` (PostgreSQL + Storage + Auth).
Bucket na pliki: **`raporty-zdjecia`** (publiczne URL-e, ścieżki typu `NAZWA_BUDOWY/nr5/...`).
Dostęp z front-endu: klucz publishable + Row Level Security. Role: **`admin`** i **`pm`**.

Dokument opisuje stan schematu odtworzony z kodu aplikacji (`src/supabase.js`,
`supabase/*.sql`, `supabase/functions/przypomnienia-raporty/index.ts`).

---

## Model w skrócie

```
uzytkownicy (PM/admin) ──< przypisania >── projekty (inwestycje) ──< raporty ──< udostepnienia (linki dla inwestora)
                                              │
                                            zakresy (słownik typów inwestycji + domyślne punkty)
```

Jedna **inwestycja** = jeden wiersz w `projekty`. Wszystko, co o niej wiadomo, siedzi w:
1. samym wierszu `projekty` (metadane koordynacyjne),
2. przypisanych do niej PM-ach (`przypisania` + `uzytkownicy`),
3. serii raportów okresowych (`raporty`) — tam jest 95% treści merytorycznej.

---

## 1. `projekty` — kartoteka inwestycji

| kolumna | typ | znaczenie |
|---|---|---|
| `id` | uuid | klucz główny |
| `nazwa` | text | nazwa budowy (unikalna w praktyce — po niej szuka aplikacja) |
| `aktywny` | bool | `true` = widoczna na liście wyboru; `false` = zakończona/zarchiwizowana |
| `wstrzymana` | bool | inwestycja stoi — zostaje na liście, ale **nie liczy się do obciążenia PM** |
| `zakres` | text (kod z `zakresy`) | typ/zakres inwestycji, determinuje domyślną punktację |
| `termin_zakonczenia` | date | planowany koniec (admin; domyślnie podpowiadany z harmonogramu ostatniego raportu) |

## 2. `raporty` — raporty okresowe z budowy (rdzeń danych)

Jeden wiersz = jeden raport (numeracja `numer` rośnie 1, 2, 3… w obrębie inwestycji).

**Identyfikacja i okres**
- `id` (uuid), `projekt_id` → `projekty.id`, `numer` (int)
- `okres_od`, `okres_do` — okres sprawozdawczy
- `data_opracowania`, `opracowal` (kto sporządził, tekst)
- `utworzono` (timestamptz), `utworzony_przez` (uuid → `auth.users`)
- `edycja_do` (timestamptz) — okno edycji odblokowane przez admina (NULL = zamknięte)

**Dane inwestycji powtarzane w raporcie**
- `adres`, `tytul_zadania`
- `rozpoczecie`, `zakonczenie_robot` (daty umowne)
- `pnu` (data pozwolenia na użytkowanie), `pnu_nie_dotyczy` (bool)

**Treść opisowa (pola tekstowe, wolny tekst)**
- `info_ogolne` — informacje ogólne
- `opoznienia` — opóźnienia i ich przyczyny
- `wykonawcy` — stan podwykonawców
- `przetargi` — przetargi / postępowania w toku
- `sprawy_budowy` — sprawy do załatwienia po stronie budowy
- `sprawy_inwestora` — sprawy po stronie inwestora
- `plac_budowy` — organizacja placu budowy
- `podsumowanie` — podsumowanie/status raportu

**Harmonogram i finanse — `harmonogram` (jsonb, tablica)**

Domyślnie 15 stałych zadań ZZK (roboty ziemne → zagospodarowanie terenu).
Każda pozycja:

```jsonc
{
  "zadanie": "Konstrukcja budynku — stan zero",
  "start":   "2026-03-01",   // planowany start
  "koniec":  "2026-05-30",   // termin umowny
  "rzecz":   "2026-06-15",   // prognoza / rzeczywiste zakończenie
  "proc":    "80",           // % zaawansowania
  "kwota":   "250000",       // wartość pozycji (podstawa cashflow) — opcjonalna
  "pod": [ { /* podpozycje o tej samej strukturze */ } ]
}
```

Z tego aplikacja liczy: opóźnienia (`rzecz` vs `koniec`), zaawansowanie ważone
z podpozycji, wykres postępu i **cashflow miesięczny** (kwoty rozkładane
kalendarzowo na miesiące między `start` a `koniec`/`rzecz`, z sumą narastającą).
Eksport do XLSX korzysta z tych samych danych.

**Pliki (URL-e do Storage)**
- `grafika_url` (text) — wizualizacja/okładka inwestycji
- `harmonogram_urls` (text[]) — obrazy harmonogramu (skany/zrzuty)
- `zdjecia` (jsonb) — dokumentacja fotograficzna: `[{ "url": "...", "opis": "...", "pion": true|false }]`
  (`pion` = zdjęcie pionowe, wpływa na układ w PDF)

## 3. `uzytkownicy` — PM-owie i administratorzy

`id` (= `auth.users.id`), `email`, `imie_nazwisko`, `rola` (`admin` / `pm`),
`pojemnosc` (limit punktów obciążenia, domyślnie 20), `inne_obowiazki` (punkty poza budowami).

## 4. `przypisania` — kto prowadzi którą inwestycję

`id`, `uzytkownik` (uuid → `uzytkownicy`), `projekt_id` (uuid → `projekty`),
`punkty` (punkty obciążenia za tę konkretną inwestycję; NULL = weź domyślne z `zakresy`).

## 5. `zakresy` — słownik zakresów inwestycji

`kod`, `nazwa`, `punkty` (globalna domyślna punktacja zakresu), `kolejnosc`.
Zmiana `punkty` tutaj przelicza obciążenie wszystkich inwestycji tego zakresu,
o ile na przypisaniu nie wpisano wartości nadpisującej.

## 6. `udostepnienia` — linki do raportu dla inwestora (bez logowania)

`id`, `raport_id` → `raporty.id` (ON DELETE CASCADE), `token` (32 znaki, unikalny),
`utworzyl` (uuid), `utworzono`, `wylaczony` (bool — unieważnienie, tylko admin),
`otwarcia` (int), `ostatnie_otwarcie` (timestamptz).

Link **nie wygasa** i pokazuje **żywą** wersję raportu (po edycji inwestor widzi stan aktualny).
Obsługa: funkcja `raport_po_tokenie(tok)` (SECURITY DEFINER) — jedyne wejście dla anonima,
zwraca wiersz raportu + `projekt_nazwa` i zlicza otwarcia.

## 7. `keep_alive` — tabela techniczna

`id`, `pinged_at`. Jedyna tabela z odczytem dla roli `anon`; GitHub Actions pinguje ją
2× w tygodniu, żeby darmowy projekt Supabase nie został zapauzowany.

---

## Bezpieczeństwo (RLS) — w skrócie

- Anonim: brak dostępu do danych — tylko `keep_alive` (SELECT) i RPC `raport_po_tokenie`.
- Zalogowani: odczyt archiwum; PM widzi na liście wyboru tylko inwestycje, do których jest przypisany.
- Edycja raportu: autor w oknie 24 h; po odblokowaniu przez admina (`edycja_do` w przyszłości)
  także autor i PM przypisani do budowy; admin — zawsze (`rap_update_admin`).
- Usuwanie raportu: tylko admin (kasuje też pliki ze Storage: zdjęcia, grafika, harmonogramy).
- Pomocnicze funkcje: `jest_admin()`, `jest_adminem()` (SECURITY DEFINER).

## Automatyzacja

Edge Function **`przypomnienia-raporty`** (uruchamiana w dni raportowe, SMTP przez M365):
czyta `projekty` (aktywne, z flagą `wstrzymana`), `przypisania` i `uzytkownicy`,
wysyła każdemu PM listę jego inwestycji do zaraportowania (wstrzymane z dopiskiem
„ – wstrzymana”), a adminom zbiorcze zestawienie pogrupowane po PM.

---

## Czego w bazie NIE ma

- Historii wersji raportu (edycja nadpisuje wiersz — jest tylko stan bieżący).
- Osobnej tabeli kontrahentów/podwykonawców — wykonawcy to wolny tekst w raporcie.
- Budżetu inwestycji poza kwotami pozycji harmonogramu (brak faktur, transz, rozliczeń).
- Logu zdarzeń/audytu (poza `utworzono`, `utworzony_przez` i licznikiem otwarć linku).
