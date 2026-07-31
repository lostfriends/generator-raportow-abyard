# `kartoteka-sync` — eksport bazy raportowej do Kartoteki

Edge Function, która wysyła **mailem** zawartość bazy Generatora Raportów do drugiej
aplikacji właściciela (**Kartoteka**). Po drugiej stronie skrzynki nie siedzi człowiek,
tylko automat, więc **treść maila jest kontraktem, nie tekstem do czytania** — format
opisany niżej jest tym, na czym oparto odbiorcę.

---

## Zasada naczelna: ta funkcja nic nie rozumie

**To jest decyzja projektowa, nie zaniedbanie.**

Funkcja **nie** liczy zaawansowania, **nie** liczy opóźnień ani cashflow, **nie** streszcza
tekstów, **nie** wybiera „istotnych” zdań, **nie** filtruje inwestycji po kraju ani zakresie
i **nie** ocenia, czy coś zmieniło się co do treści. Wysyła to, co jest w bazie.
**Cała analiza siedzi po stronie odbiorcy (Kartoteka) i tam się ją poprawia.**

Powód jest praktyczny: **ta baza ewoluuje.** Funkcja, która czegoś się o niej domyśla,
wymaga poprawki i deployu przy każdej zmianie schematu — a `to_jsonb(...)` przeżyje je bez
jednej linijki zmiany. Nowa kolumna w `raporty` pojedzie do Kartoteki sama, tego samego dnia,
w którym powstanie.

Jedyne rachunki, jakie tu są, są **mechaniczne** i nie dotykają znaczenia danych:

* sha256 tekstu payloadu (czy cokolwiek się zmieniło),
* długość tablicy (dwie linijki nagłówka dla człowieka),
* rozmiar w bajtach (podział na części),
* dopasowanie bieżącej minuty do wyrażenia cron (rozpoznanie przebiegu piątkowego).

Jeśli masz ochotę „dorzucić tu liczenie postępu” — **zrób to w Kartotece.** Tutaj każda taka
linijka to kolejny deploy przy kolejnej zmianie schematu.

---

## Co dokładnie wysyła

Jedno zapytanie, w całości po stronie bazy: funkcja SQL `kartoteka_eksport()`
(plik [`supabase/kartoteka_sync.sql`](../../kartoteka_sync.sql)). Zwraca jeden obiekt JSON
z sześcioma kluczami — **każdy to tablica całych wierszy**:

| klucz | zawartość |
|---|---|
| `zakresy` | wszystkie wiersze |
| `uzytkownicy` | wszystkie wiersze |
| `projekty` | wszystkie wiersze |
| `przypisania` | wszystkie wiersze |
| `raporty` | **dwa najnowsze raporty na inwestycję** (`row_number()` po `numer desc`) |
| `udostepnienia` | wszystkie wiersze |

Wiersze idą **w całości** — łącznie z pełnym `harmonogram`, kwotami, HTML-em w polach
tekstowych i kolumnami, które dopiero powstaną.

### Czego NIE wysyła

Wyłączone są **wyłącznie** cztery pola:

* `raporty.zdjecia`, `raporty.grafika_url`, `raporty.harmonogram_urls` — setki URL-i do plików,
* `udostepnienia.token` — nie wygasa i otwiera raport bez logowania.

Okno `rn <= 2` w `raporty` to **jedyne ograniczenie ilości**: historia się nie zmienia,
a odbiorca ma ją u siebie. **To nie jest selekcja treści — żadne pole nie jest oceniane.**

### Drobiazg dla odbiorcy: pole `rn`

`to_jsonb(r)` liczone jest na podzapytaniu z funkcją okna, więc każdy wiersz `raporty` niesie
dodatkowe pole `rn` (`1` = najnowszy raport inwestycji, `2` = poprzedni). Tak wyglądał ręczny
eksport z 31.07.2026, na którym zaprojektowano odbiorcę — i tak zostaje.

---

## Format maila (kontrakt)

* **Nadawca i odbiorca:** adres z `KARTOTEKA_SYNC_ODBIORCA` (mail sam do siebie).
* **Temat, dokładnie:**

  ```
  [RAPORTY-SYNC] 2026-07-31 18:00 · wydanie 12
  ```

  Znacznik czasu w temacie to **czas polski** (`Europe/Warsaw`), format `RRRR-MM-DD HH:MM`.
  Wszystkie części jednego wydania mają **identyczny temat** — części rozróżnia pole `czesc`
  w kopercie, nie temat.
* **Treść:** `text/plain`, **nigdy HTML** (encje psują JSON). Dwie linie nagłówka dla
  człowieka, potem payload w ogrodzeniu ```` ```json ````:

  ````
  Wydanie 12 · 2026-07-31 18:00 · część 1/2
  Inwestycje: 37 · raporty: 61 · payload 199 kB

  ```json
  {"wydanie":12,"wygenerowano":"2026-07-31T16:00:03.412Z","czesc":{"nr":1,"z":2},"dane":{…}}
  ```
  ````

* **Koperta:** `{ wydanie, wygenerowano, czesc: { nr, z }, dane }`, gdzie `dane` to wynik
  zapytania. `wygenerowano` jest **w UTC (ISO 8601)** — to jest wartość dla maszyny;
  czas w temacie i w pierwszej linii jest dla człowieka.

### Podział na części

Payload powyżej **200 kB** jest dzielony na części o **tym samym numerze wydania**;
różnią się polem `czesc: { nr, z }`. (Ręczny eksport całości ważył 887 kB z `jsonb_pretty`;
bez upiększania i z oknem dwóch raportów spodziewaj się 200–300 kB, czyli zwykle 1–2 części.)

Podział jest **ślepy na znaczenie**: bierze kolejne elementy tablic najwyższego poziomu
i pakuje je zachłannie. Nie zna nazw kluczy ani pól — nowa tabela w eksporcie podzieli się sama.

**Sklejenie po stronie odbiorcy** (posortuj części po `czesc.nr`):

```js
for (const czesc of czesciPosortowane)
  for (const [klucz, wartosc] of Object.entries(czesc.dane))
    wynik[klucz] = Array.isArray(wartosc) ? (wynik[klucz] ?? []).concat(wartosc) : wartosc;
```

Każda część niesie **komplet kluczy** (puste tablice tam, gdzie nic nie wpadło), więc kształt
`dane` jest w każdym mailu ten sam. Jedyny przypadek przekroczenia progu: pojedynczy wiersz
większy niż 200 kB — trafia do własnej części i ją przekracza.

---

## Wysyłka warunkowa

Po każdym przebiegu liczony jest **sha256** tekstu JSON payloadu i porównywany z `hash`
ostatniego wydania w tabeli `sync_wydania`.

* **Hash identyczny → nie wysyła i nie zakłada nowego wydania.** Przebieg kończy się
  odpowiedzią `{"ok":true,"wyslano":false,…}`.
* **Wyjątek:** przebieg zgodny z `KARTOTEKA_SYNC_PELNY_CRON` (piątek 18:00) wychodzi
  **zawsze**, także przy identycznym hashu — to domknięcie tygodnia i siatka na wydanie,
  które przepadło.

Porównanie idzie do ostatniego wydania **udanego** (`blad is null`). Wydanie, którego wysyłka
się nie powiodła, nie blokuje ponowienia — kolejny przebieg (za godzinę) spróbuje jeszcze raz.

---

## Kadencja

Wartości siedzą w **zmiennych środowiskowych**, nie w kodzie. Cron jest liczony **w UTC** —
poniżej czas **polski letni**:

| zmienna | wartość (lato) | znaczenie |
|---|---|---|
| `KARTOTEKA_SYNC_CRON` | `0 4-16 * * 1-5` | dni robocze, co godzinę 06:00–18:00 |
| `KARTOTEKA_SYNC_PELNY_CRON` | `0 16 * * 5` | piątek 18:00 — wysyłka bezwarunkowa |
| `KARTOTEKA_SYNC_ODBIORCA` | `ddziedzic@abyard.pl` | nadawca i odbiorca eksportu |

**Zimą obie przesuwają się o godzinę** (cron nie zna stref czasowych):

| zmienna | wartość (zima) |
|---|---|
| `KARTOTEKA_SYNC_CRON` | `0 5-17 * * 1-5` |
| `KARTOTEKA_SYNC_PELNY_CRON` | `0 17 * * 5` |

Trzynaście przebiegów dziennie nic nie kosztuje, bo wysyłka jest warunkowa: wychodzą tylko te,
w których hash się zmienił. Dzięki temu nowy raport trafia do odbiorcy w ciągu ~godziny,
niezależnie od dnia, a kadencja nie musi zgadywać, kiedy PM-owie raportują.

**Minuta ma znaczenie:** wysyłamy o pełnej godzinie (`0`), bo odbiorca czyta skrzynkę o `:01`.
Opóźnione dostarczenie niczego nie gubi — okno odbiorcy ma 3 h — ale przy `:00` update jest
w poczekalni w ciągu minut, a nie godziny.

### Zmiana kadencji

Kadencja jest zapisana w **dwóch** miejscach i muszą być zgodne:

1. **Harmonogram**, który faktycznie wywołuje funkcję (Supabase → Edge Functions → *Schedules*,
   albo `cron.schedule` — patrz „Instalacja”). To on decyduje, kiedy funkcja się budzi.
2. **Zmienna `KARTOTEKA_SYNC_PELNY_CRON`** — po niej funkcja **poznaje**, że bieżący przebieg
   jest tym piątkowym (bezwarunkowym). Dopasowanie ma 5 minut tolerancji na spóźniony start.

Zmieniasz porę? Zmień **oba**. `KARTOTEKA_SYNC_CRON` funkcja tylko zwraca w odpowiedzi
(informacyjnie) — nie ma na nic wpływu. Jeśli `KARTOTEKA_SYNC_PELNY_CRON` nie jest ustawiony,
funkcja działa dalej, ale żaden przebieg nie jest bezwarunkowy i zwraca ostrzeżenie w polu
`ostrzezenia`.

---

## `raporty.zaktualizowano` — po co ta kolumna

Raporty bywają **edytowane po zapisaniu**, a edycja nie zmienia ani `numer`, ani
`data_opracowania` — czyli odbiorca nie ma po czym poznać, że wiersz jest inny niż ten, który
już przetworzył. Bez tego znacznika poprawiony raport albo wchodzi drugi raz jako duplikat,
albo nie wchodzi wcale.

Kolumnę i trigger `before update` zakłada `supabase/kartoteka_sync.sql`. W schemacie **nie było**
pola o tym znaczeniu — jest `utworzono` (moment utworzenia) i `edycja_do` (termin okna edycji),
żadne z nich nie mówi, kiedy wiersz ostatnio zmieniono. Przy zakładaniu kolumny wiersze sprzed
migracji dostają `zaktualizowano = utworzono`, żeby archiwum nie wyglądało na „zmienione dzisiaj”.

Odbiorca rozpoznaje wiersz po `id`, a zmianę po `zaktualizowano`.

---

## Instalacja

1. **Schemat.** Uruchom `supabase/kartoteka_sync.sql` w SQL Editor (skrypt jest idempotentny).
   Zakłada `raporty.zaktualizowano` + trigger, tabelę `sync_wydania` i funkcję
   `kartoteka_eksport()`.
2. **Sekrety** (Supabase → Edge Functions → *Secrets*):
   `M365_USER`, `M365_PASS` (te same co dla `przypomnienia-raporty`),
   `KARTOTEKA_SYNC_ODBIORCA`, `KARTOTEKA_SYNC_CRON`, `KARTOTEKA_SYNC_PELNY_CRON`.
   **`KARTOTEKA_SYNC_ODBIORCA` musi być tą samą skrzynką co `M365_USER`** — M365 pozwala
   wysyłać wyłącznie „jako” uwierzytelniona skrzynka.
3. **Deploy:** `supabase functions deploy kartoteka-sync`.
4. **Harmonogram** — dwa wpisy, oba wołające tę samą funkcję. Przez panel
   (Edge Functions → *Schedules*) albo SQL-em (`pg_cron` + `pg_net`):

   ```sql
   select cron.schedule('kartoteka-sync', '0 4-16 * * 1-5', $$
     select net.http_post(
       url     := 'https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync',
       headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>',
                                     'Content-Type',  'application/json')
     );
   $$);

   select cron.schedule('kartoteka-sync-pelny', '0 16 * * 5', $$
     select net.http_post(
       url     := 'https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync',
       headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>',
                                     'Content-Type',  'application/json')
     );
   $$);
   ```

   Piątek 18:00 trafia w oba harmonogramy — drugi przebieg zobaczy identyczny hash, ale
   jako „pełny” wyjdzie mimo to. Nic się nie dubluje w sposób szkodliwy: to jedno wydanie
   więcej, dokładnie takie, jakie miało domknąć tydzień.

---

## Ręczne wywołanie (pierwszy test)

Jedno wydanie, natychmiast, niezależnie od hasha — `?pelny=1`:

```bash
curl -i -X POST \
  "https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync?pelny=1" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

**Przebieg na sucho** — policz payload, hash i liczbę części, **bez maila i bez wpisu**
w `sync_wydania` (dobre na rozgrzewkę przed pierwszą prawdziwą wysyłką):

```bash
curl -s "https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync?sucho=1" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
```

Bez parametrów funkcja zachowuje się jak przy przebiegu z harmonogramu: wyśle tylko, jeśli
hash się zmienił.

| parametr | działanie |
|---|---|
| *(brak)* | wysyłka warunkowa — tylko przy zmienionym hashu |
| `?pelny=1` | wysyłka bezwarunkowa, także przy identycznym hashu |
| `?sucho=1` | tylko wyliczenia; bez maila i bez wpisu w `sync_wydania` |

---

## Co poszło ostatnio — `sync_wydania`

Jeden wiersz = **jedno wydanie** (wydanie w dwóch częściach to nadal jeden wiersz).

```sql
-- ostatnie 20 wydań, bez ciężkiego payloadu
select numer,
       wygenerowano,
       left(hash, 12)              as hash,
       wyslano_do,
       pg_size_pretty(length(payload::text)::bigint) as rozmiar,
       blad
  from sync_wydania
 order by numer desc
 limit 20;
```

```sql
-- czy coś się w ostatnich dniach wysypało
select numer, wygenerowano, blad
  from sync_wydania
 where blad is not null
 order by numer desc;
```

```sql
-- co dokładnie poszło w wydaniu nr 12 (payload w czytelnej postaci)
select jsonb_pretty(payload) from sync_wydania where numer = 12;
```

Brak nowych wierszy przez kilka godzin w dzień roboczy to **normalne** — znaczy tyle, że nikt
nie zapisał ani nie poprawił raportu. Piątkowy przebieg bezwarunkowy zakłada wiersz zawsze,
więc jeśli nie ma go po piątku 18:00, problem leży w harmonogramie albo w SMTP —
zajrzyj do logów funkcji (Supabase → Edge Functions → `kartoteka-sync` → *Logs*)
i do kolumny `blad`.
