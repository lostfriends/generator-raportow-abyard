// ============================================================================
//  ABYARD — Edge Function: kartoteka-sync
//
//  Wysyła mailem eksport bazy raportowej do drugiej aplikacji właściciela
//  (Kartoteka). Odbiorcą jest AUTOMAT, więc treść maila jest KONTRAKTEM,
//  nie tekstem dla człowieka — szczegóły w README.md obok.
//
//  ZASADA NACZELNA: TA FUNKCJA NIC NIE ROZUMIE.
//  Nie liczy zaawansowania, nie liczy opóźnień ani cashflow, nie streszcza
//  tekstów, nie wybiera „istotnych" zdań, nie filtruje inwestycji po kraju ani
//  zakresie, nie ocenia, czy coś zmieniło się co do treści. Wysyła to, co jest
//  w bazie. Cała analiza siedzi po stronie odbiorcy i tam się ją poprawia.
//  Powód: TA BAZA EWOLUUJE — funkcja, która czegoś się o niej domyśla, wymaga
//  poprawki i deployu przy każdej zmianie schematu, a `to_jsonb` przeżyje je
//  bez jednej linijki. Jeśli masz ochotę „dorzucić tu liczenie postępu" —
//  przeczytaj najpierw README.md. To decyzja, nie zaniedbanie.
//
//  Jedyne rachunki, jakie ta funkcja wykonuje, są mechaniczne i nie dotykają
//  znaczenia danych: sha256 payloadu, długość tablicy, rozmiar w bajtach,
//  dopasowanie bieżącej minuty do wyrażenia cron.
//
//  Wysyłka: Microsoft 365 (SMTP smtp.office365.com:587, STARTTLS, nodemailer)
//  — identycznie jak w funkcji `przypomnienia-raporty`.
//
//  Sekrety / konfiguracja (Supabase → Edge Functions → Secrets, NIE w kodzie):
//   - M365_USER                  — skrzynka nadawcza (uwierzytelniana w SMTP)
//   - M365_PASS                  — hasło do niej albo (przy MFA) hasło aplikacji
//   - KARTOTEKA_SYNC_ODBIORCA    — adres nadawcy I odbiorcy eksportu
//   - KARTOTEKA_SYNC_CRON        — kadencja przebiegów (informacyjnie, w odpowiedzi)
//   - KARTOTEKA_SYNC_PELNY_CRON  — kadencja przebiegu BEZWARUNKOWEGO
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — wstrzykiwane przez Supabase
//
//  Uwaga: service_role omija RLS — dlatego funkcja widzi wszystkie dane.
//         Ten klucz oraz M365_PASS NIGDY nie mogą trafić do front-endu.
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

// Próg podziału payloadu na części (bajty tekstu JSON).
const LIMIT_CZESCI = 200 * 1024;

// Ile minut wstecz sprawdzać przy dopasowaniu do KARTOTEKA_SYNC_PELNY_CRON.
// Scheduler potrafi odpalić funkcję kilkadziesiąt sekund po pełnej godzinie,
// a zimny start dokłada swoje. Fałszywe trafienie kosztuje jeden mail więcej.
const TOLERANCJA_MIN = 5;

// --- narzędzia mechaniczne ---------------------------------------------------

const bajty = (s: string): number => new TextEncoder().encode(s).length;

async function sha256hex(tekst: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Data w temacie maila: czas polski (Europe/Warsaw), format RRRR-MM-DD HH:MM.
// Maszynowy, jednoznaczny znacznik UTC jedzie w kopercie jako `wygenerowano`.
function fmtWarszawa(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Warsaw",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d).replace(",", "");
}

// --- dopasowanie do wyrażenia cron (5 pól, czas UTC) -------------------------
// Obsługiwane: `*`, liczby, listy `a,b`, zakresy `a-b`, kroki `*/n` i `a-b/n`.
// Potrzebne wyłącznie po to, żeby funkcja poznała SWÓJ przebieg piątkowy —
// harmonogram i tak siedzi w schedulerze, tutaj jest tylko jego kopia z env.
const GRANICE: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function polePasuje(pole: string, wartosc: number, [min, max]: [number, number]): boolean {
  return pole.split(",").some((czlon) => {
    const [zakres, krokTxt] = czlon.split("/");
    const krok = krokTxt === undefined ? 1 : parseInt(krokTxt, 10);
    if (!Number.isInteger(krok) || krok < 1) return false;

    let od: number, doo: number;
    if (zakres === "*") {
      od = min; doo = max;
    } else if (zakres.includes("-")) {
      const [a, b] = zakres.split("-").map((x) => parseInt(x, 10));
      if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
      od = a; doo = b;
    } else {
      const a = parseInt(zakres, 10);
      if (!Number.isInteger(a)) return false;
      od = a; doo = krokTxt === undefined ? a : max;
    }
    // Dzień tygodnia: 7 to też niedziela.
    if (max === 6) { od = od % 7; doo = doo % 7; }
    if (wartosc < od || wartosc > doo) return false;
    return (wartosc - od) % krok === 0;
  });
}

function cronPasuje(wyrazenie: string, d: Date): boolean {
  const pola = wyrazenie.trim().split(/\s+/);
  if (pola.length !== 5) return false;
  const wartosci = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return pola.every((pole, i) => polePasuje(pole, wartosci[i], GRANICE[i]));
}

// Czy BIEŻĄCY przebieg jest tym „pełnym" (bezwarunkowym) — z tolerancją minut.
function czyPrzebiegPelny(wyrazenie: string, teraz: Date): boolean {
  for (let i = 0; i <= TOLERANCJA_MIN; i++) {
    if (cronPasuje(wyrazenie, new Date(teraz.getTime() - i * 60_000))) return true;
  }
  return false;
}

// --- podział payloadu na części ----------------------------------------------
// Podział jest ŚLEPY na znaczenie: bierze kolejne elementy tablic najwyższego
// poziomu i pakuje je zachłannie, aż część urośnie do LIMIT_CZESCI. Nie zna
// nazw kluczy ani pól — nowa tabela w eksporcie podzieli się sama.
//
// Reguła sklejania po stronie odbiorcy (posortuj części po `czesc.nr`):
//   dla każdego klucza: tablica -> konkatenacja, cokolwiek innego -> podstawienie.
// Każda część niesie WSZYSTKIE klucze tablicowe (puste, gdy nic z nich nie
// wpadło), więc kształt `dane` jest w każdym mailu ten sam.
//
// Pojedynczy element większy niż limit trafia do własnej części i ją przekracza
// — to jedyny przypadek, w którym mail może być większy niż próg.
function podzielNaCzesci(dane: unknown, limit: number): Record<string, unknown>[] {
  const wejscie = (dane && typeof dane === "object") ? dane as Record<string, unknown> : {};
  const klucze = Object.keys(wejscie);
  const kluczeTablic = klucze.filter((k) => Array.isArray(wejscie[k]));
  const kluczeInne = klucze.filter((k) => !Array.isArray(wejscie[k]));

  const nowaCzesc = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const k of kluczeTablic) o[k] = [];
    return o;
  };

  const czesci: Record<string, unknown>[] = [];
  let biezaca = nowaCzesc();
  let rozmiar = 0;

  // Wartości nietablicowe (gdyby kiedyś się pojawiły) jadą w części pierwszej.
  for (const k of kluczeInne) {
    biezaca[k] = wejscie[k];
    rozmiar += bajty(JSON.stringify(wejscie[k] ?? null));
  }

  for (const k of kluczeTablic) {
    for (const element of wejscie[k] as unknown[]) {
      const r = bajty(JSON.stringify(element ?? null)) + 1; // +1 na przecinek
      if (rozmiar > 0 && rozmiar + r > limit) {
        czesci.push(biezaca);
        biezaca = nowaCzesc();
        rozmiar = 0;
      }
      (biezaca[k] as unknown[]).push(element);
      rozmiar += r;
    }
  }
  czesci.push(biezaca);
  return czesci;
}

// --- SMTP (identycznie jak w przypomnienia-raporty) --------------------------

function polaczSMTP(): any {
  const user = Deno.env.get("M365_USER");
  const pass = Deno.env.get("M365_PASS");
  if (!user || !pass) throw new Error("Brak sekretów M365_USER / M365_PASS w konfiguracji funkcji.");
  return nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false, // STARTTLS — podniesienie szyfrowania po EHLO
    auth: { user, pass },
    pool: true,
    maxConnections: 1,
    tls: { minVersion: "TLSv1.2" },
  });
}

const odp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });

// ============================================================================

Deno.serve(async (req) => {
  let smtp: any = null;
  let wydanie: number | null = null;
  let supa: any = null;

  try {
    const url = new URL(req.url);
    const wymuszony = url.searchParams.get("pelny") === "1"; // wyślij mimo identycznego hasha
    const sucho = url.searchParams.get("sucho") === "1";     // policz, nie wysyłaj, nie zapisuj

    const odbiorca = (Deno.env.get("KARTOTEKA_SYNC_ODBIORCA") ?? "").trim();
    if (!odbiorca) throw new Error("Brak zmiennej KARTOTEKA_SYNC_ODBIORCA — nie ma dokąd wysłać eksportu.");

    const cronPelny = (Deno.env.get("KARTOTEKA_SYNC_PELNY_CRON") ?? "").trim();
    const cronZwykly = (Deno.env.get("KARTOTEKA_SYNC_CRON") ?? "").trim();

    const teraz = new Date();
    const ostrzezenia: string[] = [];
    if (!cronPelny) {
      ostrzezenia.push(
        "KARTOTEKA_SYNC_PELNY_CRON nie jest ustawiony — żaden przebieg nie jest bezwarunkowy " +
        "(brak domknięcia tygodnia). Ustaw zmienną albo wywołaj funkcję z ?pelny=1.",
      );
    }
    const przebiegPelny = wymuszony || (cronPelny ? czyPrzebiegPelny(cronPelny, teraz) : false);

    supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Eksport — JEDNO zapytanie, w całości po stronie bazy (kartoteka_sync.sql).
    const { data: dane, error: eEksport } = await supa.rpc("kartoteka_eksport");
    if (eEksport) throw eEksport;

    const tekst = JSON.stringify(dane);
    const hash = await sha256hex(tekst);
    const rozmiar = bajty(tekst);

    // 2. Ostatnie UDANE wydanie — tylko z nim porównujemy hash. Wydanie, którego
    //    wysyłka się nie powiodła (blad is not null), nie może blokować ponowienia.
    const { data: ostatnie, error: eOstatnie } = await supa
      .from("sync_wydania")
      .select("numer, hash")
      .is("blad", null)
      .order("numer", { ascending: false })
      .limit(1);
    if (eOstatnie) throw eOstatnie;
    const poprzednie = ostatnie?.[0] ?? null;

    const bezZmian = !!poprzednie && poprzednie.hash === hash;

    // Przebieg próbny idzie PRZED sprawdzeniem hasha: „na sucho" ma zawsze podać
    // komplet wyliczeń (rozmiar, liczba części), a najczęściej pyta się o nie
    // właśnie wtedy, gdy nic się nie zmieniło — przy niezmienionym hashu skrót
    // niżej odpowiedziałby „nic się nie zmieniło" i liczby części by nie było.
    if (sucho) {
      return odp({
        ok: true, wyslano: false, powod: "przebieg próbny (?sucho=1) — bez maila i bez wpisu w sync_wydania",
        hash, rozmiar_b: rozmiar, czesci: podzielNaCzesci(dane, LIMIT_CZESCI).length,
        bez_zmian: bezZmian, przebieg_pelny: przebiegPelny,
        ostatnie_wydanie: poprzednie?.numer ?? null, cron: cronZwykly || null, ostrzezenia,
      });
    }

    if (bezZmian && !przebiegPelny) {
      return odp({
        ok: true, wyslano: false, powod: "hash identyczny z ostatnim wydaniem — nic się nie zmieniło",
        hash, rozmiar_b: rozmiar, ostatnie_wydanie: poprzednie.numer, cron: cronZwykly || null, ostrzezenia,
      });
    }

    const czesci = podzielNaCzesci(dane, LIMIT_CZESCI);

    // 3. Rezerwacja numeru wydania. Wiersz powstaje PRZED wysyłką, żeby numer w
    //    temacie i znacznik `wygenerowano` miały jedno źródło (bazę), a nieudana
    //    próba zostawiła ślad. Błąd wysyłki dopisujemy do kolumny `blad`.
    const { data: wpis, error: eWpis } = await supa
      .from("sync_wydania")
      .insert({ hash, payload: dane, wyslano_do: odbiorca })
      .select("numer, wygenerowano")
      .single();
    if (eWpis) throw eWpis;

    wydanie = wpis.numer as number;
    const wygenerowano = new Date(wpis.wygenerowano);
    const stempel = fmtWarszawa(wygenerowano);           // temat: czas polski
    const wygenerowanoISO = wygenerowano.toISOString();  // koperta: UTC

    // 4. Maile. Temat identyczny dla wszystkich części jednego wydania —
    //    części rozróżnia pole `czesc` w kopercie.
    const temat = `[RAPORTY-SYNC] ${stempel} · wydanie ${wydanie}`;
    const liczba = (k: string) => Array.isArray((dane as any)?.[k]) ? (dane as any)[k].length : "—";
    const liczbaInwestycji = liczba("projekty");
    const liczbaRaportow = liczba("raporty");

    smtp = polaczSMTP();
    const wyslane: { czesc: number; bajtow: number }[] = [];

    for (let i = 0; i < czesci.length; i++) {
      const koperta = {
        wydanie,
        wygenerowano: wygenerowanoISO,
        czesc: { nr: i + 1, z: czesci.length },
        dane: czesci[i],
      };
      const json = JSON.stringify(koperta);
      // text/plain, NIE HTML — encje psują JSON.
      const tresc =
        `Wydanie ${wydanie} · ${stempel} · część ${i + 1}/${czesci.length}\n` +
        `Inwestycje: ${liczbaInwestycji} · raporty: ${liczbaRaportow} · payload ${Math.round(bajty(json) / 1024)} kB\n` +
        `\n` +
        "```json\n" + json + "\n```\n";

      await smtp.sendMail({ from: odbiorca, to: odbiorca, subject: temat, text: tresc });
      wyslane.push({ czesc: i + 1, bajtow: bajty(json) });
    }

    return odp({
      ok: true, wyslano: true, wydanie, wygenerowano: wygenerowanoISO, temat,
      odbiorca, hash, rozmiar_b: rozmiar, czesci: wyslane,
      przebieg_pelny: przebiegPelny, bez_zmian: bezZmian,
      powod: przebiegPelny && bezZmian ? "przebieg bezwarunkowy (domknięcie tygodnia)" : "payload różny od ostatniego wydania",
      ostrzezenia,
    });
  } catch (err) {
    // Wydanie zarezerwowane, ale wysyłka padła — zapisz powód. Dzięki temu
    // porównanie hasha (blad is null) pominie ten wiersz i kolejny przebieg
    // spróbuje jeszcze raz.
    if (wydanie !== null && supa) {
      try { await supa.from("sync_wydania").update({ blad: String(err) }).eq("numer", wydanie); } catch { /* ignore */ }
    }
    return odp({ ok: false, wydanie, blad: String(err) }, 500);
  } finally {
    try { smtp?.close(); } catch { /* ignore */ }
  }
});
