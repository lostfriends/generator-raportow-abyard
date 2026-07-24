// ============================================================================
//  ABYARD — Edge Function: przypomnienia o raportach z budowy
//
//  Co robi:
//   1. Budzi się codziennie (cron o 8:00 czasu PL — patrz instrukcja).
//   2. Sprawdza, czy DZIŚ jest "dzień raportowy": piątek w cyklu co 2 tygodnie
//      liczonym od 2026-07-10. Jeśli nie — kończy bez wysyłki.
//   3. Pobiera z bazy aktywne przypisania (PM -> inwestycje).
//   4. Wysyła przez Brevo:
//        - do każdego PM z >=1 tematem: lista jego inwestycji,
//        - do adminów z listy ADMIN_PELNA_LISTA: pełna lista pogrupowana po PM.
//
//  Inwestycje wstrzymane (projekty.wstrzymana = true) POZOSTAJĄ na liście
//  (nadal można raportować), ale w treści maila ich nazwa dostaje dopisek
//  " - wstrzymana", żeby PM/admin od razu je odróżnił.
//
//  Sekrety (ustawiane w Supabase, NIE w kodzie):
//   - BREVO_API_KEY        — klucz API z Brevo (xkeysib-...)
//   - SUPABASE_URL         — URL projektu (Supabase wstrzykuje automatycznie)
//   - SUPABASE_SERVICE_ROLE_KEY — klucz service_role (Supabase wstrzykuje automat.)
//
//  Uwaga: service_role omija RLS — dlatego funkcja widzi wszystkie dane.
//         Ten klucz NIGDY nie może trafić do aplikacji front-end.
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

// --- Konfiguracja (do ewentualnej edycji) -----------------------------------
const DATA_STARTU = "2026-07-10";              // pierwszy piątek raportowy
const NADAWCA_EMAIL = "oferty@abyard.pl";   // zweryfikowany nadawca w Brevo
const NADAWCA_NAZWA = "Generator raportów Abyard";
const LINK_APLIKACJI = "https://generator-raportow-abyard.netlify.app";
const ADMIN_PELNA_LISTA = ["ddziedzic@abyard.pl", "kdarul@urba.pl"]; // pełna lista
const TEST_EMAIL = "ddziedzic@abyard.pl"; // w trybie ?test=1 WSZYSTKIE maile idą tylko tutaj

// Czy podana data (UTC) to dzień raportowy: piątek w cyklu co 14 dni od DATA_STARTU.
function czyDzienRaportowy(dzis: Date): boolean {
  const start = new Date(DATA_STARTU + "T00:00:00Z");
  // różnica w pełnych dniach
  const msDzien = 86400000;
  const roznicaDni = Math.round((Date.UTC(dzis.getUTCFullYear(), dzis.getUTCMonth(), dzis.getUTCDate()) - start.getTime()) / msDzien);
  if (roznicaDni < 0) return false;
  return roznicaDni % 14 === 0; // co 2 tygodnie od startu (start jest piątkiem)
}

// Wysyłka pojedynczego maila przez Brevo API.
async function wyslijMail(apiKey: string, doEmail: string, doNazwa: string, temat: string, html: string) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      sender: { email: NADAWCA_EMAIL, name: NADAWCA_NAZWA },
      to: [{ email: doEmail, name: doNazwa || doEmail }],
      subject: temat,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const tekst = await res.text();
    throw new Error(`Brevo ${res.status}: ${tekst}`);
  }
  return await res.json();
}

// Szablon HTML — mail do PM (lista jego inwestycji).
function mailPM(imie: string, inwestycje: string[], dataPiatek: string): string {
  const pozycje = inwestycje.map((n) => `<li style="margin:4px 0">${escapeHtml(n)}</li>`).join("");
  return `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.6;max-width:560px">
    <p>Cześć ${escapeHtml(imie)},</p>
    <p>przypominamy o przygotowaniu raportu z budowy zgodnie z Procedurą nr 03.
       Aktualnie masz przypisane następujące inwestycje:</p>
    <ul style="padding-left:20px">${pozycje}</ul>
    <p>Raporty przygotujesz w generatorze:<br>
       <a href="${LINK_APLIKACJI}" style="color:#1668C7">${LINK_APLIKACJI}</a></p>
    <p style="color:#6B6B6B;margin-top:24px">Pozdrawiamy,<br>${NADAWCA_NAZWA}</p>
  </div>`;
}

// Szablon HTML — mail do admina (pełna lista pogrupowana po PM).
function mailAdmin(grupy: { osoba: string; inwestycje: string[] }[], dataPiatek: string): string {
  const bloki = grupy.map((g) => `
    <div style="margin-bottom:14px">
      <div style="font-weight:700">${escapeHtml(g.osoba)}</div>
      <ul style="padding-left:20px;margin:4px 0">
        ${g.inwestycje.map((n) => `<li style="margin:2px 0">${escapeHtml(n)}</li>`).join("")}
      </ul>
    </div>`).join("");
  return `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.6;max-width:560px">
    <p>Zestawienie przypisań kierowników na dzień raportowy ${escapeHtml(dataPiatek)} (Procedura nr 03):</p>
    ${bloki}
    <p>Aplikacja: <a href="${LINK_APLIKACJI}" style="color:#1668C7">${LINK_APLIKACJI}</a></p>
    <p style="color:#6B6B6B;margin-top:24px">${NADAWCA_NAZWA}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDataPL(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

Deno.serve(async (req) => {
  try {
    const teraz = new Date();

    // Pozwól na ręczne wywołanie testowe z parametrem ?test=1 (pomija sprawdzenie daty)
    const url = new URL(req.url);
    const test = url.searchParams.get("test") === "1";

    if (!test && !czyDzienRaportowy(teraz)) {
      return new Response(JSON.stringify({ ok: true, info: "Dziś nie jest dzień raportowy — pomijam." }), {
        headers: { "content-type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("BREVO_API_KEY");
    if (!apiKey) throw new Error("Brak BREVO_API_KEY w sekretach funkcji.");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Pobierz aktywne inwestycje (nazwa + id + flaga wstrzymania)
    const { data: projekty, error: e1 } = await supa
      .from("projekty").select("id, nazwa, wstrzymana").eq("aktywny", true);
    if (e1) throw e1;
    // Nazwa do wyświetlenia w mailu; wstrzymane dostają dopisek " - wstrzymana".
    const projMap: Record<string, string> = {};
    (projekty || []).forEach((p: any) => { projMap[p.id] = p.wstrzymana ? `${p.nazwa} - wstrzymana` : p.nazwa; });

    // Pobierz przypisania + użytkowników
    const { data: przyp, error: e2 } = await supa
      .from("przypisania").select("uzytkownik, projekt_id");
    if (e2) throw e2;
    const { data: uzyt, error: e3 } = await supa
      .from("uzytkownicy").select("id, email, rola, imie_nazwisko");
    if (e3) throw e3;

    const uzytMap: Record<string, any> = {};
    (uzyt || []).forEach((u: any) => { uzytMap[u.id] = u; });

    // Zbuduj mapę: uzytkownikId -> [nazwy aktywnych inwestycji]
    const tematyPM: Record<string, string[]> = {};
    (przyp || []).forEach((p: any) => {
      const nazwa = projMap[p.projekt_id];
      if (!nazwa) return; // inwestycja nieaktywna
      (tematyPM[p.uzytkownik] ||= []).push(nazwa);
    });

    const nazwaOsoby = (u: any) => (u?.imie_nazwisko?.trim()) || u?.email || "—";
    const wyniki: any[] = [];
    const dataPiatek = fmtDataPL(teraz);

    // 1) Maile do PM z tematami (pomijamy adminów z pełnej listy — oni dostaną osobny)
    for (const [uid, inwestycje] of Object.entries(tematyPM)) {
      const u = uzytMap[uid];
      if (!u || !u.email) continue;
      if (ADMIN_PELNA_LISTA.includes(u.email)) continue; // admin dostaje pełną listę osobno
      const imie = (u.imie_nazwisko?.trim()?.split(" ")[0]) || "";
      const odbiorca = test ? TEST_EMAIL : u.email;
      try {
        await wyslijMail(apiKey, odbiorca, nazwaOsoby(u), `Przypomnienie: raport z budowy — ${dataPiatek}`, mailPM(imie, inwestycje, dataPiatek));
        wyniki.push({ email: u.email, wyslano_na: odbiorca, status: "wysłano", tematów: inwestycje.length });
      } catch (err) {
        wyniki.push({ email: u.email, status: "błąd", blad: String(err) });
      }
    }

    // 2) Pełna lista pogrupowana po PM — do adminów z ADMIN_PELNA_LISTA
    const grupy = Object.entries(tematyPM)
      .map(([uid, inwestycje]) => ({ osoba: nazwaOsoby(uzytMap[uid]), inwestycje }))
      .filter((g) => g.inwestycje.length > 0)
      .sort((a, b) => a.osoba.localeCompare(b.osoba, "pl"));

    // 2) Pełna lista pogrupowana po PM — do adminów z ADMIN_PELNA_LISTA.
    //    W trybie testowym wysyłamy ją tylko raz, na TEST_EMAIL.
    const odbiorcyAdmin = test ? [TEST_EMAIL] : ADMIN_PELNA_LISTA;
    for (const adminEmail of odbiorcyAdmin) {
      const u = (uzyt || []).find((x: any) => x.email === adminEmail);
      const nazwa = u ? nazwaOsoby(u) : adminEmail;
      try {
        await wyslijMail(apiKey, adminEmail, nazwa, `Zestawienie przypisań — raporty ${dataPiatek}`, mailAdmin(grupy, dataPiatek));
        wyniki.push({ email: adminEmail, status: "wysłano (pełna lista)" });
      } catch (err) {
        wyniki.push({ email: adminEmail, status: "błąd", blad: String(err) });
      }
    }

    return new Response(JSON.stringify({ ok: true, dzien: dataPiatek, test, wyniki }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, blad: String(err) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
});
