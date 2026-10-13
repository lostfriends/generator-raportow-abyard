// ============================================================================
//  ABYARD — Edge Function: asystent AI (Claude API)
//
//  Jedyne miejsce, w którym aplikacja rozmawia z Claude API. Klucz API siedzi
//  w sekretach Supabase (ANTHROPIC_API_KEY) i NIGDY nie trafia do przeglądarki —
//  front-end woła tę funkcję przez supabase.functions.invoke z sesją użytkownika.
//
//  Tryby (pole `tryb` w treści żądania):
//   - "portfel"  — analiza portfela inwestycji dla kierownictwa. TYLKO admin.
//                  Najwyżej raz na dzień (czas PL) — pilnuje tego unikalny indeks
//                  w tabeli analizy_portfela (patrz supabase/asystent_ai.sql).
//                  Analiza całego portfela trwa dłużej, niż Supabase pozwala żyć
//                  Edge Function (limit czasu ubija ją bez śladu), dlatego idzie
//                  przez Message Batches API: funkcja tylko ZLECA zadanie i od razu
//                  kończy, zapisując batch_id w wierszu „w_toku".
//   - "portfel_status" — odbiór wyniku: aplikacja woła ten tryb co kilkanaście
//                  sekund, dopóki analiza jest „w_toku"; gdy batch się zakończy,
//                  funkcja zapisuje wynik (status „gotowa") albo błąd. TYLKO admin.
//   - "kontrola" — kontrola spójności raportu przed zapisem. Każdy zalogowany.
//   - "styl"     — redakcja stylu jednego pola opisowego. Każdy zalogowany.
//
//  Dane wejściowe przygotowuje aplikacja (te same funkcje, które liczą opóźnienia
//  i statusy na ekranie), więc ta funkcja niczego o raportach nie liczy — tylko
//  sprawdza uprawnienia i limity, woła model i zapisuje wynik.
//
//  Sekrety (Supabase → Edge Functions → Secrets, NIE w kodzie):
//   - ANTHROPIC_API_KEY          — klucz z console.anthropic.com
//   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — wstrzykiwane przez Supabase
//
//  Deploy: supabase functions deploy asystent-ai --no-verify-jwt
//  (sesję użytkownika weryfikujemy sami w kodzie — patrz uzytkownikZZadania).
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";

// --- Konfiguracja (do ewentualnej edycji) -----------------------------------
const MODEL = "claude-opus-5-5";
// Limit wywołań „kontrola" + „styl" na osobę w ciągu 24 h — bezpiecznik budżetu.
const LIMIT_DZIENNY_NA_OSOBE = 60;
// Analiza „w_toku" BEZ zleconego batcha starsza niż tyle minut = przerwana.
const PRZETERMINOWANIE_MIN = 15;
// Batch, który nie skończył się w tym czasie, anulujemy (API pozwala do 24 h).
const MAKS_CZAS_BATCHA_GODZ = 6;
// Batch API kosztuje 50% ceny standardowej.
const RABAT_BATCH = 0.5;
// Szacunek kosztu: USD za 1 mln tokenów [wejście, wyjście] (cennik API Anthropic).
const CENNIK: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function odpowiedz(dane: unknown, status = 200) {
  return new Response(JSON.stringify(dane), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

class BladUzytkownika extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

// ----------------------------------------------------------------------------
//  Prompty i schematy odpowiedzi (structured outputs — odpowiedź to zawsze JSON)
// ----------------------------------------------------------------------------
const SYSTEM_WSPOLNY = `Pracujesz dla działu realizacji Abyard Sp. z o.o. (Kraków) — generalnego wykonawcy robót budowlanych. Kierownicy projektów (PM) składają co dwa tygodnie raporty z budów.

Zasady obowiązujące zawsze:
- Opieraj się wyłącznie na przekazanych danych. Nie dopowiadaj faktów, kwot, dat, nazw firm ani osób, których w danych nie ma. Gdy czegoś brakuje, napisz wprost, że brak danych.
- Wskaźniki liczbowe (opóźnienia w dniach, zaawansowanie w %, dni od ostatniego raportu, status zagrożenia terminu) wylicza system — są wiarygodne, nie przeliczaj ich.
- Tekst ujęty w **...** oznacza informacje oznaczone przez PM jako nowe w danym raporcie.
- Pisz po polsku, rzeczowo i zwięźle, bez ogólników i bez języka marketingowego. Najpierw konkluzja, potem szczegóły.`;

const SYSTEM_PORTFEL = `${SYSTEM_WSPOLNY}

Zadanie: przegląd portfela inwestycji w toku dla kierownictwa działu realizacji. Dostajesz dla każdej inwestycji najnowszy raport, poprzedni raport (do porównania) i wskaźniki systemowe.
- "podsumowanie": 3–6 zdań o stanie całego portfela — ile inwestycji wymaga interwencji i dlaczego.
- "inwestycje": każda inwestycja z danych, w kolejności: krytyczne, uwaga, stabilne. Ocena: "krytyczna" — zagrożony termin zakończenia lub problem wymagający interwencji kierownictwa; "uwaga" — sygnały ryzyka albo istotne sprawy otwarte; "stabilna" — brak istotnych ryzyk. "kluczowe" — najważniejsze fakty z raportu (1–3 zdania). "zmiany" — co realnie zmieniło się od poprzedniego raportu (nowe problemy, sprawy rozwiązane, przesunięte terminy); gdy brak poprzedniego raportu albo brak zmian, napisz to.
- "decyzje": sprawy czekające na decyzję lub działanie konkretnej strony (Inwestor, Abyard, podwykonawca, projektant, urząd) — tylko te, które wynikają z treści raportów.
- "jakosc_raportowania": raporty zaległe, puste, przepisane bez zmian z poprzedniego mimo nowego okresu albo wewnętrznie sprzeczne (np. podsumowanie „brak zagrożenia" przy opisanych opóźnieniach). Pusta lista, gdy brak uwag.`;

const SCHEMAT_PORTFEL = {
  type: "object",
  additionalProperties: false,
  required: ["podsumowanie", "inwestycje", "decyzje", "jakosc_raportowania"],
  properties: {
    podsumowanie: { type: "string" },
    inwestycje: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nazwa", "ocena", "kluczowe", "zmiany"],
        properties: {
          nazwa: { type: "string" },
          ocena: { type: "string", enum: ["krytyczna", "uwaga", "stabilna"] },
          kluczowe: { type: "string" },
          zmiany: { type: "string" },
        },
      },
    },
    decyzje: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["inwestycja", "kto", "sprawa"],
        properties: {
          inwestycja: { type: "string" },
          kto: { type: "string" },
          sprawa: { type: "string" },
        },
      },
    },
    jakosc_raportowania: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["inwestycja", "uwaga"],
        properties: {
          inwestycja: { type: "string" },
          uwaga: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_KONTROLA = `${SYSTEM_WSPOLNY}

Zadanie: sprawdź raport z budowy, zanim PM zapisze go w bazie. Wskaż wyłącznie konkretne problemy merytoryczne:
- sprzeczności między polami (np. podsumowanie „nie powoduje zagrożenia" przy opisanych opóźnieniach, opis zaawansowania niezgodny z harmonogramem, daty kluczowe niezgodne z harmonogramem),
- opóźnienia wykazane w harmonogramie, których nie opisano w polu „Opóźnienia" (wymagane: która pozycja, ile dni, termin i sposób nadrobienia),
- treść przepisaną bez zmian z poprzedniego raportu, choć dotyczy nowego okresu (porównaj z poprzednim raportem, jeśli jest w danych),
- puste sekcje, które w tym raporcie powinny mieć treść.
Nie oceniaj stylu i nie proponuj przeredagowań. Najwyżej 8 uwag, od najważniejszych. "waga": "istotna" — błąd merytoryczny lub sprzeczność; "drobna" — brak lub nieścisłość bez wpływu na ocenę budowy. "pole" — nazwa sekcji raportu. "uwaga" — co jest nie tak i co uzupełnić. Gdy brak problemów, zwróć pustą listę "uwagi". "ocena" — jedno zdanie o raporcie jako całości.`;

const SCHEMAT_KONTROLA = {
  type: "object",
  additionalProperties: false,
  required: ["ocena", "uwagi"],
  properties: {
    ocena: { type: "string" },
    uwagi: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["waga", "pole", "uwaga"],
        properties: {
          waga: { type: "string", enum: ["istotna", "drobna"] },
          pole: { type: "string" },
          uwaga: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM_STYL = `${SYSTEM_WSPOLNY}

Zadanie: zredaguj jeden fragment raportu z budowy. Raport trafia do inwestora, więc język ma być formalny, precyzyjny i zwięzły.
- Popraw ortografię, interpunkcję, składnię i styl; usuń powtórzenia i kolokwializmy.
- Nie dodawaj żadnych informacji i nie usuwaj żadnego faktu. Liczby, daty, kwoty, procenty, nazwy firm, osób i pozycji harmonogramu przepisz dokładnie.
- Zachowaj pogrubienie (<b>) na tych samych treściach — oznacza nowe informacje w raporcie. Zachowaj kursywę (<i>) i podkreślenia (<u>).
- Dozwolone znaczniki: <b>, <i>, <u>, <br>. Zachowaj podział na wiersze i punkty wyliczenia.
- Gdy tekst jest już poprawny, zwróć go bez zmian.
"html" — zredagowany fragment. "zmiany" — jedno zdanie, co poprawiono (albo „Bez zmian").`;

const SCHEMAT_STYL = {
  type: "object",
  additionalProperties: false,
  required: ["html", "zmiany"],
  properties: {
    html: { type: "string" },
    zmiany: { type: "string" },
  },
};

// ----------------------------------------------------------------------------
//  Wywołanie Claude API
// ----------------------------------------------------------------------------
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

type WynikModelu = { dane: any; model: string; tokenyWe: number; tokenyWy: number; koszt: number };

function parametryZapytania(
  system: string,
  tresc: string,
  schemat: unknown,
  effort: "low" | "medium" | "high",
  maxTokens: number,
) {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: "json_schema", schema: schemat } },
    messages: [{ role: "user", content: tresc }],
  };
}

async function zapytajClaude(
  system: string,
  tresc: string,
  schemat: unknown,
  effort: "low" | "medium" | "high",
  maxTokens: number,
): Promise<WynikModelu> {
  // `fallbacks: "default"` — gdy filtr bezpieczeństwa modelu odrzuci żądanie,
  // API samo ponawia je na modelu zastępczym (beta server-side-fallback).
  // Parametry beta przekazujemy jako `any`, bo typy SDK nie zawsze je znają.
  const parametry: any = {
    ...parametryZapytania(system, tresc, schemat, effort, maxTokens),
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const odp: any = await anthropic.beta.messages.stream(parametry).finalMessage();
  return odczytajOdpowiedz(odp, 1);
}

// Wspólny odczyt odpowiedzi modelu (zwykłe wywołanie i wynik batcha).
function odczytajOdpowiedz(odp: any, mnoznikCeny: number): WynikModelu {
  if (odp.stop_reason === "refusal") {
    throw new Error("Model odmówił przetworzenia tych danych. Spróbuj ponownie lub skontaktuj się z administratorem.");
  }
  if (odp.stop_reason === "max_tokens") {
    throw new Error("Odpowiedź modelu przekroczyła limit długości.");
  }
  const tekst = (odp.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  let dane: any;
  try {
    dane = JSON.parse(tekst);
  } catch {
    throw new Error("Model zwrócił odpowiedź w nieoczekiwanym formacie.");
  }
  const model = odp.model || MODEL;
  const tokenyWe = (odp.usage?.input_tokens || 0) + (odp.usage?.cache_read_input_tokens || 0) + (odp.usage?.cache_creation_input_tokens || 0);
  const tokenyWy = odp.usage?.output_tokens || 0;
  const [cWe, cWy] = CENNIK[model] || CENNIK[MODEL];
  const koszt = ((tokenyWe * cWe + tokenyWy * cWy) / 1_000_000) * mnoznikCeny;
  return { dane, model, tokenyWe, tokenyWy, koszt };
}

// ----------------------------------------------------------------------------
//  Pomocnicze: klient bazy, użytkownik z żądania, dziennik użycia
// ----------------------------------------------------------------------------
const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function uzytkownikZZadania(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new BladUzytkownika("Brak sesji — zaloguj się ponownie.", 401);
  const { data, error } = await supa.auth.getUser(jwt);
  if (error || !data?.user) throw new BladUzytkownika("Sesja wygasła — zaloguj się ponownie.", 401);
  const { data: profil } = await supa
    .from("uzytkownicy").select("id, email, rola, imie_nazwisko").eq("id", data.user.id).maybeSingle();
  return {
    id: data.user.id,
    admin: profil?.rola === "admin",
    nazwa: profil?.imie_nazwisko?.trim() || profil?.email || data.user.email || "—",
  };
}

async function zapiszUzycie(uzytkownik: string, tryb: string, w: WynikModelu) {
  const { error } = await supa.from("ai_uzycie").insert({
    uzytkownik, tryb, model: w.model, tokeny_we: w.tokenyWe, tokeny_wy: w.tokenyWy,
    koszt_usd: Math.round(w.koszt * 10000) / 10000,
  });
  if (error) console.error("ai_uzycie insert", error);
}

async function sprawdzLimitOsoby(uzytkownik: string) {
  const od = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await supa
    .from("ai_uzycie").select("id", { count: "exact", head: true })
    .eq("uzytkownik", uzytkownik).in("tryb", ["kontrola", "styl"]).gte("utworzono", od);
  if (error) throw error;
  if ((count || 0) >= LIMIT_DZIENNY_NA_OSOBE) {
    throw new BladUzytkownika(`Wykorzystano dzienny limit asystenta AI (${LIMIT_DZIENNY_NA_OSOBE} wywołań na 24 h).`, 429);
  }
}

function wymagajTekstu(v: unknown, nazwa: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new BladUzytkownika(`Brak danych: ${nazwa}.`);
  if (v.length > max) throw new BladUzytkownika(`Za dużo danych w polu ${nazwa}.`);
  return v;
}

// ----------------------------------------------------------------------------
//  Tryby
// ----------------------------------------------------------------------------
async function trybPortfel(u: { id: string; admin: boolean; nazwa: string }, body: any) {
  if (!u.admin) throw new BladUzytkownika("Analiza portfela jest dostępna tylko dla administratorów.", 403);
  const dane = body?.dane;
  if (!dane || !Array.isArray(dane.inwestycje) || dane.inwestycje.length === 0) {
    throw new BladUzytkownika("Brak inwestycji do analizy.");
  }
  const tresc = JSON.stringify(dane);
  if (tresc.length > 2_000_000) throw new BladUzytkownika("Zbyt dużo danych do analizy.");

  await sprzatnijPrzerwane();

  // Rezerwacja dnia: unikalny indeks przepuści tylko jeden wiersz na dzień.
  const { data: wiersz, error } = await supa.from("analizy_portfela")
    .insert({ status: "w_toku", utworzyl: u.id, utworzyl_nazwa: u.nazwa, liczba_inwestycji: dane.inwestycje.length })
    .select("id").single();
  if (error) {
    if ((error as any).code === "23505") {
      throw new BladUzytkownika("Dzisiejsza analiza już istnieje lub właśnie się generuje. Kolejną można wygenerować jutro (albo po resecie w panelu admina).", 409);
    }
    throw error;
  }

  // Zlecenie batcha trwa sekundę — długie liczenie odbywa się po stronie Anthropic.
  // (Batches API nie przyjmuje parametru `fallbacks` — odmowę obsługuje odczyt wyniku.)
  try {
    const batch = await anthropic.messages.batches.create({
      requests: [{
        custom_id: wiersz.id,
        params: parametryZapytania(SYSTEM_PORTFEL, `Dane portfela (JSON):\n${tresc}`, SCHEMAT_PORTFEL, "medium", 32000) as any,
      }],
    });
    const { error: e2 } = await supa.from("analizy_portfela").update({ batch_id: batch.id }).eq("id", wiersz.id);
    if (e2) throw e2;
  } catch (err) {
    await oznaczBlad(wiersz.id, `Nie udało się zlecić analizy: ${String((err as Error)?.message || err)}`);
    throw err;
  }
  return { ok: true, id: wiersz.id, status: "w_toku" };
}

async function oznaczBlad(id: string, blad: string) {
  await supa.from("analizy_portfela")
    .update({ status: "blad", uniewazniona: true, blad: blad.slice(0, 500), zakonczono: new Date().toISOString() })
    .eq("id", id);
}

// Zwalnia blokadę dnia po generowaniach, które utknęły: bez batcha po 15 min
// (zlecenie się nie udało / stara wersja funkcji), z batchem po MAKS_CZAS_BATCHA_GODZ.
async function sprzatnijPrzerwane() {
  const teraz = Date.now();
  const granicaBez = new Date(teraz - PRZETERMINOWANIE_MIN * 60 * 1000).toISOString();
  await supa.from("analizy_portfela")
    .update({ status: "blad", uniewazniona: true, blad: "Generowanie przerwane (przekroczony czas).", zakonczono: new Date().toISOString() })
    .eq("status", "w_toku").is("batch_id", null).lt("utworzono", granicaBez);
}

// Odbiór wyników zleconych batchy. Idempotentne — może wołać kilku adminów naraz.
async function trybPortfelStatus(u: { admin: boolean }) {
  if (!u.admin) throw new BladUzytkownika("Analiza portfela jest dostępna tylko dla administratorów.", 403);
  await sprzatnijPrzerwane();
  const { data: wiersze, error } = await supa.from("analizy_portfela")
    .select("id, batch_id, utworzono, utworzyl")
    .eq("status", "w_toku").not("batch_id", "is", null)
    .order("utworzono", { ascending: false }).limit(5);
  if (error) throw error;

  const statusy: Record<string, string> = {};
  for (const w of wiersze || []) {
    const batch = await anthropic.messages.batches.retrieve(w.batch_id);
    if (batch.processing_status !== "ended") {
      const wiek = Date.now() - new Date(w.utworzono).getTime();
      if (wiek > MAKS_CZAS_BATCHA_GODZ * 3600 * 1000) {
        await anthropic.messages.batches.cancel(w.batch_id).catch(() => {});
        await oznaczBlad(w.id, `Analiza nie zakończyła się w ${MAKS_CZAS_BATCHA_GODZ} h — anulowano.`);
        statusy[w.id] = "blad";
      } else {
        statusy[w.id] = "w_toku";
      }
      continue;
    }
    let zapisano = false;
    for await (const r of await anthropic.messages.batches.results(w.batch_id)) {
      if (r.custom_id !== w.id) continue;
      zapisano = true;
      if (r.result.type !== "succeeded") {
        const opis = r.result.type === "errored" ? `błąd API: ${JSON.stringify((r.result as any).error?.error?.message || (r.result as any).error || "")}` : r.result.type;
        await oznaczBlad(w.id, `Analiza nie powiodła się (${opis}).`);
        statusy[w.id] = "blad";
        continue;
      }
      try {
        const wynik = odczytajOdpowiedz(r.result.message, RABAT_BATCH);
        // Warunek status = w_toku: drugi równoległy odbiór nie zapisze wyniku dwa razy.
        const { data: zm, error: e2 } = await supa.from("analizy_portfela")
          .update({ status: "gotowa", tresc: wynik.dane, model: wynik.model, zakonczono: new Date().toISOString() })
          .eq("id", w.id).eq("status", "w_toku").select("id");
        if (e2) throw e2;
        if (zm && zm.length > 0 && w.utworzyl) await zapiszUzycie(w.utworzyl, "portfel", wynik);
        statusy[w.id] = "gotowa";
      } catch (err) {
        await oznaczBlad(w.id, String((err as Error)?.message || err));
        statusy[w.id] = "blad";
      }
    }
    if (!zapisano) {
      await oznaczBlad(w.id, "Brak wyniku w zakończonym zadaniu.");
      statusy[w.id] = "blad";
    }
  }
  return { ok: true, statusy };
}

async function trybKontrola(u: { id: string }, body: any) {
  await sprawdzLimitOsoby(u.id);
  const raport = body?.raport;
  if (!raport || typeof raport !== "object") throw new BladUzytkownika("Brak danych raportu.");
  const tresc = JSON.stringify(raport);
  if (tresc.length > 400_000) throw new BladUzytkownika("Raport jest zbyt obszerny do kontroli.");
  const w = await zapytajClaude(SYSTEM_KONTROLA, `Raport do sprawdzenia (JSON):\n${tresc}`, SCHEMAT_KONTROLA, "medium", 16000);
  await zapiszUzycie(u.id, "kontrola", w);
  return { ok: true, wynik: w.dane };
}

async function trybStyl(u: { id: string }, body: any) {
  await sprawdzLimitOsoby(u.id);
  const pole = wymagajTekstu(body?.pole, "nazwa pola", 200);
  const html = wymagajTekstu(body?.html, "treść", 60_000);
  const w = await zapytajClaude(
    SYSTEM_STYL,
    `Sekcja raportu: ${pole}\n\nFragment do redakcji (HTML):\n${html}`,
    SCHEMAT_STYL,
    "low",
    16000,
  );
  await zapiszUzycie(u.id, "styl", w);
  return { ok: true, wynik: w.dane };
}

// ----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return odpowiedz({ blad: "Dozwolona jest tylko metoda POST." }, 405);
  try {
    if (!Deno.env.get("ANTHROPIC_API_KEY")) {
      throw new BladUzytkownika("Asystent AI nie jest skonfigurowany (brak klucza API).", 503);
    }
    const u = await uzytkownikZZadania(req);
    const body = await req.json().catch(() => null);
    switch (body?.tryb) {
      case "portfel": return odpowiedz(await trybPortfel(u, body));
      case "portfel_status": return odpowiedz(await trybPortfelStatus(u));
      case "kontrola": return odpowiedz(await trybKontrola(u, body));
      case "styl": return odpowiedz(await trybStyl(u, body));
      default: throw new BladUzytkownika("Nieznany tryb asystenta.");
    }
  } catch (err) {
    if (err instanceof BladUzytkownika) return odpowiedz({ blad: err.message }, err.status);
    if (err instanceof Anthropic.RateLimitError) return odpowiedz({ blad: "Asystent AI jest chwilowo przeciążony — spróbuj za minutę." }, 429);
    if (err instanceof Anthropic.APIError) {
      console.error("Claude API", err.status, err.message);
      return odpowiedz({ blad: `Błąd usługi AI (${err.status ?? "?"}). Spróbuj ponownie później.` }, 502);
    }
    console.error(err);
    return odpowiedz({ blad: (err as Error)?.message || "Nieznany błąd asystenta AI." }, 500);
  }
});
