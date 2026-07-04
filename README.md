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

Wynik builda (`dist/index.html`) **nie jest** w repozytorium — powstaje przy każdym buildzie.

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

## Uwagi

- **Klucz Supabase** w `src/supabase.js` to klucz **publiczny** (publishable/anon) — jest
  bezpieczny do umieszczenia w publicznym repozytorium; taki klucz i tak trafia do przeglądarki.
  Właściwej ochrony danych pilnują reguły RLS po stronie Supabase, nie ukrycie tego klucza.
- Wersje zależności w `package.json` są **przypięte** (React 19.2.7, esbuild 0.28.1,
  @supabase/supabase-js 2.110.0), żeby build na Netlify był identyczny z lokalnym.
- `NODE_VERSION = "20"` w `netlify.toml` zapewnia zgodne środowisko Node.
