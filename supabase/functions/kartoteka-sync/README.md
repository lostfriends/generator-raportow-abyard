# `kartoteka-sync` — eksport bazy raportowej do Kartoteki

Edge Function, która wysyła **mailem** zawartość bazy Generatora Raportów do drugiej
aplikacji właściciela (**Kartoteka**). Po drugiej stronie skrzynki nie siedzi człowiek,
tylko automat, więc **mail jest kontraktem, nie tekstem do czytania** — format opisany
niżej jest tym, na czym oparto odbiorcę.

Payload jedzie **w załączniku JSON**; treść wiadomości to trzy linie dla człowieka i nic
poza tym. Przebiegi zwykłe niosą **tylko zmienione raporty**, piątkowy — komplet.

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
* porównanie wierszy `raporty` **bajt w bajt po `id`** z poprzednim wydaniem (patrz „Tryb
  wydania” niżej) — bez wiedzy o tym, co które pole znaczy,
* długość tablicy (linie nagłówka dla człowieka),
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
| `raporty` | **najnowszy raport na inwestycję** (`row_number()` po `numer desc`) — w przebiegu zwykłym dodatkowo przycięte do wierszy zmienionych, patrz „Tryb wydania” |
| `udostepnienia` | wszystkie wiersze |

Wiersze idą **w całości** — łącznie z pełnym `harmonogram`, kwotami, HTML-em w polach
tekstowych i kolumnami, które dopiero powstaną.

### Czego NIE wysyła

Wyłączone są **wyłącznie** cztery pola:

* `raporty.zdjecia`, `raporty.grafika_url`, `raporty.harmonogram_urls` — setki URL-i do plików,
* `udostepnienia.token` — nie wygasa i otwiera raport bez logowania.

Okno `rn <= 1` w `raporty` to **jedyne ograniczenie ilości**: historia się nie zmienia,
a odbiorca ma ją u siebie. **To nie jest selekcja treści — żadne pole nie jest oceniane.**

Okno było pierwotnie `rn <= 2` (dwa najnowsze raporty). Gdyby odbiorca kiedyś potrzebował
poprzedniego raportu do porównania, zmiana wraca w **jedno miejsce** — cyfrę w `where r.rn <= …`
w `kartoteka_eksport()`. Funkcji ani jej deployu to nie dotyka.

### Drobiazg dla odbiorcy: pole `rn`

`to_jsonb(r)` liczone jest na podzapytaniu z funkcją okna, więc każdy wiersz `raporty` niesie
dodatkowe pole `rn` — przy obecnym oknie **zawsze `1`**. Tak wyglądał ręczny eksport
z 31.07.2026, na którym zaprojektowano odbiorcę, i tak zostaje.

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
* **Treść:** `text/plain`, **nigdy HTML**. Trzy linie dla człowieka — **payload jest
  w załączniku, nie w treści**:

  ```
  Wydanie 12 · 2026-07-31 18:00 · część 1/2 · tryb zmiany
  Inwestycje: 36 · raporty w wydaniu: 3 z 26 · payload 61 kB

  Payload w załączniku: raporty-sync-w12-cz1z2.json
  ```

* **Załącznik:** jeden na wiadomość, `application/json; charset=utf-8`, nazwa
  `raporty-sync-w<wydanie>-cz<nr>z<z>.json`. W nim koperta i tylko ona.
* **Koperta:** `{ wydanie, wygenerowano, tryb, czesc: { nr, z }, dane }`, gdzie `dane` to
  wynik zapytania (w trybie `zmiany` z przyciętą tablicą `raporty` — patrz niżej).
  `wygenerowano` jest **w UTC (ISO 8601)** — to jest wartość dla maszyny; czas w temacie
  i w pierwszej linii jest dla człowieka.

### Dlaczego payload jest załącznikiem, a nie w treści

Pierwsza wersja wklejała JSON do treści `text/plain` w ogrodzeniu ```` ```json ````. Pomiar
na wydaniach 2 i 3 pokazał, że to, co dociera do odbiorcy, jest **o jedno odescapowanie za
daleko**: `\"` przychodzi jako `"`, `\\` jako `\`, `\\n` jako `\n`. Payload przestaje być
parsowalnym JSON-em wszędzie tam, gdzie w treści raportu siedzi HTML z cudzysłowami — a siedzi,
bo raporty bywają wklejane z Worda. Kopia z Odebranych i z Wysłanych są identyczne co do bajta,
więc nie robi tego poczta przychodząca; sprawcy nie udało się wskazać jednoznacznie.

Załącznik omija cały ten problem: jedzie **base64** i nikt go po drodze nie „poprawia".

**Odbiorca czyta załącznik, nie treść.** Dekodowanie robi za niego każda biblioteka pocztowa
(`email` w Pythonie, `mailparser` w Node, `MimeMessage` w .NET). Treść maila jest odtąd
wyłącznie dla człowieka — **nie ma w niej payloadu i nie będzie**.

### Podział na części

Payload powyżej **80 kB** jest dzielony na części o **tym samym numerze wydania**;
różnią się polem `czesc: { nr, z }` i nazwą załącznika.

**Skąd 80 kB, a nie 200 kB:** odbiorca czyta załącznik przez konektor, który **ucina odczyt
na 100 000 znaków**. Przekroczenie progu nie daje błędu — daje po cichu urwany JSON. Próg
80 kB trzyma każdą kopertę pod limitem nawet w najgorszym przypadku (czysty ASCII, gdzie bajt
= znak; zmierzone maksimum to ok. 81 tys. znaków na część). **Podniesienie `LIMIT_CZESCI`
urwie payload bez ostrzeżenia** — to nie jest stała do „optymalizacji".

Rzędy wielkości z 31.07.2026: pełny eksport to ok. 366 kB, z czego same `raporty` 344 kB.
Przebieg pełny idzie więc w kilku częściach, a typowy przebieg ze zmianami mieści się w jednej.
**Odbiorca nie może zakładać, że mail jest jeden** — obsługa `czesc: { nr, z }` jest obowiązkowa.

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
większy niż 80 kB — trafia do własnej części i ją przekracza.

---

## Tryb wydania: `pelny` i `zmiany`

Pole `tryb` w kopercie mówi, **co jest w tym wydaniu**:

| `tryb` | `raporty` w kopercie | pozostałe tabele | kiedy |
|---|---|---|---|
| `zmiany` | **tylko wiersze, które doszły lub się zmieniły** | zawsze w całości | przebiegi zwykłe (co godzinę) |
| `pelny` | **komplet** | zawsze w całości | piątek 18:00 oraz `?pelny=1` |

Porównanie jest **bajtowe**: `JSON.stringify` wiersza zestawiony po `id` z tym samym wierszem
z payloadu poprzedniego wydania. Funkcja nie wie, co które pole znaczy — nie sprawdza, czy
zmiana jest „istotna". `jsonb` zwraca klucze w stałej kolejności, więc porównanie tekstów jest
stabilne. Wiersz **bez `id`** jest wysyłany zawsze (nie ma po czym porównać — nie ryzykujemy).

Powód jest arytmetyczny, nie znaczeniowy: `raporty` to 344 kB z 366 kB całego eksportu, a
odbiorca ma limit odczytu (patrz „Podział na części"). Typowe wydanie schodzi dzięki temu
z ~350 kB do kilkudziesięciu kB. Pozostałe tabele to razem ~22 kB i jadą **zawsze w całości** —
bez `projekty` i `przypisania` odbiorca nie ma jak dopasować inwestycji ani PM-a, a oszczędność
byłaby żadna.

Do `sync_wydania.payload` zapisywany jest **payload PEŁNY**, nie skrót. To on jest punktem
odniesienia dla następnego porównania; skrót istnieje wyłącznie w mailu.

### Co to znaczy dla odbiorcy

1. **Wydanie w trybie `zmiany` to nakładka, nie stan.** Kartoteka musi wmontować przysłane
   wiersze `raporty` w to, co już ma (upsert po `id`), a nie zastępować nimi całości —
   inaczej po pierwszym takim wydaniu zostaną jej trzy raporty zamiast dwudziestu sześciu.
2. **Usunięć nie widać w trybie `zmiany`.** Skasowany raport nie generuje żadnego wiersza.
   Jedyny moment, w którym odbiorca może wykryć usunięcie, to wydanie `pelny` — tam dostaje
   komplet i może potraktować go jako stan wzorcowy. To kolejny powód, dla którego piątkowy
   przebieg bezwarunkowy nie jest ozdobnikiem.
3. **Pozostałe tabele zawsze zastępuj w całości** — w obu trybach przyjeżdżają kompletne.
4. `raporty w wydaniu: 3 z 26` w treści maila mówi wprost, ile wierszy niesie to wydanie
   z ilu istniejących.

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
   select cron.schedule('kartoteka-sync', '0 4-16 * * 1-5', $cron$
   select net.http_post(
     url := 'https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync',
     headers := jsonb_build_object(
       'Authorization', 'Bearer <SEKRET>',
       'Content-Type', 'application/json'
     ),
     timeout_milliseconds := 60000
   );
   $cron$);
   ```

   Drugi wpis jest identyczny, zmienia się tylko nazwa i harmonogram:
   `cron.schedule('kartoteka-sync-pelny', '0 16 * * 5', …)`.

   **`timeout_milliseconds := 60000` nie jest ozdobnikiem.** Domyślny timeout `net.http_post`
   to **1 sekunda**, a ta funkcja potrzebuje kilku sekund na eksport i SMTP — przy domyślnej
   wartości pg_net zrywa połączenie w trakcie i przebieg potrafi urwać się w środku wysyłki.

   Piątkowy wpis woła **ten sam adres, bez parametrów** — funkcja rozpozna swój przebieg
   bezwarunkowy po `KARTOTEKA_SYNC_PELNY_CRON`. Piątek 18:00 trafia w oba harmonogramy:
   drugi przebieg zobaczy identyczny hash, ale jako „pełny” wyjdzie mimo to. Nic się nie
   dubluje szkodliwie — to jedno wydanie więcej, dokładnie takie, jakie miało domknąć tydzień.

   Bez pisania SQL-a: **Integrations → Cron → Create job**, typ *Supabase Edge Function*.

   Sprawdzenie, że wpisy istnieją — warto zrobić od razu, bo brak harmonogramu wygląda
   dokładnie tak samo jak „nic się nie zmieniło”, czyli jak cisza w skrzynce:

   ```sql
   select jobid, jobname, schedule, active from cron.job order by jobid;
   select jobid, status, return_message, start_time
     from cron.job_run_details order by start_time desc limit 10;
   ```

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

`?sucho=1` jest sprawdzane **przed** porównaniem hasha, więc podaje rozmiar i liczbę części
także wtedy, gdy od ostatniego wydania nic się nie zmieniło — czyli w sytuacji, w której
najczęściej się go używa. Odpowiedź niesie przy okazji `bez_zmian`, `ostatnie_wydanie` i `cron`.

Ustawienie obu parametrów naraz nie ma sensu: **`sucho` wygrywa** i mail nie wyjdzie.

### Bez terminala — panel testowy (najprościej)

Supabase → **Edge Functions** → `kartoteka-sync` → **Test**. W sekcji **Query Parameters**
wpisujesz `sucho` = `1` (a potem `pelny` = `1`) i klikasz **Send Request**.

Metodę zostaw na `POST`, `Request Body` może zostać z domyślną zawartością — funkcja w ogóle
nie czyta ciała żądania. **Klucza nie potrzebujesz**: panel uwierzytelnia się sam rolą
wybraną w polu obok przycisku (`postgres`). Odpowiedź pojawia się w tym samym panelu.

### Bez terminala — SQL Editor

Wariant dla wywołań skryptowanych (`pg_net` i tak jest potrzebny do harmonogramu):

```sql
select net.http_post(
  url     := 'https://<PROJEKT>.supabase.co/functions/v1/kartoteka-sync?sucho=1',
  headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>',
                                'Content-Type',  'application/json')
);
```

Wywołanie jest asynchroniczne — zwraca `id` żądania, a odpowiedź dojedzie chwilę później:

```sql
select id, status_code, content
  from net._http_response
 order by id desc
 limit 3;
```

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

### „Przyszły dwa identyczne maile" — część czy duplikat?

Trzy rzeczy, które przy tej funkcji wyglądają jak duplikat, a nim nie są:

1. **Części jednego wydania mają identyczny temat** (tak brzmi kontrakt). Różnią się
   **pierwszą linią treści** (`część 1/2`, `część 2/2`), **nazwą załącznika**
   (`…-cz1z2.json`, `…-cz2z2.json`) oraz polem `czesc` w kopercie. Outlook skleja je
   w jeden wątek, bo temat jest ten sam.
2. **Mail idzie sam do siebie**, więc Exchange trzyma go w **Odebranych i Wysłanych**.
   To ta sama wiadomość w dwóch folderach, nie dwie wysyłki.
3. Rozstrzyga **`Message-ID`** (Outlook: *Plik → Właściwości → Nagłówki internetowe*).
   Ten sam `Message-ID` = jedna wysyłka, dwie kopie. Różny = dwa maile.
   Kopię z Wysłanych poznasz też po tym, że ma **wyraźnie mniej nagłówków** i brak
   `X-Forefront-Antispam` / `SCL` — nigdy nie była doręczana, więc nie przeszła filtrowania.

**Klucz odsiewania po stronie odbiorcy: para `wydanie` + `czesc.nr`.** Kartoteka czytająca
wyłącznie *Odebrane* nie zobaczy duplikatów; ta, która przegląda całą skrzynkę (Graph, IMAP po
wszystkich folderach), dostanie każdą część dwa razy — raz z Odebranych, raz z Wysłanych.

Kopię w Wysłanych da się wyłączyć po stronie M365
(`Set-Mailbox <skrzynka> -MessageCopyForSMTPClientSubmissionEnabled $false`), ale ustawienie
działa na **całą skrzynkę** — zniknie wtedy również ślad po mailach z `przypomnienia-raporty`.
Odsiewanie u odbiorcy jest tańsze i nie zabiera nikomu historii wysyłki.

Podział bywa nierówny i to też jest w porządku: klucze pakowane są po kolei, więc część 1
potrafi zawierać wyłącznie `raporty`, a całą resztę (`projekty`, `uzytkownicy`, `przypisania`,
`udostepnienia`) znajdziesz dopiero w części ostatniej. **Dopiero komplet części to komplet
danych** — nagłówek „Inwestycje: 36 · raporty w wydaniu: 3 z 26" podaje liczby dla całego
wydania, nie dla tej jednej części.

Brak nowych wierszy przez kilka godzin w dzień roboczy to **normalne** — znaczy tyle, że nikt
nie zapisał ani nie poprawił raportu. Piątkowy przebieg bezwarunkowy zakłada wiersz zawsze,
więc jeśli nie ma go po piątku 18:00, problem leży w harmonogramie albo w SMTP —
zajrzyj do logów funkcji (Supabase → Edge Functions → `kartoteka-sync` → *Logs*)
i do kolumny `blad`.
