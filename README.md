# Generator raportów z budowy ABYARD

Aplikacja React (jeden komponent) budowana **esbuildem** do pojedynczego pliku `index.html`.
Repozytorium jest przystosowane do automatycznego budowania i publikowania przez **Netlify**:
po każdym pushu do gałęzi Netlify sam kompiluje kod i publikuje wynik.

---

## Struktura repozytorium

```
.
├── src/
│   ├── GeneratorRaportowABYARD.jsx   ← cały kod aplikacji (~3250 linii)
│   ├── supabase.js                   ← moduł bazy (klient Supabase + funkcje)
│   └── main.jsx                      ← punkt wejścia (montuje React w #root)
├── build.js                          ← skrypt budujący: esbuild → dist/index.html
├── package.json                      ← zależności + skrypt `npm run build`
├── netlify.toml                      ← konfiguracja Netlify (komenda + katalog dist/)
├── .gitignore                        ← wyklucza node_modules/ i dist/
└── README.md
```

Wynik builda **nie jest** w repozytorium — powstaje przy każdym buildzie. Build tworzy w `dist/`
**dwa** pliki: `index.html` (lekki, ~0,5 MB — cała aplikacja) oraz `pdfmake-lib.js` (~2,2 MB —
biblioteka pdfmake do eksportu PDF, ładowana **leniwie** dopiero przy pierwszym „Pobierz PDF").
Przy publikacji ręcznej trzeba wgrać **oba** pliki (Netlify publikuje cały katalog `dist/`, więc
tam dzieje się to automatycznie).

---

## Podłączenie do Netlify (jednorazowo)

1. Wrzuć całą zawartość tego katalogu do repozytorium **GitHub** (może być publiczne).
2. W panelu Netlify: **Add new site → Import an existing project → GitHub**, wybierz repozytorium.
3. Netlify sam odczyta `netlify.toml`, więc ustawienia builda powinny wypełnić się automatycznie:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
   Jeśli pola są puste, wpisz je ręcznie jak wyżej.
4. Kliknij **Deploy**. Pierwszy build potrwa ~1 minutę. Po nim strona jest publikowana.

> Jeśli masz już istniejący projekt Netlify pod adresem
> `generator-raportow-abyard.netlify.app`, możesz podłączyć repozytorium do
> **tego samego** projektu (Site settings → Build & deploy → Link repository),
> zamiast tworzyć nowy — wtedy adres zostaje bez zmian.

---

## Codzienna praca (po podłączeniu)

1. Dostajesz zmieniony plik (najczęściej `src/GeneratorRaportowABYARD.jsx`).
2. Podmieniasz go w repozytorium GitHub — przez stronę GitHuba (otwórz plik → edytuj → wklej → commit)
   albo przez GitHub Desktop.
3. Netlify wykrywa zmianę, buduje i publikuje. **Nie musisz nic budować ręcznie.**

Jeśli build się nie powiedzie (np. literówka w kodzie), Netlify **nie publikuje** — stara wersja
zostaje na produkcji. Log błędu z Netlify pozwala szybko namierzyć i poprawić problem.

---

## Build lokalny (opcjonalnie, do sprawdzenia)

```bash
npm install
npm run build
# wynik: dist/index.html — można otworzyć w przeglądarce
```

---

## Zaplecze Supabase

Katalog `supabase/` nie bierze udziału w buildzie Netlify — trzymamy w nim skrypty SQL
(uruchamiane ręcznie w SQL Editor, wszystkie idempotentne) oraz Edge Functions:

```
supabase/
├── keep_alive.sql            ← tabela pod ping z GitHub Actions (anty-pauza projektu)
├── udostepnienia.sql         ← linki do raportów (tokeny + RLS + raport_po_tokenie)
├── edycja_raportu.sql        ← okno edycji raportu przyznawane przez admina
├── wstrzymane_inwestycje.sql ← flaga projekty.wstrzymana
├── kartoteka_sync.sql        ← raporty.zaktualizowano, sync_wydania, kartoteka_eksport()
├── asystent_ai.sql           ← analizy_portfela, ai_uzycie, reset dziennej analizy (asystent AI)
└── functions/
    ├── przypomnienia-raporty/ ← cykliczne przypomnienia mailowe do PM i adminów
    ├── kartoteka-sync/        ← eksport bazy mailem do Kartoteki (README w katalogu)
    └── asystent-ai/           ← asystent AI (Claude API): analiza portfela, kontrola, styl
```

Obie funkcje wysyłają pocztę przez Microsoft 365 (SMTP + nodemailer) i korzystają z tych
samych sekretów `M365_USER` / `M365_PASS`, ustawianych w Supabase → Edge Functions → Secrets.

---

## Asystent AI (Claude API)

Trzy funkcje oparte na Claude API, obsługiwane przez Edge Function `asystent-ai`:

1. **Analiza portfela** — Archiwum raportów → przycisk „✦ Analiza portfela (AI)” (widoczny
   tylko dla administratorów). Przegląd wszystkich inwestycji w toku: ocena ryzyka, zmiany
   względem poprzedniego raportu, sprawy czekające na decyzję, jakość raportowania.
   Generowana **najwyżej raz dziennie** (czas polski). Wynik widzą wszyscy administratorzy,
   dopóki ktoś nie wygeneruje kolejnej. W Panelu admina (zakładka „Zarządzanie” → „Asystent AI”)
   jest **przełącznik resetu**, który pozwala wygenerować nową analizę jeszcze tego samego dnia.
2. **Kontrola raportu** — formularz → „✦ Sprawdź raport (AI)” (wszyscy). Wskazuje sprzeczności
   (podsumowanie vs opóźnienia/harmonogram), nieopisane opóźnienia, treść przepisaną bez zmian
   z poprzedniego raportu. **Nie blokuje zapisu.**
3. **Redakcja stylu** — przycisk „✦ Popraw styl (AI)” przy każdym polu opisowym (wszyscy).
   Propozycja pokazuje się obok oryginału; zmiana wchodzi do formularza dopiero po kliknięciu
   „Zastosuj propozycję”, a do bazy — przy zapisie raportu.

Klucz API **nie trafia do przeglądarki** — jest wyłącznie w sekretach Supabase.

### Instalacja (jednorazowo)

1. **SQL:** uruchom `supabase/asystent_ai.sql` w SQL Editor (idempotentny).
2. **Klucz API:** w [console.anthropic.com](https://console.anthropic.com) → API keys → utwórz klucz.
   Wpisz go w Supabase → Edge Functions → Secrets jako `ANTHROPIC_API_KEY`.
   Zalecenie: **nie włączaj „auto-reload”** w konsoli Anthropic — wtedy miesięczny kredyt
   jest twardym limitem wydatków.
3. **Deploy:** `supabase functions deploy asystent-ai --no-verify-jwt`
   (sesję zalogowanego użytkownika i rolę admina funkcja weryfikuje sama w kodzie).

### Koszty i limity

- Model: Claude Opus 5.5. Kontrola i redakcja: limit 60 wywołań na osobę na 24 h
  (stała `LIMIT_DZIENNY_NA_OSOBE` w `index.ts`).
- Każde wywołanie zapisuje się w tabeli `ai_uzycie` (tokeny + szacowany koszt w USD).
  Suma za bieżący miesiąc jest widoczna w Panelu admina. Faktyczne rozliczenie — w konsoli Anthropic.
- Do modelu trafiają treści raportów i imiona i nazwiska kierowników (bez zdjęć).

---

## Uwagi

- **Klucz Supabase** w `src/supabase.js` to klucz **publiczny** (publishable/anon) — jest
  bezpieczny do umieszczenia w publicznym repozytorium; taki klucz i tak trafia do przeglądarki.
  Właściwej ochrony danych pilnują reguły RLS po stronie Supabase, nie ukrycie tego klucza.
- Wersje zależności w `package.json` są **przypięte** (React 19.2.7, esbuild 0.28.1,
  @supabase/supabase-js 2.110.0), żeby build na Netlify był identyczny z lokalnym.
- `NODE_VERSION = "20"` w `netlify.toml` zapewnia zgodne środowisko Node.
