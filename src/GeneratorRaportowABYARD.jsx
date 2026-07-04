import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  listaAktywnychProjektow,
  idProjektuPoNazwie,
  pobierzKolejnyNumer,
  pobierzOstatniRaport,
  wgrajZdjecia,
  wgrajPojedynczyObraz,
  zapiszRaport,
  aktualizujRaport,
  mapWierszNaForm,
  listaWszystkichRaportow,
  pobierzRaportPoId,
  usunRaport,
  przegladBudow,
  // auth + role:
  zaloguj,
  zarejestruj,
  wyloguj,
  resetHasla,
  biezacaSesja,
  naZmianeAuth,
  mojProfil,
  listaUzytkownikow,
  listaPrzypisan,
  dodajPrzypisanie,
  usunPrzypisanie,
  ustawRole,
  dodajProjekt,
  ustawAktywnoscProjektu,
  projektyDoWyboru,
  bezpiecznyKlucz,
  nazwaOsoby,
  listaZakresow,
  ustawKoordynacjeProjektu,
  ustawPunktyPrzypisania,
  ustawDanePM,
  listaNieaktywnychProjektow,
  terminyZHarmonogramu,
  // udostępnianie raportów linkiem:
  utworzUdostepnienie,
  listaUdostepnien,
  wylaczUdostepnienie,
  raportPoTokenie,
} from "./supabase";

/* ============================================================================
   GENERATOR RAPORTÓW Z BUDOWY — ABYARD
   ----------------------------------------------------------------------------
   - Wprowadzanie danych raportu (sekcje 1:1 z Procedurą nr 03)
   - Dodawanie zdjęć (dowolna liczba, w PDF jedno pod drugim na całą szerokość)
   - Generowanie raportu jako PDF
   - Archiwizacja DWUTOROWA:
       (A) plik danych .json do pobrania -> PM wrzuca na SharePoint (źródło prawdy)
       (B) pamięć przeglądarki -> automatyczny szkic na co dzień
   - "Wczytaj poprzedni raport": z pliku .json LUB z pamięci przeglądarki
       -> wszystkie pola wypełnione danymi poprzedniego raportu, do podmiany
   - Auto-numer (poprzedni + 1) i auto-okres (od daty poprzedniego raportu do dziś)

   Marka: żółty FBC707 + czerń 1A1A1A (kolory wyciągnięte z prezentacji Abyard)
   ============================================================================ */

// ---- Lista projektów: wolne pole tekstowe + podpowiedzi z wcześniej użytych --
// (nazwy budów pamiętane są automatycznie po pierwszym raporcie)

// ---- Stałe 15 zadań ZZK (firmowy standard) ----------------------------------
const ZADANIA_ZZK = [
  "Roboty ziemne i przygotowawcze",
  "Konstrukcja budynku — stan zero",
  "Konstrukcja budynku — stan ponad zero",
  "Pokrycie dachu budynku",
  "Okna i drzwi zewnętrzne",
  "Elewacja i balustrady zewnętrzne",
  "Wylewki",
  "Tynki wewnętrzne — szpachlowanie ścian działowych",
  "Windy",
  "Instalacja elektryczna i odgromowa — budynek",
  "Instalacje sanitarne, wentylacji",
  "Przyłącza i sieci: teletechniczne, wodociągowe, kanalizacji sanitarnej oraz deszczowej",
  "Roboty wykończeniowe wewnętrzne",
  "Zagospodarowanie terenu — infrastruktura główna",
  "Zagospodarowanie terenu — tereny przy budynkach",
];

function pustyHarmonogram() {
  return ZADANIA_ZZK.map((z) => ({ zadanie: z, start: "", koniec: "", rzecz: "", proc: "" }));
}

// Opóźnienie:
//  - jeśli podano datę rzeczywistego zakończenia (rzecz):
//       opóźnienie = rzecz - koniec (planowane); 0 jeśli rzecz <= koniec
//  - jeśli brak daty rzeczywistej:
//       proc=100 -> 0 (gotowe, choć bez daty rzecz.)
//       dziś <= koniec -> 0 (w terminie)
//       dziś > koniec i proc<100 -> dni od planowanego terminu do dziś
// Opóźnienie zadania (string "X dni" albo ""). Zasady:
//  - 100% (gotowe): jeśli jest data faktyczna -> faktyczna - umowa; inaczej brak.
//  - < 100% z prognozą: większa z (prognoza - umowa) oraz (dziś - prognoza).
//      czyli opóźnienie, gdy planujemy skończyć po terminie LUB prognoza już minęła.
//  - < 100% bez prognozy: dziś - umowa (gdy termin minął).
//  - wynik <= 0 -> brak (pusto).
function obliczOpoznienie(wiersz, dataOdniesienia) {
  if (!wiersz.koniec) return "";
  const koniec = new Date(wiersz.koniec + "T00:00:00");
  const proc = parseInt(wiersz.proc, 10);
  const ref = new Date(((dataOdniesienia || dzisISO())) + "T00:00:00");
  const naDni = (ms) => Math.round(ms / 86400000);

  if (proc === 100) {
    if (wiersz.rzecz) {
      const d = naDni(new Date(wiersz.rzecz + "T00:00:00") - koniec);
      return d > 0 ? `${d} dni` : "";
    }
    return "";
  }

  // zadanie w toku (< 100%)
  if (wiersz.rzecz) {
    const rzecz = new Date(wiersz.rzecz + "T00:00:00");
    const wzgledemUmowy = naDni(rzecz - koniec);        // planujemy skończyć po terminie?
    const poTerminie = naDni(ref - rzecz);              // prognoza już minęła (na dzień raportu)?
    const d = Math.max(wzgledemUmowy, poTerminie);
    return d > 0 ? `${d} dni` : "";
  }

  // brak prognozy — względem umowy / daty raportu
  const d = naDni(ref - koniec);
  return d > 0 ? `${d} dni` : "";
}

// Czy zadanie wymaga uzupełnienia prognozy: w toku (<100%) i termin (prognoza lub
// umowa, gdy prognoza pusta) już minął względem daty raportu. Te wiersze dostają
// czerwony sygnał i blokują zapis raportu.
function wymagaUzupelnienia(wiersz, dataOdniesienia) {
  const proc = parseInt(wiersz.proc, 10);
  if (proc === 100) return false;
  const termin = wiersz.rzecz || wiersz.koniec;
  if (!termin) return false;
  const ref = new Date(((dataOdniesienia || dzisISO())) + "T00:00:00");
  return new Date(termin + "T00:00:00") < ref;
}

// Opóźnienie pojedynczej pozycji jako liczba dni (0 gdy brak/nieobliczalne) — do agregacji
function opoznienieDni(wiersz, dataOdniesienia) {
  const s = obliczOpoznienie(wiersz, dataOdniesienia);
  const m = /^(\d+)/.exec(s || "");
  return m ? parseInt(m[1], 10) : 0;
}

// Największe opóźnienie spośród pozycji harmonogramu (w dniach); null gdy brak danych
function maxOpoznienieHarmonogramu(harmonogram) {
  if (!Array.isArray(harmonogram) || harmonogram.length === 0) return null;
  let max = 0, byloCokolwiek = false;
  for (const w of harmonogram) {
    const ef = efektywnyWiersz(w);
    if (ef.koniec) byloCokolwiek = true;
    const d = opoznienieDni(ef);
    if (d > max) max = d;
  }
  return byloCokolwiek ? max : null;
}

// Najpóźniejsza PLANOWANA data zakończenia z harmonogramu (kolumna "Zakończenie",
// nie rzeczywiste); uwzględnia podpozycje. Zwraca "YYYY-MM-DD" albo "" gdy brak.
function najpozniejszePlanowaneZakonczenie(harmonogram) {
  if (!Array.isArray(harmonogram) || harmonogram.length === 0) return "";
  const konce = [];
  for (const w of harmonogram) {
    const ef = efektywnyWiersz(w);
    if (ef.koniec) konce.push(ef.koniec);
  }
  if (konce.length === 0) return "";
  return konce.sort()[konce.length - 1];
}

// Opóźnienie CAŁEJ inwestycji (w dniach):
//  - planowany koniec = najpóźniejsza planowana data zakończenia ze wszystkich pozycji
//  - gdy są rzeczywiste zakończenia: najpóźniejsze rzeczywiste − najpóźniejsze planowane
//  - gdy inwestycja trwa (brak rzecz.): dziś − planowany koniec (jeśli już minął)
// Zwraca { dni, wToku } albo null gdy brak danych. dni <= 0 => brak opóźnienia.
function opoznienieInwestycji(harmonogram, dataOdniesienia) {
  if (!Array.isArray(harmonogram) || harmonogram.length === 0) return null;
  const planKonce = [], rzeczKonce = [];
  for (const w of harmonogram) {
    const ef = efektywnyWiersz(w);
    if (ef.koniec) planKonce.push(ef.koniec);
    if (ef.rzecz) rzeczKonce.push(ef.rzecz);
  }
  if (planKonce.length === 0) return null;
  const najpPlan = planKonce.sort()[planKonce.length - 1]; // najpóźniejsza planowana
  const dni = (a, b) => Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);

  // Czy wszystko zakończone? (każda pozycja z planowanym końcem ma też rzeczywisty)
  const wszystkoZakonczone = harmonogram.every((w) => {
    const ef = efektywnyWiersz(w);
    return !ef.koniec || ef.rzecz;
  });

  if (rzeczKonce.length > 0 && wszystkoZakonczone) {
    const najpRzecz = rzeczKonce.sort()[rzeczKonce.length - 1];
    return { dni: dni(najpRzecz, najpPlan), wToku: false };
  }
  // Inwestycja w toku — szacunek względem daty raportu (fallback: dziś)
  const ref = dataOdniesienia || new Date().toISOString().slice(0, 10);
  return { dni: dni(ref, najpPlan), wToku: true };
}

// Średni postęp % z pozycji, które mają wpisany procent; null gdy żadna nie ma
function sredniPostep(harmonogram) {
  if (!Array.isArray(harmonogram)) return null;
  const wartosci = harmonogram
    .map((w) => efektywnyWiersz(w))
    .map((w) => parseInt(w.proc, 10))
    .filter((n) => !isNaN(n));
  if (wartosci.length === 0) return null;
  return Math.round(wartosci.reduce((a, b) => a + b, 0) / wartosci.length);
}

/* ---------------------------------------------------------------------------
   PODPOZYCJE HARMONOGRAMU (opcjonalne, jak zadania sumaryczne w MS Project)
   Wiersz główny może mieć tablicę `pod` z podpozycjami.
   Gdy ma podpozycje — jego daty, % i opóźnienie liczą się z nich.
--------------------------------------------------------------------------- */

// Czas trwania pozycji w dniach (do ważenia %); min 1 gdy brak/zła data
function czasTrwaniaDni(w) {
  if (!w.start || !w.koniec) return 1;
  const s = new Date(w.start + "T00:00:00");
  const k = new Date(w.koniec + "T00:00:00");
  const d = Math.round((k - s) / 86400000) + 1;
  return d > 0 ? d : 1;
}

// Zwraca efektywne wartości wiersza: jeśli ma podpozycje — wyliczone z nich,
// w przeciwnym razie własne pola wiersza (pełna zgodność ze starym formatem).
function efektywnyWiersz(w) {
  const pod = Array.isArray(w.pod) ? w.pod.filter((p) => p && (p.zadanie || p.start || p.koniec || p.rzecz || p.proc)) : [];
  if (pod.length === 0) {
    return { zadanie: w.zadanie, start: w.start || "", koniec: w.koniec || "", rzecz: w.rzecz || "", proc: w.proc, _sumaryczny: false };
  }
  // start = najwcześniejszy, koniec = najpóźniejszy
  const starty = pod.map((p) => p.start).filter(Boolean).sort();
  const konce = pod.map((p) => p.koniec).filter(Boolean).sort();
  // zak. rzeczywiste główne = najpóźniejsze, ale tylko gdy WSZYSTKIE podpozycje je mają
  const rzeczy = pod.map((p) => p.rzecz).filter(Boolean);
  const wszystkieZakonczone = rzeczy.length === pod.length && pod.length > 0;
  // % ważony czasem trwania podpozycji
  let sumaWag = 0, sumaWazona = 0;
  for (const p of pod) {
    const proc = parseInt(p.proc, 10);
    const waga = czasTrwaniaDni(p);
    sumaWag += waga;
    sumaWazona += (isNaN(proc) ? 0 : proc) * waga;
  }
  const procWaz = sumaWag > 0 ? Math.round(sumaWazona / sumaWag) : "";
  return {
    zadanie: w.zadanie,
    start: starty[0] || "",
    koniec: konce.length ? konce[konce.length - 1] : "",
    rzecz: wszystkieZakonczone ? rzeczy.sort()[rzeczy.length - 1] : "",
    proc: procWaz === "" ? "" : String(procWaz),
    _sumaryczny: true,
  };
}

// Czy wiersz ma realne podpozycje
function maPodpozycje(w) {
  return Array.isArray(w.pod) && w.pod.filter((p) => p && (p.zadanie || p.start || p.koniec || p.rzecz || p.proc)).length > 0;
}

/* ---------------------------------------------------------------------------
   CASHFLOW — rdzeń obliczeniowy (przetestowany w izolacji: 7/7).
   Wartość umowy (sprzedaż) rozkładana kalendarzowo proporcjonalnie do dni.
--------------------------------------------------------------------------- */
// Efektywna suma "wartości umowy" zadania (z podpozycji lub własna).
function kwotaZadania(w) {
  const pod = Array.isArray(w.pod) ? w.pod.filter((p) => p && (p.start || p.koniec || p.kwota || p.proc)) : [];
  const kwotaGl = parseFloat(w.kwota) || 0;
  const sumaPod = pod.reduce((s, p) => s + (parseFloat(p.kwota) || 0), 0);
  if (pod.length === 0) return kwotaGl;
  return sumaPod > 0 ? sumaPod : kwotaGl; // podpozycje mają pierwszeństwo (suma)
}

// Czy w całym harmonogramie jest jakakolwiek kwota (czy pokazywać cashflow).
function harmonogramMaKwoty(harmonogram) {
  return (harmonogram || []).some((w) => kwotaZadania(w) > 0);
}

// Rozkład kwoty liniowo-kalendarzowo między start a koniec (włącznie).
// Zwraca mapę { "YYYY-MM": kwota }.
function rozlozKalendarzowo(start, koniec, kwota) {
  if (!start || !koniec || !kwota) return {};
  const d0 = new Date(start + "T00:00:00");
  const d1 = new Date(koniec + "T00:00:00");
  if (isNaN(d0) || isNaN(d1) || d1 < d0) return {};
  const dniLacznie = Math.round((d1 - d0) / 86400000) + 1;
  const wynik = {};
  const kur = new Date(d0);
  for (let i = 0; i < dniLacznie; i++) {
    const k = `${kur.getFullYear()}-${String(kur.getMonth() + 1).padStart(2, "0")}`;
    wynik[k] = (wynik[k] || 0) + kwota / dniLacznie;
    kur.setDate(kur.getDate() + 1);
  }
  return wynik;
}

// Pozycje zadania do rozkładu (rozwiązuje reguły podpozycji/kwoty na głównym).
function pozycjeDoRozkladu(w) {
  const pod = Array.isArray(w.pod) ? w.pod.filter((p) => p && (p.start || p.koniec || p.kwota || p.proc)) : [];
  const kwotaGl = parseFloat(w.kwota) || 0;
  const sumaPod = pod.reduce((s, p) => s + (parseFloat(p.kwota) || 0), 0);
  // koniec do rozkładu = prognoza/rzeczywista, a gdy pusta — koniec umowny
  const konDo = (x) => x.rzecz || x.koniec;

  if (pod.length === 0) {
    if (!kwotaGl) return [];
    return [{ start: w.start, koniec: konDo(w), kwota: kwotaGl }];
  }
  if (sumaPod > 0) {
    return pod.filter((p) => parseFloat(p.kwota) > 0)
      .map((p) => ({ start: p.start, koniec: konDo(p), kwota: parseFloat(p.kwota) }));
  }
  if (kwotaGl > 0) {
    const sumaProc = pod.reduce((s, p) => s + (parseInt(p.proc, 10) || 0), 0);
    if (sumaProc > 0) {
      return pod.map((p) => ({ start: p.start, koniec: konDo(p), kwota: kwotaGl * ((parseInt(p.proc, 10) || 0) / sumaProc) }))
        .filter((x) => x.kwota > 0);
    }
    const zDatami = pod.filter((p) => p.start && konDo(p));
    if (zDatami.length) {
      return zDatami.map((p) => ({ start: p.start, koniec: konDo(p), kwota: kwotaGl / zDatami.length }));
    }
  }
  return [];
}

// Pełny cashflow planowy: mapa { "YYYY-MM": kwota } ze wszystkich zadań.
function cashflowPlanowy(harmonogram) {
  const mies = {};
  for (const w of (harmonogram || [])) {
    for (const poz of pozycjeDoRozkladu(w)) {
      const r = rozlozKalendarzowo(poz.start, poz.koniec, poz.kwota);
      for (const [k, v] of Object.entries(r)) mies[k] = (mies[k] || 0) + v;
    }
  }
  return mies;
}

// Suma "wartości umowy" całego harmonogramu.
function sumaWartosciUmowy(harmonogram) {
  return (harmonogram || []).reduce((s, w) => s + kwotaZadania(w), 0);
}

// Wykonana sprzedaż wg procentu: suma (kwota zadania × %/100), z efektywnym %.
function wykonanaSprzedaz(harmonogram) {
  let suma = 0;
  for (const w of (harmonogram || [])) {
    const kwota = kwotaZadania(w);
    if (!kwota) continue;
    const ef = efektywnyWiersz(w);
    const proc = parseInt(ef.proc, 10);
    if (!isNaN(proc)) suma += kwota * (proc / 100);
  }
  return suma;
}

// Buduje wiersze tabeli cashflow (miesięczne + skumulowane) z mapy planowej.
function wierszeCashflow(harmonogram) {
  const mapa = cashflowPlanowy(harmonogram);
  const klucze = Object.keys(mapa).sort();
  let skum = 0;
  return klucze.map((k) => {
    skum += mapa[k];
    const [rok, mies] = k.split("-");
    return { miesiac: k, etykieta: `${mies}.${rok}`, kwota: mapa[k], skumulowana: skum };
  });
}

// Macierz cashflow: zadania (wiersze) × miesiące (kolumny) + sumy.
// Zwraca { miesiace:[{klucz,etykieta}], zadania:[{nazwa,kwota,start,koniec,komorki:{klucz:kwota}}],
//          sumaMies:{klucz:kwota}, sumaNaras:{klucz:kwota}, sumaCalosc }.
function macierzCashflow(harmonogram) {
  const zadania = [];
  const zbiorMiesiecy = new Set();

  for (const w of (harmonogram || [])) {
    const kwota = kwotaZadania(w);
    if (!kwota) continue;
    const ef = efektywnyWiersz(w);
    const start = ef.start || "";
    const koniec = ef.rzecz || ef.koniec || ""; // koniec do wyświetlenia = prognoza/rzecz, fallback umowa
    // rozkład tego zadania na miesiące
    const komorki = {};
    for (const poz of pozycjeDoRozkladu(w)) {
      const r = rozlozKalendarzowo(poz.start, poz.koniec, poz.kwota);
      for (const [k, v] of Object.entries(r)) { komorki[k] = (komorki[k] || 0) + v; zbiorMiesiecy.add(k); }
    }
    zadania.push({ nazwa: (w.zadanie || "").trim() || "—", kwota, start, koniec, komorki });
  }

  const miesiace = Array.from(zbiorMiesiecy).sort().map((k) => {
    const [rok, m] = k.split("-");
    return { klucz: k, etykieta: `${m}.${rok.slice(2)}` };
  });

  const sumaMies = {};
  for (const z of zadania) for (const [k, v] of Object.entries(z.komorki)) sumaMies[k] = (sumaMies[k] || 0) + v;

  const sumaNaras = {};
  let bieg = 0;
  for (const m of miesiace) { bieg += (sumaMies[m.klucz] || 0); sumaNaras[m.klucz] = bieg; }

  const sumaCalosc = zadania.reduce((s, z) => s + z.kwota, 0);

  // Dane zbiorcze do wiersza podsumowania:
  // data min = najwcześniejszy start, data max = najpóźniejszy koniec (z tych co mają daty),
  // koniecNaras = ostatnia wartość narastającego (suma tego, co realnie weszło do rozkładu),
  // rozjazd = suma kwot ≠ koniec narastającego (np. zadanie z kwotą bez dat).
  const starty = zadania.map((z) => z.start).filter(Boolean).sort();
  const konce = zadania.map((z) => z.koniec).filter(Boolean).sort();
  const dataMin = starty[0] || "";
  const dataMax = konce.length ? konce[konce.length - 1] : "";
  const koniecNaras = miesiace.length ? sumaNaras[miesiace[miesiace.length - 1].klucz] : 0;
  const rozjazd = Math.abs(sumaCalosc - koniecNaras) > 1; // tolerancja 1 zł na zaokrąglenia

  return { miesiace, zadania, sumaMies, sumaNaras, sumaCalosc, dataMin, dataMax, koniecNaras, rozjazd };
}

// Macierz cashflow: zadania × miesiące, żółte tło komórek z kwotą, sumy na dole.
// fmtZ — formatowanie kwoty (pełne zł, spacje jako separator tysięcy).
function MacierzCashflow({ dane }) {
  if (!dane || dane.zadania.length === 0 || dane.miesiace.length === 0) return null;
  const { miesiace, zadania, sumaMies, sumaNaras, sumaCalosc, dataMin, dataMax, koniecNaras, rozjazd } = dane;
  const fmtZ = (n) => n ? Math.round(n).toLocaleString("pl-PL") : "";
  const thBase = { padding: "5px 6px", border: "1px solid #D9D6CE", fontSize: 10, whiteSpace: "nowrap" };
  const thOpis = { ...thBase, background: C.czarny, color: C.zolty, textAlign: "left" };
  const thMies = { ...thBase, background: "#3A3A3A", color: "#FFF", textAlign: "right" };
  const tdBase = { padding: "4px 6px", border: "1px solid #E6E3DB", fontSize: 10 };

  return (
    <div className="tabela-scroll-own" style={{ width: "100%", overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", minWidth: 640, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...thOpis, position: "sticky", left: 0 }}>Zadanie</th>
            <th style={{ ...thOpis, textAlign: "right" }}>Kwota netto</th>
            <th style={{ ...thOpis, textAlign: "center" }}>Start</th>
            <th style={{ ...thOpis, textAlign: "center" }}>Koniec</th>
            {miesiace.map((m) => <th key={m.klucz} style={thMies}>{m.etykieta}</th>)}
          </tr>
        </thead>
        <tbody>
          {zadania.map((z, i) => (
            <tr key={i}>
              <td style={{ ...tdBase, textAlign: "left" }}>{z.nazwa}</td>
              <td style={{ ...tdBase, textAlign: "right" }}>{fmtZ(z.kwota)}</td>
              <td style={{ ...tdBase, textAlign: "center", color: C.szary }}>{z.start ? fmtPL(z.start) : "—"}</td>
              <td style={{ ...tdBase, textAlign: "center", color: C.szary }}>{z.koniec ? fmtPL(z.koniec) : "—"}</td>
              {miesiace.map((m) => {
                const v = z.komorki[m.klucz];
                return <td key={m.klucz} style={{ ...tdBase, textAlign: "right", background: v ? "#FFF9E6" : "transparent" }}>{v ? fmtZ(v) : "–"}</td>;
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...tdBase, textAlign: "left", fontWeight: 700, background: "#F3F0E8", border: "1px solid #C9C6BE" }}>RAZEM miesięcznie</td>
            <td style={{ ...tdBase, textAlign: "right", fontWeight: 700, background: "#F3F0E8", border: "1px solid #C9C6BE" }}>{fmtZ(sumaCalosc)}</td>
            <td colSpan={2} style={{ background: "#F3F0E8", border: "1px solid #C9C6BE" }}></td>
            {miesiace.map((m) => <td key={m.klucz} style={{ ...tdBase, textAlign: "right", fontWeight: 700, background: "#F3F0E8", border: "1px solid #C9C6BE" }}>{fmtZ(sumaMies[m.klucz])}</td>)}
          </tr>
          <tr>
            <td style={{ ...tdBase, textAlign: "left", fontWeight: 700, background: C.zolty, color: C.czarny, border: "1px solid #C9C6BE" }}>Narastająco</td>
            <td colSpan={3} style={{ background: C.zolty, border: "1px solid #C9C6BE" }}></td>
            {miesiace.map((m) => <td key={m.klucz} style={{ ...tdBase, textAlign: "right", fontWeight: 700, background: C.zolty, color: C.czarny, border: "1px solid #C9C6BE" }}>{fmtZ(sumaNaras[m.klucz])}</td>)}
          </tr>
        </tfoot>
      </table>
      {rozjazd && (
        <div style={{ marginTop: 8, padding: "8px 12px", background: "#FBE6E6", border: "1px solid #E0B4B4", borderRadius: 6, fontSize: 12, color: "#B22222" }}>
          ⚠ Suma wartości umowy ({fmtZ(sumaCalosc)} zł) różni się od sumy narastającej cashflow ({fmtZ(koniecNaras)} zł).
          Prawdopodobnie któreś zadanie ma wpisaną kwotę bez kompletu dat (start/koniec) — taka kwota nie trafia do rozkładu miesięcznego. Uzupełnij daty, aby sumy się zgadzały.
        </div>
      )}
    </div>
  );
}

// Wykres cashflow: słupki miesięczne (żółte) + linia skumulowana (czarna, krzywa S).
// Czysty SVG — pewny w druku PDF. Skalowanie do liczby miesięcy.
function WykresCashflow({ wiersze }) {
  if (!wiersze || wiersze.length === 0) return null;
  const W = 720, H = 240, mL = 8, mR = 8, mT = 16, mB = 44;
  const pole = { x: mL, y: mT, w: W - mL - mR, h: H - mT - mB };
  const n = wiersze.length;
  const maxMies = Math.max(...wiersze.map((w) => w.kwota), 1);
  const maxSkum = Math.max(...wiersze.map((w) => w.skumulowana), 1);
  const bw = pole.w / n;                       // szerokość slotu miesiąca
  const slupW = Math.min(bw * 0.6, 48);        // szerokość słupka
  const fmtK = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".0", "") + " mln";
    if (n >= 1e3) return Math.round(n / 1e3) + " tys";
    return String(Math.round(n));
  };
  // punkty linii skumulowanej
  const punkty = wiersze.map((w, i) => {
    const cx = pole.x + bw * i + bw / 2;
    const cy = pole.y + pole.h - (w.skumulowana / maxSkum) * pole.h;
    return [cx, cy];
  });
  const linia = punkty.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  // pokazuj co którą etykietę osi X, gdy dużo miesięcy
  const krokEt = n > 14 ? Math.ceil(n / 12) : 1;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="xMidYMid meet">
      {/* linia bazowa */}
      <line x1={pole.x} y1={pole.y + pole.h} x2={pole.x + pole.w} y2={pole.y + pole.h} stroke="#E0DDD4" strokeWidth="1" />
      {/* słupki miesięczne */}
      {wiersze.map((w, i) => {
        const h = (w.kwota / maxMies) * pole.h;
        const x = pole.x + bw * i + (bw - slupW) / 2;
        const y = pole.y + pole.h - h;
        return <rect key={i} x={x.toFixed(1)} y={y.toFixed(1)} width={slupW.toFixed(1)} height={Math.max(h, 0).toFixed(1)} fill="#FBC707" rx="2" />;
      })}
      {/* linia skumulowana */}
      <path d={linia} fill="none" stroke="#1A1A1A" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {punkty.map((p, i) => <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="3" fill="#1A1A1A" />)}
      {/* etykiety osi X */}
      {wiersze.map((w, i) => (i % krokEt === 0) ? (
        <text key={i} x={(pole.x + bw * i + bw / 2).toFixed(1)} y={H - 26} textAnchor="middle" fontSize="10" fill="#6B6B6B">{w.etykieta}</text>
      ) : null)}
      {/* etykieta wartości końcowej skumulowanej */}
      {punkty.length > 0 && (
        <text x={punkty[punkty.length - 1][0].toFixed(1)} y={(punkty[punkty.length - 1][1] - 8).toFixed(1)} textAnchor="end" fontSize="10" fontWeight="700" fill="#1A1A1A">
          {fmtK(wiersze[wiersze.length - 1].skumulowana)} zł
        </text>
      )}
      {/* legenda */}
      <rect x={pole.x} y={H - 12} width="10" height="10" fill="#FBC707" rx="2" />
      <text x={pole.x + 14} y={H - 3} fontSize="10" fill="#6B6B6B">sprzedaż w miesiącu</text>
      <line x1={pole.x + 150} y1={H - 7} x2={pole.x + 168} y2={H - 7} stroke="#1A1A1A" strokeWidth="2" />
      <text x={pole.x + 172} y={H - 3} fontSize="10" fill="#6B6B6B">narastająco</text>
    </svg>
  );
}

const PODSUMOWANIE_OPCJE = [
  "Aktualny stan zaawansowania robót nie powoduje zagrożenia terminu zakończenia budowy.",
  "Aktualny stan zaawansowania budowy powoduje zagrożenie w dotrzymaniu terminu zakończenia budowy.",
];

const PUSTY_RAPORT = {
  projekt: "",
  numer: "1",
  okresOd: "",
  okresDo: "",
  dataOpracowania: "",
  adres: "",
  tytulZadania: "",
  rozpoczecie: "",
  zakonczenieRobot: "",
  pnu: "",
  pnuNieDotyczy: false,
  opracowal: "",
  infoOgolne: "",
  opoznienia: "",
  wykonawcy: "",
  przetargi: "",
  sprawyBudowy: "",
  sprawyInwestora: "",
  placBudowy: "",
  podsumowanie: PODSUMOWANIE_OPCJE[0],
  grafikaInwestycji: null, // {nazwa, dataUrl} — rendering/wizualizacja w nagłówku
  harmonogram: null, // inicjalizowane przy pierwszym użyciu (pustyHarmonogram)
  harmonogramObrazy: [], // [{nazwa, dataUrl}] — obrazy harmonogramu (np. wielostronicowy z MS Project)
  zdjecia: [], // {nazwa, dataUrl, opis}
};

const C = {
  zolty: "#FBC707",
  czarny: "#1A1A1A",
  grafit: "#2C2C2C",
  szary: "#6B6B6B",
  jasny: "#F5F3EE",
  bialy: "#FFFFFF",
  linia: "#E0DDD4",
  zoltyJasny: "#FFF6D6",
  czerwony: "#B22222",
};

// Wspólny pasek nawigacji — jeden dla wszystkich widoków (formularz, archiwum, panel).
// aktywny: "form" | "archiwum" | "admin". Zakładka panelu tylko dla admina.
function PasekNawigacji({ aktywny, jestAdmin, email, onForm, onArchiwum, onKoordynacja, onAdmin, onWyloguj }) {
  const zakl = (kod, etykieta, onClick) => {
    const akt = aktywny === kod;
    return (
      <button onClick={onClick}
        style={{ background: akt ? C.zolty : "transparent", color: akt ? C.czarny : C.zolty,
          border: `1.5px solid ${C.zolty}`, padding: "8px 16px", borderRadius: 6, fontWeight: 700, fontSize: 13,
          cursor: "pointer", fontFamily: "inherit" }}>
        {etykieta}
      </button>
    );
  };
  return (
    <header style={{ background: C.czarny, padding: 0, position: "sticky", top: 0, zIndex: 20 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
          <span style={{ color: C.zolty, fontWeight: 800, fontSize: 26, letterSpacing: -0.5 }}>/</span>
          <span style={{ color: C.bialy, fontWeight: 800, fontSize: 24, letterSpacing: 0.5 }}>Abyard</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {zakl("form", "Generator", onForm)}
          {zakl("archiwum", "Archiwum raportów", onArchiwum)}
          {onKoordynacja && zakl("koordynacja-pm", "Kto co prowadzi", onKoordynacja)}
          {jestAdmin && zakl("admin", "Panel admina", onAdmin)}
          <span style={{ color: C.szary, fontSize: 12, display: "flex", alignItems: "center", gap: 8, marginLeft: 4 }}>
            {email}
            {jestAdmin && <span style={{ background: C.zolty, color: C.czarny, fontWeight: 700, fontSize: 10, padding: "2px 7px", borderRadius: 10 }}>ADMIN</span>}
          </span>
          <button onClick={onWyloguj}
            style={{ background: "transparent", color: C.szary, border: `1px solid ${C.grafit}`, padding: "7px 14px", borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            Wyloguj
          </button>
        </div>
      </div>
    </header>
  );
}


function dzisISO() {
  return new Date().toISOString().slice(0, 10);
}
function fmtPL(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// ---- Automatyczna kompresja obrazu: skaluje do max 1440px i zapisuje JPEG 0.7
// Zwraca Promise<string> z dataUrl skompresowanego obrazu.
function kompresujObraz(file, maxWymiar = 1440, jakosc = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("img"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWymiar || height > maxWymiar) {
          if (width >= height) {
            height = Math.round((height * maxWymiar) / width);
            width = maxWymiar;
          } else {
            width = Math.round((width * maxWymiar) / height);
            height = maxWymiar;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        // białe tło (gdyby źródłem był PNG z przezroczystością — JPEG nie ma alfy)
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        try {
          resolve({ dataUrl: canvas.toDataURL("image/jpeg", jakosc), w: width, h: height });
        } catch {
          // fallback: jeśli toDataURL zawiedzie, użyj oryginału
          resolve({ dataUrl: reader.result, w: width, h: height });
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function nazwaPliku(f) {
  const num = String(f.numer).padStart(3, "0");
  const proj = (f.projekt || "RAPORT").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return `RAPORT_NR_${num}_-_${proj}_-_${f.dataOpracowania}`;
}

// Token z adresu (#r/<token>) — obecność przełącza aplikację w publiczny
// podgląd raportu bez logowania. Czytany raz, przy załadowaniu strony.
const TOKEN_PUBLICZNY = (() => {
  const m = /^#r\/([A-Za-z0-9]{20,})/.exec(window.location.hash || "");
  return m ? m[1] : null;
})();

export default function GeneratorRaportowABYARD() {
  const [form, setForm] = useState({ ...PUSTY_RAPORT, dataOpracowania: dzisISO() });
  const [widok, setWidok] = useState("form"); // form | preview | archiwum
  const [projekty, setProjekty] = useState([]); // [{id, nazwa}] — z bazy
  const [zapisywanie, setZapisywanie] = useState(false);
  const [zapisanyId, setZapisanyId] = useState(null); // ID raportu zapisanego w tej sesji (do aktualizacji)
  const [selectKey, setSelectKey] = useState(0); // wymusza odświeżenie selecta po anulowaniu zmiany budowy
  const [toast, setToast] = useState("");
  // Archiwum:
  const [archRaporty, setArchRaporty] = useState(null); // null = nie wczytano; [] = wczytano puste
  const [archLadowanie, setArchLadowanie] = useState(false);
  const [cashflowWlaczony, setCashflowWlaczony] = useState(false); // czy pokazać kolumnę kwot + cashflow
  const [archFiltr, setArchFiltr] = useState(""); // filtr po nazwie budowy (klik w kafelek)
  const [podgladForm, setPodgladForm] = useState(null); // dane raportu otwartego z archiwum
  // Auth + role:
  const [sesja, setSesja] = useState(undefined); // undefined = sprawdzanie; null = niezalogowany; obj = zalogowany
  const [profil, setProfil] = useState(null); // {id, email, rola}
  const [mojePrzypisania, setMojePrzypisania] = useState([]);
  const photoInputRef = useRef(null);
  const harmInputRef = useRef(null);
  const grafikaInputRef = useRef(null);
  const wczytanaBudowaRef = useRef(null);

  // Surowe pliki obrazów trzymamy osobno (do uploadu przy zapisie).
  // Klucze: "grafika", "harm", "zdjecia" -> File / [File]
  const plikiRef = useRef({ grafika: null, harm: [], zdjecia: [] });

  const pokazToast = useCallback((t) => {
    setToast(t);
    setTimeout(() => setToast(""), 2600);
  }, []);

  // --- Sprawdzenie sesji przy starcie + nasłuch zmian logowania ---
  useEffect(() => {
    biezacaSesja().then((s) => setSesja(s));
    const odsub = naZmianeAuth((s) => setSesja(s));
    return odsub;
  }, []);

  // --- Po zalogowaniu: wczytaj profil (rolę), przypisania i listę budów ---
  useEffect(() => {
    if (!sesja) {
      setProfil(null);
      setProjekty([]);
      setMojePrzypisania([]);
      return;
    }
    (async () => {
      try {
        const p = await mojProfil();
        setProfil(p);
        const przyp = await listaPrzypisan();
        const moje = przyp.filter((x) => x.uzytkownik === p.id);
        setMojePrzypisania(moje);
        const dostepne = await projektyDoWyboru(p, moje);
        setProjekty(dostepne);
      } catch (e) {
        console.error(e);
        pokazToast("Błąd wczytywania profilu");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sesja]);

  // Nazwa zalogowanego (imię i nazwisko, a gdy brak — e-mail). Do pola „Opracował".
  const nazwaZalogowanego = profil ? nazwaOsoby(profil) : "";
  // Auto-uzupełnij „Opracował" nazwą zalogowanego, dopóki pole jest puste
  // (nowy/pusty formularz). Edycji istniejącego raportu nie ruszamy — tam pole
  // ma już autora i warunek f.opracowal je chroni.
  useEffect(() => {
    if (nazwaZalogowanego) setForm((f) => (f.opracowal ? f : { ...f, opracowal: nazwaZalogowanego }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nazwaZalogowanego]);

  function upd(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // ---- Harmonogram: edycja wiersza ------------------------------------------
  function updHarm(i, key, val) {
    setForm((f) => {
      const h = (f.harmonogram || pustyHarmonogram()).map((r) => ({ ...r }));
      h[i][key] = val;
      // Autopodpowiedź: po wpisaniu końca z umowy, gdy prognoza pusta — ustaw ją na tę datę.
      if (key === "koniec" && val && !h[i].rzecz) h[i].rzecz = val;
      return { ...f, harmonogram: h };
    });
  }
  // Gdy załadowany raport (edycja/zaciągnięty poprzedni) ma już kwoty — włącz cashflow.
  useEffect(() => {
    if (!cashflowWlaczony && harmonogramMaKwoty(form.harmonogram)) setCashflowWlaczony(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.harmonogram]);

  // Wyczyść wszystkie kwoty "wartość umowy" (przy wyłączaniu cashflow)
  function wyczyscKwoty() {
    setForm((f) => {
      const h = (f.harmonogram || pustyHarmonogram()).map((r) => {
        const kopia = { ...r };
        delete kopia.kwota;
        if (Array.isArray(r.pod)) kopia.pod = r.pod.map((p) => { const pk = { ...p }; delete pk.kwota; return pk; });
        return kopia;
      });
      return { ...f, harmonogram: h };
    });
  }
  // Dodaj podpozycję pod wierszem głównym i
  function dodajPodpozycje(i) {
    setForm((f) => {
      const h = (f.harmonogram || pustyHarmonogram()).map((r) => ({ ...r, pod: Array.isArray(r.pod) ? r.pod.map((p) => ({ ...p })) : [] }));
      h[i].pod.push({ zadanie: "", start: "", koniec: "", rzecz: "", proc: "" });
      return { ...f, harmonogram: h };
    });
  }
  // Usuń podpozycję j z wiersza i
  function usunPodpozycje(i, j) {
    setForm((f) => {
      const h = (f.harmonogram || pustyHarmonogram()).map((r) => ({ ...r, pod: Array.isArray(r.pod) ? r.pod.map((p) => ({ ...p })) : [] }));
      h[i].pod.splice(j, 1);
      return { ...f, harmonogram: h };
    });
  }
  // Edytuj pole podpozycji
  function updPodpozycje(i, j, key, val) {
    setForm((f) => {
      const h = (f.harmonogram || pustyHarmonogram()).map((r) => ({ ...r, pod: Array.isArray(r.pod) ? r.pod.map((p) => ({ ...p })) : [] }));
      h[i].pod[j][key] = val;
      // Autopodpowiedź prognozy dla podpozycji.
      if (key === "koniec" && val && !h[i].pod[j].rzecz) h[i].pod[j].rzecz = val;
      return { ...f, harmonogram: h };
    });
  }
  function dodajObrazHarm(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    plikiRef.current.harm = [...plikiRef.current.harm, ...files]; // oryginały do uploadu
    // Harmonogram zawiera drobny tekst i liczby — NIE kompresujemy, by zachować czytelność.
    Promise.all(
      files.map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ nazwa: file.name, dataUrl: reader.result });
            reader.readAsDataURL(file);
          })
      )
    ).then((nowe) => setForm((f) => ({ ...f, harmonogramObrazy: [...f.harmonogramObrazy, ...nowe] })));
    e.target.value = "";
  }
  function usunObrazHarm(i) {
    plikiRef.current.harm = plikiRef.current.harm.filter((_, idx) => idx !== i);
    setForm((f) => ({ ...f, harmonogramObrazy: f.harmonogramObrazy.filter((_, idx) => idx !== i) }));
  }
  function przesunObrazHarm(i, kierunek) {
    setForm((f) => {
      const arr = [...f.harmonogramObrazy];
      const j = i + kierunek;
      if (j < 0 || j >= arr.length) return f;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      // utrzymaj kolejność surowych plików zgodną z podglądem
      const praw = plikiRef.current.harm;
      if (praw[i] && praw[j]) [praw[i], praw[j]] = [praw[j], praw[i]];
      return { ...f, harmonogramObrazy: arr };
    });
  }
  function dodajGrafike(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    plikiRef.current.grafika = file; // zachowaj oryginał do uploadu przy zapisie
    kompresujObraz(file).then(({ dataUrl }) =>
      setForm((f) => ({ ...f, grafikaInwestycji: { nazwa: file.name, dataUrl } }))
    );
    e.target.value = "";
  }
  function usunGrafike() {
    plikiRef.current.grafika = null;
    setForm((f) => ({ ...f, grafikaInwestycji: null }));
  }

  // Czy w bieżącym formularzu jest coś, co warto chronić przed nadpisaniem?
  // (pomijamy projekt/numer/daty domyślne — sprawdzamy realnie wprowadzoną treść)
  function formularzMaDane() {
    // Uwaga: „opracowal" celowo pominięte — auto-uzupełnia się nazwą zalogowanego,
    // więc nie jest oznaką realnie wprowadzonych danych (nie wywołuje ostrzeżenia).
    const polaTekstowe = [
      "adres", "tytulZadania", "rozpoczecie", "zakonczenieRobot", "pnu",
      "infoOgolne", "opoznienia", "wykonawcy", "przetargi", "sprawyBudowy",
      "sprawyInwestora", "placBudowy",
    ];
    if (polaTekstowe.some((k) => (form[k] || "").trim() !== "")) return true;
    if ((form.zdjecia || []).length > 0) return true;
    if ((form.harmonogramObrazy || []).length > 0) return true;
    if (form.grafikaInwestycji) return true;
    if (form.harmonogram && form.harmonogram.some((r) => r.start || r.koniec || r.rzecz || r.proc || (Array.isArray(r.pod) && r.pod.length > 0))) return true;
    return false;
  }

  // ---- Po wybraniu budowy z listy: pobierz z bazy ostatni raport i numer -----
  async function wybierzProjekt(p) {
    const nazwa = (p || "").trim();
    // Pusty wybór („— wybierz budowę —”) — czyścimy nazwę i resetujemy znacznik sesji
    if (!nazwa) {
      wczytanaBudowaRef.current = null;
      upd("projekt", "");
      return;
    }
    // Ponowny wybór tej samej budowy w tej sesji — nie nadpisujemy pracy PM-a
    if (wczytanaBudowaRef.current === nazwa) {
      upd("projekt", nazwa);
      return;
    }
    // Ostrzeżenie: zmiana budowy nadpisze niezapisane dane bieżącego formularza
    if (!zapisanyId && formularzMaDane()) {
      const ok = window.confirm(
        "Uwaga: zmieniasz budowę. Wszystkie niezapisane dane bieżącego raportu zostaną utracone.\n\nCzy chcesz kontynuować?"
      );
      if (!ok) {
        setSelectKey((k) => k + 1); // anulowano — przywróć select do obecnej budowy
        return;
      }
    }
    wczytanaBudowaRef.current = nazwa;
    setZapisanyId(null); // nowa budowa = nowy raport, kolejny zapis tworzy nowy wiersz
    try {
      const projektId = await idProjektuPoNazwie(nazwa);
      const ost = await pobierzOstatniRaport(projektId);
      if (ost) {
        const bazowy = mapWierszNaForm(ost);
        const nowyNumer = String((parseInt(ost.numer, 10) || 0) + 1);
        setForm({
          ...bazowy,
          projekt: nazwa,
          numer: nowyNumer,
          okresOd: ost.okres_do || "",
          okresDo: dzisISO(),
          dataOpracowania: dzisISO(),
          opracowal: nazwaZalogowanego || bazowy.opracowal,
          zdjecia: [],
          harmonogramObrazy: [],
        });
        plikiRef.current = { grafika: null, harm: [], zdjecia: [] };
        pokazToast(`Wczytano dane z raportu nr ${ost.numer} — do aktualizacji`);
      } else {
        // pierwszy raport tej budowy — czysty formularz (nie zostawiamy danych z poprzedniej budowy)
        setForm({
          ...PUSTY_RAPORT,
          projekt: nazwa,
          numer: "1",
          dataOpracowania: dzisISO(),
          opracowal: nazwaZalogowanego || PUSTY_RAPORT.opracowal,
        });
        plikiRef.current = { grafika: null, harm: [], zdjecia: [] };
        pokazToast(`To pierwszy raport budowy „${nazwa}” — numer 1`);
      }
    } catch (e) {
      console.error(e);
      pokazToast("Błąd pobierania danych budowy z bazy");
      upd("projekt", nazwa);
    }
  }

  // ---- Dodawanie zdjęć -------------------------------------------------------
  function dodajZdjecia(e) {
    const files = Array.from(e.target.files || []);
    plikiRef.current.zdjecia = [...plikiRef.current.zdjecia, ...files]; // oryginały do uploadu
    // kompresujemy równolegle, ale wstawiamy w oryginalnej kolejności
    Promise.all(files.map((file) => kompresujObraz(file).then(({ dataUrl, w, h }) => ({ nazwa: file.name, dataUrl, opis: "", pion: h > w }))))
      .then((nowe) => setForm((f) => ({ ...f, zdjecia: [...f.zdjecia, ...nowe] })));
    e.target.value = "";
  }
  function usunZdjecie(i) {
    plikiRef.current.zdjecia = plikiRef.current.zdjecia.filter((_, idx) => idx !== i);
    setForm((f) => ({ ...f, zdjecia: f.zdjecia.filter((_, idx) => idx !== i) }));
  }
  function opisZdjecia(i, v) {
    setForm((f) => {
      const z = f.zdjecia.map((x) => ({ ...x }));
      z[i].opis = v;
      return { ...f, zdjecia: z };
    });
  }
  function przesunZdjecie(i, kierunek) {
    setForm((f) => {
      const z = [...f.zdjecia];
      const j = i + kierunek;
      if (j < 0 || j >= z.length) return f;
      [z[i], z[j]] = [z[j], z[i]];
      const praw = plikiRef.current.zdjecia;
      if (praw[i] && praw[j]) [praw[i], praw[j]] = [praw[j], praw[i]];
      return { ...f, zdjecia: z };
    });
  }

  // ---- Zapis: upload zdjęć do Storage + insert raportu do bazy ----------------
  async function zapiszArchiwum() {
    if (!form.projekt) {
      pokazToast("Najpierw wybierz inwestycję");
      return;
    }
    if (zapisywanie) return;
    // Monit blokujący: zadania w toku z przekroczonym terminem prognozy/umowy.
    const doUzupelnienia = [];
    (form.harmonogram || []).forEach((r, i) => {
      if (!maPodpozycje(r) && wymagaUzupelnienia(r, form.dataOpracowania)) doUzupelnienia.push(`${i + 1}. ${r.zadanie}`);
      if (Array.isArray(r.pod)) r.pod.forEach((p, j) => {
        if (wymagaUzupelnienia(p, form.dataOpracowania)) doUzupelnienia.push(`${i + 1}.${j + 1} ${p.zadanie || "(podpozycja)"}`);
      });
    });
    if (doUzupelnienia.length > 0) {
      const lista = doUzupelnienia.slice(0, 12).join("\n");
      const wiecej = doUzupelnienia.length > 12 ? `\n…i ${doUzupelnienia.length - 12} więcej` : "";
      window.alert(
        `Nie można zapisać raportu.\n\nNastępujące zadania nie są ukończone (< 100%), a ich termin (prognoza/umowa) już minął. Zaktualizuj prognozowaną datę zakończenia lub ustaw 100%:\n\n${lista}${wiecej}`
      );
      return;
    }
    // Nadpisanie istniejącego raportu — wymagaj potwierdzenia
    if (zapisanyId) {
      const ok = window.confirm(
        `Zapisujesz zmiany w raporcie nr ${form.numer} dla budowy „${form.projekt}”.\n\nIstniejący raport zostanie nadpisany. Czy chcesz kontynuować?`
      );
      if (!ok) return;
    }
    setZapisywanie(true);
    try {
      const projektId = await idProjektuPoNazwie(form.projekt);
      if (!projektId) {
        pokazToast("Tej budowy nie ma na liście (skontaktuj się z administratorem)");
        setZapisywanie(false);
        return;
      }

      const prefix = `${bezpiecznyKlucz(form.projekt)}/nr${form.numer}`;

      // 1) Grafika inwestycji — upload jeśli dodano nowy plik; inaczej zachowaj istniejący URL
      let grafikaUrl = form.grafikaInwestycji?.url || null;
      if (plikiRef.current.grafika) {
        grafikaUrl = await wgrajPojedynczyObraz(plikiRef.current.grafika, `${prefix}/grafika`);
      }

      // 2) Obrazy harmonogramu — nowe pliki uploadujemy, istniejące URL-e zachowujemy
      const istniejaceHarm = (form.harmonogramObrazy || [])
        .filter((o) => o.url)
        .map((o) => o.url);
      const noweHarm = [];
      for (const file of plikiRef.current.harm) {
        noweHarm.push(await wgrajPojedynczyObraz(file, `${prefix}/harmonogram`));
      }
      const harmonogramUrls = [...istniejaceHarm, ...noweHarm];

      // 3) Zdjęcia — nowe pliki (z opisami i orientacją ze stanu) + istniejące z URL
      const noweMeta = (form.zdjecia || []).filter((z) => !z.url); // nowe zdjęcia w kolejności
      const noweZdjPliki = plikiRef.current.zdjecia.map((file, i) => ({
        file,
        opis: noweMeta[i]?.opis || "",
        pion: !!noweMeta[i]?.pion,
      }));
      // stare zdjęcia (z url) — zachowujemy url, opis i orientację
      const stareZdj = (form.zdjecia || []).filter((z) => z.url).map((z) => ({ url: z.url, opis: z.opis || "", pion: !!z.pion }));
      const noweZdj = await wgrajZdjecia(noweZdjPliki, `${prefix}/zdjecia`);
      const zdjeciaFinal = [...stareZdj, ...noweZdj];

      // 4) Zapis wiersza — aktualizacja istniejącego albo nowy
      const formDoZapisu = {
        ...form,
        grafika_url: grafikaUrl,
        harmonogram_urls: harmonogramUrls,
        zdjecia: zdjeciaFinal,
      };
      let zapisany;
      if (zapisanyId) {
        // pracujemy nad raportem zapisanym w tej sesji — nadpisujemy
        zapisany = await aktualizujRaport(zapisanyId, formDoZapisu, projektId);
        pokazToast(`Zaktualizowano raport nr ${zapisany.numer} ✓`);
      } else {
        zapisany = await zapiszRaport(formDoZapisu, projektId);
        setZapisanyId(zapisany.id); // od teraz kolejny zapis = aktualizacja
        pokazToast(`Zapisano raport nr ${zapisany.numer} w bazie ✓`);
      }
      // po zapisie nowe pliki są już w bazie jako URL — czyścimy bufor surowych plików,
      // by przy aktualizacji nie wgrać ich drugi raz
      plikiRef.current = { grafika: null, harm: [], zdjecia: [] };
    } catch (e) {
      console.error(e);
      // Najczęstszy błąd na starcie: duplikat numeru (unique projekt_id+numer)
      const msg = String(e?.message || "");
      if (msg.includes("duplicate") || msg.includes("unique")) {
        pokazToast("Raport o tym numerze już istnieje dla tej budowy — odśwież numer");
      } else {
        pokazToast("Błąd zapisu do bazy — sprawdź konsolę");
      }
    } finally {
      setZapisywanie(false);
    }
  }

  // ---- Generowanie PDF (przez okno druku przeglądarki) -----------------------
  function drukujZNazwa(nazwa) {
    const poprzedni = document.title;
    document.title = nazwa; // przeglądarka użyje tego jako domyślnej nazwy pliku PDF
    const przywroc = () => { document.title = poprzedni; window.removeEventListener("afterprint", przywroc); };
    window.addEventListener("afterprint", przywroc);
    window.print();
    // zabezpieczenie, gdyby afterprint nie zadziałał
    setTimeout(przywroc, 1500);
  }
  // Otwiera podgląd raportu — tam użytkownik wybiera: zapis do PDF lub link
  // dla inwestora (druk nie odpala się już automatycznie).
  function generujPDF() {
    setWidok("preview");
  }

  // ---- ARCHIWUM: wejście w zakładkę + wczytanie listy ------------------------
  async function otworzArchiwum() {
    setWidok("archiwum");
    setArchFiltr("");
    setPodgladForm(null);
    if (archRaporty === null) {
      // wczytujemy tylko raz; przycisk "Odśwież" wymusza ponowne pobranie
      await wczytajArchiwum();
    }
  }
  async function wczytajArchiwum() {
    setArchLadowanie(true);
    try {
      const dane = await listaWszystkichRaportow();
      setArchRaporty(dane);
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się wczytać archiwum z bazy");
      setArchRaporty([]);
    } finally {
      setArchLadowanie(false);
    }
  }
  // Usuwa raport wraz z plikami ze Storage (tylko admin; RLS pilnuje po stronie bazy)
  async function usunRaportZArchiwum(r) {
    const nazwa = `raport nr ${r.numer}${r.projekty?.nazwa ? ` — ${r.projekty.nazwa}` : ""}`;
    if (!window.confirm(`Czy na pewno usunąć ${nazwa}?\n\nUsunięte zostaną też wszystkie zdjęcia tego raportu.\nTej operacji NIE DA SIĘ cofnąć.`)) return;
    setArchLadowanie(true);
    try {
      const wynik = await usunRaport(r.id);
      pokazToast(`Usunięto ${nazwa}${wynik.plikow ? ` (plików: ${wynik.plikow})` : ""}`);
      await wczytajArchiwum();
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się usunąć raportu");
      setArchLadowanie(false);
    }
  }
  // Otwiera pełny raport (ze zdjęciami) i przełącza w podgląd PDF
  async function otworzRaportZArchiwum(id) {
    setArchLadowanie(true);
    try {
      const w = await pobierzRaportPoId(id);
      const f = mapWierszNaForm(w);
      f.projekt = w.projekty?.nazwa || "";
      f.id = w.id; // potrzebne do generowania linków udostępniania
      setPodgladForm(f);
      setWidok("preview-arch");
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się otworzyć raportu");
    } finally {
      setArchLadowanie(false);
    }
  }

  // Edycja raportu z archiwum — tylko admin. Wczytuje raport do formularza
  // Czy bieżący użytkownik może edytować dany raport (obiekt z listy archiwum).
  // Admin: zawsze. PM: tylko własny raport w ciągu 24h od utworzenia.
  function mozeEdytowac(r) {
    if (!r) return false;
    if (profil?.rola === "admin") return true;
    if (!profil?.id || r.utworzony_przez !== profil.id) return false;
    if (!r.utworzono) return false;
    const minelo = Date.now() - new Date(r.utworzono).getTime();
    return minelo >= 0 && minelo < 24 * 3600 * 1000;
  }

  // Pozostały czas edycji dla PM w pełnych godzinach (zaokrąglony w górę).
  // Zwraca null gdy nie dotyczy (admin / brak limitu / już po czasie).
  function godzinyDoEdycji(r) {
    if (!r || profil?.rola === "admin" || !r.utworzono) return null;
    const minelo = Date.now() - new Date(r.utworzono).getTime();
    const zostalo = 24 * 3600 * 1000 - minelo;
    if (zostalo <= 0) return null;
    return Math.ceil(zostalo / (3600 * 1000));
  }

  // i ustawia zapisanyId, by kolejny zapis nadpisał ten sam raport.
  async function edytujRaportZArchiwum(id) {
    // Walidacja uprawnień: znajdź raport na liście i sprawdź okno edycji.
    const meta = (archRaporty || []).find((r) => r.id === id);
    if (!mozeEdytowac(meta)) {
      pokazToast("Tego raportu nie można już edytować");
      return;
    }
    setArchLadowanie(true);
    try {
      const w = await pobierzRaportPoId(id);
      const f = mapWierszNaForm(w);
      f.projekt = w.projekty?.nazwa || "";
      setForm(f);
      setZapisanyId(id);                 // kolejny zapis nadpisze ten raport
      wczytanaBudowaRef.current = f.projekt; // nie wymuszaj przeładowania budowy
      // załaduj surowe pliki jako już-wgrane URL-e, by nie wgrywać ich ponownie
      plikiRef.current = { grafika: null, harm: [], zdjecia: [] };
      setWidok("form");
      pokazToast(`Edytujesz raport nr ${w.numer} — zmiany nadpiszą istniejący`);
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się otworzyć raportu do edycji");
    } finally {
      setArchLadowanie(false);
    }
  }

  // ==========================================================================
  //  PUBLICZNY PODGLĄD Z LINKU (#r/<token>) — przed bramką logowania
  // ==========================================================================
  if (TOKEN_PUBLICZNY) {
    return <WidokPubliczny token={TOKEN_PUBLICZNY} />;
  }

  // ==========================================================================
  //  BRAMKA LOGOWANIA — nic nie pokazujemy bez zalogowania
  // ==========================================================================
  if (sesja === undefined) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.czarny, color: C.szary, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
        Ładowanie…
      </div>
    );
  }
  if (!sesja) {
    return <EkranLogowania pokazToast={pokazToast} />;
  }

  // ==========================================================================
  //  WIDOK PODGLĄDU / PDF (nowy raport z formularza)
  // ==========================================================================
  if (widok === "preview") {
    // raportId = zapisanyId: link dla inwestora dostępny, gdy raport jest już w bazie
    return <PodgladPDF form={form} raportId={zapisanyId} onBack={() => setWidok("form")} nazwaPliku={nazwaPliku(form)} jestAdmin={profil?.rola === "admin"} />;
  }

  // ==========================================================================
  //  WIDOK PODGLĄDU / PDF (raport otwarty z archiwum) — read-only
  // ==========================================================================
  if (widok === "preview-arch" && podgladForm) {
    return <PodgladPDF form={podgladForm} raportId={podgladForm.id} onBack={() => { setWidok("archiwum"); setPodgladForm(null); }} nazwaPliku={nazwaPliku(podgladForm)} jestAdmin={profil?.rola === "admin"} />;
  }

  // ==========================================================================
  //  WIDOK ARCHIWUM
  // ==========================================================================
  if (widok === "archiwum") {
    return (
      <WidokArchiwum
        raporty={archRaporty}
        ladowanie={archLadowanie}
        filtr={archFiltr}
        setFiltr={setArchFiltr}
        onOdswiez={wczytajArchiwum}
        onOtworz={otworzRaportZArchiwum}
        onEdytuj={edytujRaportZArchiwum}
        onUsun={usunRaportZArchiwum}
        mozeEdytowac={mozeEdytowac}
        godzinyDoEdycji={godzinyDoEdycji}
        onNowyRaport={() => setWidok("form")}
        jestAdmin={profil?.rola === "admin"}
        email={profil?.email}
        onForm={() => setWidok("form")}
        onKoordynacja={() => setWidok("koordynacja-pm")}
        onAdmin={() => setWidok("admin")}
        onWyloguj={async () => { await wyloguj(); setWidok("form"); }}
      />
    );
  }

  // ==========================================================================
  //  WIDOK "KTO CO PROWADZI" (dla wszystkich zalogowanych)
  // ==========================================================================
  if (widok === "koordynacja-pm") {
    return (
      <WidokKtoCoProwadzi
        jestAdmin={profil?.rola === "admin"}
        email={profil?.email}
        onForm={() => setWidok("form")}
        onArchiwum={otworzArchiwum}
        onAdmin={() => setWidok("admin")}
        onWyloguj={async () => { await wyloguj(); setWidok("form"); }}
      />
    );
  }

  // ==========================================================================
  //  WIDOK PANELU ADMINA (tylko dla roli admin)
  // ==========================================================================
  if (widok === "admin" && profil?.rola === "admin") {
    return (
      <PanelAdmina
        pokazToast={pokazToast}
        email={profil?.email}
        onForm={() => setWidok("form")}
        onArchiwum={otworzArchiwum}
        onKoordynacja={() => setWidok("koordynacja-pm")}
        onWyloguj={async () => { await wyloguj(); setWidok("form"); }}
      />
    );
  }

  // ==========================================================================
  //  WIDOK FORMULARZA
  // ==========================================================================
  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: C.jasny, minHeight: "100vh", color: C.czarny }}>
      <style>{globalCSS}</style>

      {/* Pasek górny */}
      <PasekNawigacji
        aktywny="form"
        jestAdmin={profil?.rola === "admin"}
        email={profil?.email}
        onForm={() => setWidok("form")}
        onArchiwum={otworzArchiwum}
        onKoordynacja={() => setWidok("koordynacja-pm")}
        onAdmin={() => setWidok("admin")}
        onWyloguj={async () => { await wyloguj(); setWidok("form"); }}
      />

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 120px" }}>

        {/* Pasek akcji: wybór projektu z listy */}
        <section style={card}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", justifyContent: "space-between" }}>
            <div style={{ flex: "1 1 320px" }}>
              <label style={lbl}>Inwestycja</label>
              <select
                key={selectKey}
                style={inp}
                value={form.projekt}
                onChange={(e) => wybierzProjekt(e.target.value)}
              >
                <option value="">— wybierz budowę —</option>
                {projekty.map((p) => (
                  <option key={p.id} value={p.nazwa}>{p.nazwa}</option>
                ))}
              </select>
              {projekty.length === 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: C.szary }}>
                  Brak budów na liście — administrator dodaje je w bazie (tabela „projekty”).
                </div>
              )}
            </div>
          </div>
          {form.projekt && (
            <div style={{ marginTop: 14, padding: "10px 14px", background: C.zoltyJasny, borderLeft: `4px solid ${C.zolty}`, borderRadius: 4, fontSize: 13 }}>
              Raport <strong>nr {form.numer}</strong> dla budowy <strong>{form.projekt}</strong>
              {form.okresOd ? <> · okres <strong>{fmtPL(form.okresOd)} – {fmtPL(form.okresDo)}</strong></> : <> · pierwszy raport tej budowy</>}
            </div>
          )}
        </section>

        {/* Nagłówek raportu */}
        <Sekcja tytul="Nagłówek">
          <div style={grid3}>
            <Pole label="Numer raportu"><input style={inp} value={form.numer} onChange={(e) => upd("numer", e.target.value)} /></Pole>
            <Pole label="Raport za okres — od"><input type="date" style={inp} value={form.okresOd} onChange={(e) => upd("okresOd", e.target.value)} /></Pole>
            <Pole label="Raport za okres — do"><input type="date" style={inp} value={form.okresDo} onChange={(e) => upd("okresDo", e.target.value)} /></Pole>
          </div>
          <p style={{ fontSize: 12.5, color: C.szary, margin: "-6px 0 12px", lineHeight: 1.5 }}>
            „Raport za okres” to <strong>przedział raportowania</strong> (nie czas trwania całego projektu): od dnia zakończenia poprzedniego raportu do dnia opracowania bieżącego. Daty całej inwestycji wpisujesz w sekcji „Kluczowe daty”.
          </p>
          <Pole label="Adres budowy"><input style={inp} value={form.adres} onChange={(e) => upd("adres", e.target.value)} placeholder="np. ul. Obozowa, Kraków" /></Pole>
          <Pole label="Pełny tytuł zadania"><textarea style={ta} value={form.tytulZadania} onChange={(e) => upd("tytulZadania", e.target.value)} placeholder="np. Budowa zespołu budynków mieszkalnych..." /></Pole>
          <div style={{ marginTop: 4 }}>
            <label style={lbl}>Grafika inwestycji (wizualizacja / rendering — wyświetlana w nagłówku raportu)</label>
            {!form.grafikaInwestycji ? (
              <>
                <button style={btnGhost} onClick={() => grafikaInputRef.current?.click()}>+ Dodaj grafikę inwestycji</button>
                <input ref={grafikaInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={dodajGrafike} />
              </>
            ) : (
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: 12, background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 6 }}>
                <img src={form.grafikaInwestycji.dataUrl} alt="" style={{ width: 220, maxHeight: 150, objectFit: "contain", borderRadius: 4 }} />
                <div>
                  <div style={{ fontSize: 13, marginBottom: 8 }}>{form.grafikaInwestycji.nazwa}</div>
                  <button style={{ ...miniBtn, color: "#B22", borderColor: "#E0B4B4" }} onClick={usunGrafike}>Usuń grafikę</button>
                </div>
              </div>
            )}
          </div>
        </Sekcja>

        {/* Kluczowe daty */}
        <Sekcja tytul="Kluczowe daty">
          <div style={grid3}>
            <Pole label="Rozpoczęcie budowy"><input type="date" style={inp} value={form.rozpoczecie} onChange={(e) => upd("rozpoczecie", e.target.value)} /></Pole>
            <Pole label="Zakończenie robót"><input type="date" style={inp} value={form.zakonczenieRobot} onChange={(e) => upd("zakonczenieRobot", e.target.value)} /></Pole>
            <Pole label="Pozwolenie na użytkowanie">
              <input type="date" style={{ ...inp, opacity: form.pnuNieDotyczy ? 0.45 : 1, background: form.pnuNieDotyczy ? C.jasny : inp.background, cursor: form.pnuNieDotyczy ? "not-allowed" : "auto" }}
                value={form.pnuNieDotyczy ? "" : form.pnu}
                disabled={form.pnuNieDotyczy}
                onChange={(e) => upd("pnu", e.target.value)} />
              <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7, fontSize: 13, color: C.szary, cursor: "pointer", userSelect: "none" }}>
                <input type="checkbox" checked={!!form.pnuNieDotyczy}
                  onChange={(e) => upd("pnuNieDotyczy", e.target.checked)}
                  style={{ width: 15, height: 15, cursor: "pointer", accentColor: C.zolty }} />
                Nie dotyczy (poza zakresem)
              </label>
            </Pole>
          </div>
          <div style={grid2}>
            <Pole label="Opracował"><input style={inp} value={form.opracowal} onChange={(e) => upd("opracowal", e.target.value)} placeholder="Imię i nazwisko" /></Pole>
            <Pole label="Data opracowania"><input type="date" style={inp} value={form.dataOpracowania} onChange={(e) => upd("dataOpracowania", e.target.value)} /></Pole>
          </div>
        </Sekcja>

        <Sekcja tytul="Informacje ogólne">
          <Pole label="Stan zaawansowania względem harmonogramu">
            <RichEdytor value={form.infoOgolne} onChange={(v) => upd("infoOgolne", v)} placeholder="Rzetelny opis stanu zaawansowania robót w odniesieniu do harmonogramu..." minHeight={120} />
          </Pole>
          <Pole label="Opóźnienia (pozycja / liczba dni / termin i sposób nadrobienia)">
            <RichEdytor value={form.opoznienia} onChange={(v) => upd("opoznienia", v)} placeholder="Jeśli występuje opóźnienie: która pozycja, ile dni, jak i do kiedy zostanie nadrobione..." />
          </Pole>
        </Sekcja>

        <Sekcja tytul="Wykonawcy prac">
          <RichEdytor value={form.wykonawcy} onChange={(v) => upd("wykonawcy", v)} placeholder="Lista wykonawców i status prac każdego z nich..." minHeight={120} />
        </Sekcja>

        <Sekcja tytul="Przetargi">
          <RichEdytor value={form.przetargi} onChange={(v) => upd("przetargi", v)} placeholder="Rozstrzygnięte i prowadzone przetargi..." />
        </Sekcja>

        <Sekcja tytul="Sprawy ogólne budowy">
          <RichEdytor value={form.sprawyBudowy} onChange={(v) => upd("sprawyBudowy", v)} placeholder="Cash flow, roboty dodatkowe, umowy/aneksy, ustalenia z narad, BHP..." />
        </Sekcja>

        <Sekcja tytul="Sprawy dotyczące Inwestora">
          <RichEdytor value={form.sprawyInwestora} onChange={(v) => upd("sprawyInwestora", v)} placeholder="Projekt, zmiany lokatorskie, optymalizacje, zgody/pozwolenia, rozliczenia..." />
        </Sekcja>

        <Sekcja tytul="Teren placu budowy">
          <RichEdytor value={form.placBudowy} onChange={(v) => upd("placBudowy", v)} placeholder="Organizacja, ochrona, inne..." />
        </Sekcja>

        {/* Harmonogram */}
        <Sekcja tytul="Harmonogram budowy (pozycje ZZK)">
          <div style={{ display: "flex", marginTop: -2, marginBottom: 16, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.linia}`, background: "#FFFDF5" }}>
            <div style={{ width: 5, background: C.zolty, flexShrink: 0 }} />
            <div style={{ padding: "12px 16px", fontSize: 13, color: C.czarny, lineHeight: 1.55 }}>
              <div style={{ marginBottom: 6 }}><strong>Start (umowa)</strong> i <strong>Koniec (umowa)</strong> — pierwotne daty z umowy (stałe, nie zmieniamy ich w trakcie).</div>
              <div style={{ marginBottom: 6 }}><strong>Koniec (prognoza/rzecz.)</strong> — po wpisaniu końca z umowy podpowiada się ta sama data; dla pozycji ukończonej (100%) wpisz datę faktyczną, dla pozycji w toku — przewidywaną datę zakończenia. Gdy termin minie, a pozycja nie jest na 100%, pole podświetli się na czerwono i trzeba je zaktualizować przed zapisem.</div>
              <div style={{ marginBottom: 6 }}><strong>% wykonania</strong> — 100% oznacza pozycję ukończoną; mniej = pozycja w toku.</div>
              <div><strong>Opóźnienie</strong> liczy się samo (zakończenie rzeczywiste minus planowane). Pod pozycją możesz dodać <strong>podpozycje</strong> — wtedy jej daty, % i opóźnienie wyliczą się z nich automatycznie (jak w MS&nbsp;Project).</div>
            </div>
          </div>
          <div className="tabela-scroll-own" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 680 }}>
              <thead>
                <tr>
                  <th style={thHarm}>#</th>
                  <th style={{ ...thHarm, textAlign: "left", minWidth: 220 }}>Zadanie</th>
                  <th style={thHarm}>Start (umowa)</th>
                  <th style={thHarm}>Koniec (umowa)</th>
                  <th style={thHarm}>Koniec (prognoza/rzecz.)</th>
                  <th style={thHarm}>% wyk.</th>
                  <th style={thHarm}>Opóźnienie</th>
                  {cashflowWlaczony && <th style={thHarm}>Wartość umowy (zł)</th>}
                  <th style={thHarm}></th>
                </tr>
              </thead>
              <tbody>
                {(form.harmonogram || pustyHarmonogram()).map((r, i) => {
                  const ef = efektywnyWiersz(r);
                  const sumaryczny = ef._sumaryczny;
                  const op = obliczOpoznienie(ef, form.dataOpracowania);
                  const pod = Array.isArray(r.pod) ? r.pod : [];
                  const wymaga = !sumaryczny && wymagaUzupelnienia(r, form.dataOpracowania);
                  return (
                    <React.Fragment key={i}>
                      {/* Wiersz główny (zadanie) — wyróżniony; pola zablokowane gdy ma podpozycje */}
                      <tr style={{ background: sumaryczny ? "#F3F0E8" : "transparent" }}>
                        <td style={{ ...tdHarm, textAlign: "center", color: C.szary, fontWeight: 700 }}>{i + 1}</td>
                        <td style={{ ...tdHarm, textAlign: "left", fontWeight: 700 }}>
                          {r.zadanie}
                          {wymaga && <div style={{ fontSize: 11, color: "#B22", fontWeight: 600, marginTop: 2 }}>⚠ uzupełnij prognozę</div>}
                        </td>
                        {sumaryczny ? (
                          <>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 600, color: C.czarny }}>{fmtPL(ef.start) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 600, color: C.czarny }}>{fmtPL(ef.koniec) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 600, color: C.czarny }}>{fmtPL(ef.rzecz) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 700, color: C.czarny }}>{ef.proc !== "" ? `${ef.proc}%` : "—"}</td>
                          </>
                        ) : (
                          <>
                            <td style={tdHarm}><input type="date" style={cellInp} value={r.start} onChange={(e) => updHarm(i, "start", e.target.value)} /></td>
                            <td style={tdHarm}><input type="date" style={cellInp} value={r.koniec} onChange={(e) => updHarm(i, "koniec", e.target.value)} /></td>
                            <td style={tdHarm}><input type="date" style={{ ...cellInp, ...(wymaga ? { border: "2px solid #B22", outline: "none" } : {}) }} value={r.rzecz} onChange={(e) => updHarm(i, "rzecz", e.target.value)} /></td>
                            <td style={tdHarm}><input type="number" min="0" max="100" style={{ ...cellInp, width: 64, textAlign: "center" }} value={r.proc} onChange={(e) => updHarm(i, "proc", e.target.value)} placeholder="—" /></td>
                          </>
                        )}
                        <td style={{ ...tdHarm, textAlign: "center", color: op ? "#B22" : C.szary, fontWeight: op ? 700 : 400 }}>{op || "—"}</td>
                        {cashflowWlaczony && (() => {
                          const podKwoty = sumaryczny && pod.reduce((s, p) => s + (parseFloat(p.kwota) || 0), 0) > 0;
                          if (podKwoty) {
                            // suma z podpozycji — bez edycji
                            const suma = pod.reduce((s, p) => s + (parseFloat(p.kwota) || 0), 0);
                            return <td style={{ ...tdHarm, textAlign: "right", fontWeight: 700, color: C.szary }} title="Suma z podpozycji">{suma.toLocaleString("pl-PL")}</td>;
                          }
                          return <td style={tdHarm}><input type="number" min="0" step="1000" style={{ ...cellInp, width: 120, textAlign: "right" }} value={r.kwota || ""} onChange={(e) => updHarm(i, "kwota", e.target.value)} placeholder="—" /></td>;
                        })()}
                        <td style={{ ...tdHarm, textAlign: "center" }}>
                          <button type="button" onClick={() => dodajPodpozycje(i)} title="Dodaj podpozycję"
                            style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 4, cursor: "pointer", fontSize: 16, lineHeight: 1, width: 26, height: 26, color: C.czarny }}>+</button>
                        </td>
                      </tr>
                      {/* Podpozycje — cieńsze, wcięte */}
                      {pod.map((p, j) => {
                        const wymagaP = wymagaUzupelnienia(p, form.dataOpracowania);
                        return (
                        <tr key={`${i}-${j}`} style={{ background: "#FCFBF8" }}>
                          <td style={{ ...tdHarm, textAlign: "right", color: "#A09A88", fontSize: 11 }}>{i + 1}.{j + 1}</td>
                          <td style={{ ...tdHarm, textAlign: "left", paddingLeft: 22 }}>
                            <input type="text" style={{ ...cellInp, fontWeight: 400 }} value={p.zadanie} onChange={(e) => updPodpozycje(i, j, "zadanie", e.target.value)} placeholder="nazwa podpozycji" />
                            {wymagaP && <div style={{ fontSize: 10, color: "#B22", fontWeight: 600, marginTop: 2 }}>⚠ uzupełnij prognozę</div>}
                          </td>
                          <td style={tdHarm}><input type="date" style={cellInp} value={p.start} onChange={(e) => updPodpozycje(i, j, "start", e.target.value)} /></td>
                          <td style={tdHarm}><input type="date" style={cellInp} value={p.koniec} onChange={(e) => updPodpozycje(i, j, "koniec", e.target.value)} /></td>
                          <td style={tdHarm}><input type="date" style={{ ...cellInp, ...(wymagaP ? { border: "2px solid #B22", outline: "none" } : {}) }} value={p.rzecz} onChange={(e) => updPodpozycje(i, j, "rzecz", e.target.value)} /></td>
                          <td style={tdHarm}><input type="number" min="0" max="100" style={{ ...cellInp, width: 64, textAlign: "center" }} value={p.proc} onChange={(e) => updPodpozycje(i, j, "proc", e.target.value)} placeholder="—" /></td>
                          <td style={{ ...tdHarm, textAlign: "center", color: obliczOpoznienie(p, form.dataOpracowania) ? "#B22" : C.szary, fontSize: 12 }}>{obliczOpoznienie(p, form.dataOpracowania) || "—"}</td>
                          {cashflowWlaczony && <td style={tdHarm}><input type="number" min="0" step="1000" style={{ ...cellInp, width: 110, textAlign: "right" }} value={p.kwota || ""} onChange={(e) => updPodpozycje(i, j, "kwota", e.target.value)} placeholder="—" /></td>}
                          <td style={{ ...tdHarm, textAlign: "center" }}>
                            <button type="button" onClick={() => usunPodpozycje(i, j)} title="Usuń podpozycję"
                              style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 4, cursor: "pointer", fontSize: 14, lineHeight: 1, width: 26, height: 26, color: "#B22" }}>×</button>
                          </td>
                        </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              {(() => {
                const h = form.harmonogram || [];
                const konce = [], starty = [];
                for (const w of h) {
                  const ef = efektywnyWiersz(w);
                  if (ef.start) starty.push(ef.start);
                  const kon = ef.rzecz || ef.koniec;
                  if (kon) konce.push(kon);
                }
                const dataMin = starty.sort()[0] || "";
                const dataMax = konce.sort()[konce.length - 1] || "";
                const opoz = opoznienieInwestycji(h, form.dataOpracowania);
                const sumaKwot = sumaWartosciUmowy(h);
                const stopTd = { padding: "6px 8px", borderTop: `2px solid ${C.czarny}`, background: "#F3F0E8", fontSize: 12, fontWeight: 700 };
                return (
                  <tfoot>
                    <tr>
                      <td style={{ ...stopTd, textAlign: "center" }}>Σ</td>
                      <td style={{ ...stopTd, textAlign: "left" }}>PODSUMOWANIE ({h.length} zadań)</td>
                      <td style={{ ...stopTd, textAlign: "center", fontWeight: 400, color: C.szary }} title="Najwcześniejszy start">{dataMin ? fmtPL(dataMin) : "—"}</td>
                      <td style={{ ...stopTd, textAlign: "center", fontWeight: 400, color: C.szary }} colSpan={2} title="Najpóźniejszy koniec (prognoza/rzecz.)">{dataMax ? fmtPL(dataMax) : "—"}</td>
                      <td style={stopTd}></td>
                      <td style={{ ...stopTd, textAlign: "center", color: opoz && opoz.dni > 0 ? "#B22222" : "#1B7A3D" }} title="Opóźnienie całej inwestycji (jak w archiwum)">
                        {opoz ? (opoz.dni > 0 ? `${opoz.dni} dni` : "brak") : "—"}
                      </td>
                      {cashflowWlaczony && <td style={{ ...stopTd, textAlign: "right" }} title="Suma wartości umowy">{sumaKwot ? Math.round(sumaKwot).toLocaleString("pl-PL") : "—"}</td>}
                      <td style={stopTd}></td>
                    </tr>
                  </tfoot>
                );
              })()}
            </table>
          </div>

          {/* CASHFLOW — przycisk włączający + sekcja wyników */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.linia}` }}>
            {!cashflowWlaczony ? (
              <>
                <label style={lbl}>Cashflow sprzedażowy (wartość umowy rozłożona w czasie)</label>
                <p style={{ fontSize: 12, color: C.szary, marginTop: -2, marginBottom: 10 }}>
                  Włącz, aby przy zadaniach harmonogramu pojawiła się kolumna „Wartość umowy". Na jej podstawie oraz dat i procentu zaawansowania powstanie miesięczne zestawienie sprzedaży (narastająco). Kwoty można podać na zadaniu głównym lub podpozycjach.
                </p>
                <button style={btnGhost} onClick={() => setCashflowWlaczony(true)}>+ Utwórz cashflow</button>
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                  <label style={{ ...lbl, marginBottom: 0 }}>Cashflow sprzedażowy</label>
                  <button style={{ ...miniBtn, color: "#B22", borderColor: "#E0B4B4" }}
                    onClick={() => { if (window.confirm("Wyłączyć cashflow? Wpisane wartości umowy zostaną usunięte z tego raportu.")) { wyczyscKwoty(); setCashflowWlaczony(false); } }}>
                    Usuń cashflow
                  </button>
                </div>
                {(() => {
                  if (!harmonogramMaKwoty(form.harmonogram)) {
                    return <p style={{ fontSize: 12.5, color: C.szary, fontStyle: "italic" }}>Wpisz wartości umowy przy zadaniach powyżej, aby zobaczyć zestawienie.</p>;
                  }
                  const macierz = macierzCashflow(form.harmonogram);
                  return (
                    <div>
                      <MacierzCashflow dane={macierz} />
                      <p style={{ fontSize: 11.5, color: C.szary, marginTop: 8, fontStyle: "italic" }}>
                        Rozkład kalendarzowy wg dat: start umowny, koniec prognoza/rzeczywista (gdy pusty — koniec umowny). Kwota zadania dzielona proporcjonalnie do liczby dni w miesiącu.
                      </p>
                    </div>
                  );
                })()}
              </>
            )}
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.linia}` }}>
            <label style={lbl}>Harmonogram jako obraz (dla złożonych projektów — np. zrzut z MS Project)</label>
            <p style={{ fontSize: 12, color: C.szary, marginTop: -2, marginBottom: 10 }}>
              Możesz dodać kilka obrazów (np. wielostronicowy harmonogram) — pojawią się w raporcie jeden pod drugim, w tej kolejności. Format PNG lub JPG (pliki TIF nie są obsługiwane — zapisz harmonogram jako PNG/JPG). <strong>Gdy dodasz obraz, tabela ZZK poniżej nie pojawi się w raporcie.</strong>
            </p>
            <button style={btnGhost} onClick={() => harmInputRef.current?.click()}>+ Dodaj obraz(y) harmonogramu</button>
            <input ref={harmInputRef} type="file" accept="image/png,image/jpeg,image/*" multiple style={{ display: "none" }} onChange={dodajObrazHarm} />
            {form.harmonogramObrazy.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                {form.harmonogramObrazy.map((o, i) => (
                  <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: 12, background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 6 }}>
                    <span style={{ fontWeight: 800, color: C.szary, alignSelf: "center", minWidth: 20 }}>{i + 1}</span>
                    <img src={o.dataUrl} alt="" style={{ width: 160, maxHeight: 120, objectFit: "contain", borderRadius: 4, border: `1px solid ${C.linia}` }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, marginBottom: 8, wordBreak: "break-all" }}>{o.nazwa}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button style={miniBtn} onClick={() => przesunObrazHarm(i, -1)} disabled={i === 0}>↑</button>
                        <button style={miniBtn} onClick={() => przesunObrazHarm(i, 1)} disabled={i === form.harmonogramObrazy.length - 1}>↓</button>
                        <button style={{ ...miniBtn, color: "#B22", borderColor: "#E0B4B4" }} onClick={() => usunObrazHarm(i)}>Usuń</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Sekcja>

        {/* Zdjęcia */}
        <Sekcja tytul={`Dokumentacja fotograficzna ${form.zdjecia.length ? `(${form.zdjecia.length})` : ""}`}>
          <button style={btnGhost} onClick={() => photoInputRef.current?.click()}>+ Dodaj zdjęcia</button>
          <input ref={photoInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={dodajZdjecia} />
          {form.zdjecia.length === 0 && (
            <p style={{ color: C.szary, fontSize: 13, marginTop: 12 }}>Brak zdjęć. Dodaj dowolną liczbę — w PDF pojawią się jedno pod drugim, na całą szerokość.</p>
          )}
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            {form.zdjecia.map((z, i) => (
              <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: 12, background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 6 }}>
                <img src={z.dataUrl} alt="" style={{ width: 160, height: 120, objectFit: "contain", background: C.jasny, borderRadius: 4, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <input style={{ ...inp, marginBottom: 8 }} value={z.opis} onChange={(e) => opisZdjecia(i, e.target.value)} placeholder="Podpis zdjęcia (opcjonalnie)" />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={miniBtn} onClick={() => przesunZdjecie(i, -1)} disabled={i === 0}>↑</button>
                    <button style={miniBtn} onClick={() => przesunZdjecie(i, 1)} disabled={i === form.zdjecia.length - 1}>↓</button>
                    <button style={{ ...miniBtn, color: "#B22", borderColor: "#E0B4B4" }} onClick={() => usunZdjecie(i)}>Usuń</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Sekcja>

        {/* Podsumowanie */}
        <Sekcja tytul="Podsumowanie (wymagany wybór)">
          {PODSUMOWANIE_OPCJE.map((opt) => (
            <label key={opt} style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 14, cursor: "pointer", alignItems: "flex-start" }}>
              <input type="radio" name="podsum" checked={form.podsumowanie === opt} onChange={() => upd("podsumowanie", opt)} style={{ marginTop: 3, accentColor: C.czarny }} />
              <span>{opt}</span>
            </label>
          ))}
        </Sekcja>

      </main>

      {/* Dolny pasek akcji */}
      <footer style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.bialy, borderTop: `1px solid ${C.linia}`, boxShadow: "0 -2px 10px rgba(0,0,0,0.05)", zIndex: 20 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: C.szary, maxWidth: 460, lineHeight: 1.45 }}>
            {zapisanyId
              ? "Raport zapisany — kolejny zapis nadpisze (aktualizacja)"
              : <>Po zapisaniu możesz <strong>edytować raport przez 24h</strong> — z poziomu archiwum raportów (przycisk „Edytuj”).</>}
          </span>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={btnGhost} onClick={zapiszArchiwum} disabled={zapisywanie}>
              {zapisywanie ? "Zapisywanie…" : zapisanyId ? "Aktualizuj raport" : "Zapisz raport w bazie"}
            </button>
            <button style={btnPrimary} onClick={generujPDF}>Generuj raport →</button>
          </div>
        </div>
      </footer>

      {toast && (
        <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: C.czarny, color: C.bialy, padding: "12px 22px", borderRadius: 8, fontSize: 14, zIndex: 50, boxShadow: "0 4px 20px rgba(0,0,0,0.25)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ---------- EKRAN LOGOWANIA / REJESTRACJI -------------------------------- */
function EkranLogowania({ pokazToast }) {
  const [tryb, setTryb] = useState("login"); // login | rejestracja | reset
  const [email, setEmail] = useState("");
  const [haslo, setHaslo] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  async function submit() {
    setInfo("");
    if (!email.trim()) { setInfo("Podaj adres e-mail."); return; }
    if (tryb !== "reset" && haslo.length < 6) { setInfo("Hasło musi mieć min. 6 znaków."); return; }
    setBusy(true);
    try {
      if (tryb === "login") {
        await zaloguj(email.trim(), haslo);
        // onAuthStateChange w komponencie głównym przejmie dalej
      } else if (tryb === "rejestracja") {
        await zarejestruj(email.trim(), haslo);
        setInfo("Konto utworzone. Sprawdź e-mail i kliknij link aktywacyjny, a następnie zaloguj się.");
        setTryb("login");
      } else if (tryb === "reset") {
        await resetHasla(email.trim());
        setInfo("Jeśli konto istnieje, wysłaliśmy link do resetu hasła na podany e-mail.");
      }
    } catch (e) {
      console.error(e);
      const m = String(e?.message || "");
      if (m.includes("Invalid login")) setInfo("Błędny e-mail lub hasło.");
      else if (m.includes("Email not confirmed")) setInfo("Potwierdź najpierw adres e-mail (link aktywacyjny).");
      else if (m.includes("already registered")) setInfo("Ten e-mail jest już zarejestrowany — zaloguj się.");
      else setInfo("Wystąpił błąd. Spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  }

  const tytul = tryb === "login" ? "Zaloguj się" : tryb === "rejestracja" ? "Załóż konto" : "Reset hasła";

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.czarny, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: 20 }}>
      <style>{globalCSS}</style>
      <div style={{ width: "100%", maxWidth: 400, background: C.bialy, borderRadius: 12, padding: 32, boxShadow: "0 8px 40px rgba(0,0,0,0.4)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 6 }}>
          <span style={{ color: C.zolty, fontWeight: 800, fontSize: 28 }}>/</span>
          <span style={{ color: C.czarny, fontWeight: 800, fontSize: 26 }}>Abyard</span>
        </div>
        <div style={{ color: C.szary, fontSize: 13, marginBottom: 24 }}>Generator raportów z budowy</div>

        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 18 }}>{tytul}</div>

        <label style={lbl}>E-mail</label>
        <input style={{ ...inp, marginBottom: 14 }} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="np. jkowalski@abyard.pl" autoComplete="username" />

        {tryb !== "reset" && (
          <>
            <label style={lbl}>Hasło</label>
            <input
              style={{ ...inp, marginBottom: 14 }}
              type="password"
              value={haslo}
              onChange={(e) => setHaslo(e.target.value)}
              placeholder="min. 6 znaków"
              autoComplete={tryb === "login" ? "current-password" : "new-password"}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </>
        )}

        {info && (
          <div style={{ fontSize: 13, color: info.includes("błąd") || info.includes("Błędny") || info.includes("Podaj") || info.includes("Hasło musi") ? "#B22" : "#1B7A3D", marginBottom: 14, lineHeight: 1.4 }}>
            {info}
          </div>
        )}

        <button onClick={submit} disabled={busy} style={{ ...btnPrimary, width: "100%", padding: "12px", marginBottom: 14, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Proszę czekać…" : tytul}
        </button>

        <div style={{ fontSize: 13, color: C.szary, textAlign: "center", lineHeight: 1.8 }}>
          {tryb === "login" && (
            <>
              <span onClick={() => { setTryb("rejestracja"); setInfo(""); }} style={linkStyl}>Załóż konto</span>
              {" · "}
              <span onClick={() => { setTryb("reset"); setInfo(""); }} style={linkStyl}>Nie pamiętam hasła</span>
            </>
          )}
          {tryb === "rejestracja" && (
            <span onClick={() => { setTryb("login"); setInfo(""); }} style={linkStyl}>Mam już konto — zaloguj się</span>
          )}
          {tryb === "reset" && (
            <span onClick={() => { setTryb("login"); setInfo(""); }} style={linkStyl}>← Wróć do logowania</span>
          )}
        </div>
      </div>
    </div>
  );
}
const linkStyl = { color: "#1668C7", cursor: "pointer", textDecoration: "underline" };

/* ---------- PANEL ADMINISTRATORA ----------------------------------------- */
function PanelAdmina({ pokazToast, email, onForm, onArchiwum, onKoordynacja, onWyloguj }) {
  const [uzytkownicy, setUzytkownicy] = useState([]);
  const [projektyAll, setProjektyAll] = useState([]); // wszystkie aktywne
  const [przypisania, setPrzypisania] = useState([]);
  const [zakresy, setZakresy] = useState([]);
  const [terminyDomyslne, setTerminyDomyslne] = useState({});
  const [nieaktywne, setNieaktywne] = useState([]);
  const [ladowanie, setLadowanie] = useState(true);
  const [nowaBudowa, setNowaBudowa] = useState("");
  const [wybranyPM, setWybranyPM] = useState("");
  const [zakladka, setZakladka] = useState("zarzadzanie"); // zarzadzanie | koordynacja

  async function wczytaj() {
    setLadowanie(true);
    try {
      const [u, p, prz, zak, term, nieakt] = await Promise.all([
        listaUzytkownikow(),
        listaAktywnychProjektow(),
        listaPrzypisan(),
        listaZakresow(),
        terminyZHarmonogramu(),
        listaNieaktywnychProjektow(),
      ]);
      setUzytkownicy(u);
      setProjektyAll(p);
      setPrzypisania(prz);
      setZakresy(zak);
      setTerminyDomyslne(term);
      setNieaktywne(nieakt);
      if (!wybranyPM && u.length) setWybranyPM(u[0].id);
    } catch (e) {
      console.error(e);
      pokazToast("Błąd wczytywania danych panelu");
    } finally {
      setLadowanie(false);
    }
  }
  useEffect(() => { wczytaj(); /* eslint-disable-next-line */ }, []);

  async function utworzBudowe() {
    const nazwa = nowaBudowa.trim();
    if (!nazwa) return;
    try {
      await dodajProjekt(nazwa);
      setNowaBudowa("");
      pokazToast(`Dodano inwestycję „${nazwa}”`);
      wczytaj();
    } catch (e) {
      console.error(e);
      pokazToast(String(e?.message || "").includes("duplicate") ? "Taka budowa już istnieje" : "Błąd dodawania budowy");
    }
  }

  async function przelaczRole(u) {
    const nowa = u.rola === "admin" ? "pm" : "admin";
    try {
      await ustawRole(u.id, nowa);
      pokazToast(`${u.email}: rola → ${nowa}`);
      wczytaj();
    } catch (e) {
      console.error(e);
      pokazToast("Błąd zmiany roli");
    }
  }

  async function zapiszImie(uzytkownikId, wartosc) {
    try {
      await ustawDanePM(uzytkownikId, { imie_nazwisko: wartosc.trim() || null });
      wczytaj();
    } catch (e) {
      console.error(e);
      pokazToast("Błąd zapisu imienia i nazwiska");
    }
  }

  async function przelaczPrzypisanie(projektId) {
    if (!wybranyPM) return;
    const istn = przypisania.find((p) => p.uzytkownik === wybranyPM && p.projekt_id === projektId);
    try {
      if (istn) {
        await usunPrzypisanie(istn.id);
      } else {
        await dodajPrzypisanie(wybranyPM, projektId);
      }
      wczytaj();
    } catch (e) {
      console.error(e);
      pokazToast("Błąd zmiany przypisania");
    }
  }

  const przypisaniaWybranego = new Set(
    przypisania.filter((p) => p.uzytkownik === wybranyPM).map((p) => p.projekt_id)
  );

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: C.jasny, minHeight: "100vh", color: C.czarny }}>
      <style>{globalCSS}</style>
      <PasekNawigacji
        aktywny="admin"
        jestAdmin={true}
        email={email}
        onForm={onForm}
        onArchiwum={onArchiwum}
        onKoordynacja={onKoordynacja}
        onAdmin={() => {}}
        onWyloguj={onWyloguj}
      />

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 80px" }}>
        {/* Zakładki panelu + odśwież */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 22, borderBottom: `2px solid ${C.linia}` }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[["zarzadzanie", "Zarządzanie"], ["koordynacja", "Koordynacja PM"]].map(([kod, et]) => (
              <button key={kod} onClick={() => setZakladka(kod)}
                style={{ border: "none", background: "transparent", padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer",
                  color: zakladka === kod ? C.czarny : C.szary,
                  borderBottom: zakladka === kod ? `3px solid ${C.zolty}` : "3px solid transparent", marginBottom: -2 }}>
                {et}
              </button>
            ))}
          </div>
          <button onClick={async () => { await wczytaj(); pokazToast("Odświeżono dane"); }}
            style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 6, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 6, color: C.czarny }}>
            ↻ Odśwież
          </button>
        </div>
        {ladowanie ? (
          <div style={{ textAlign: "center", padding: 40, color: C.szary }}>Wczytywanie…</div>
        ) : zakladka === "koordynacja" ? (
          <ZakladkaKoordynacja
            uzytkownicy={uzytkownicy} projektyAll={projektyAll} przypisania={przypisania} zakresy={zakresy}
            terminyDomyslne={terminyDomyslne} nieaktywne={nieaktywne}
            pokazToast={pokazToast} odswiez={wczytaj}
          />
        ) : (
          <></>
        )}
        {ladowanie || zakladka !== "zarzadzanie" ? null : (
          <>
            {/* Użytkownicy i role */}
            <section style={card}>
              <div style={secTitle}>Użytkownicy i role</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${C.linia}` }}>
                    <th style={{ textAlign: "left", padding: "8px 10px", color: C.szary, fontSize: 11, textTransform: "uppercase" }}>Imię i nazwisko</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", color: C.szary, fontSize: 11, textTransform: "uppercase" }}>E-mail</th>
                    <th style={{ textAlign: "center", padding: "8px 10px", color: C.szary, fontSize: 11, textTransform: "uppercase" }}>Rola</th>
                    <th style={{ textAlign: "right", padding: "8px 10px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {uzytkownicy.map((u) => (
                    <tr key={u.id} style={{ borderBottom: `1px solid ${C.linia}` }}>
                      <td style={{ padding: "8px 10px" }}>
                        <input type="text" defaultValue={u.imie_nazwisko || ""} placeholder="—"
                          onBlur={(e) => zapiszImie(u.id, e.target.value)}
                          style={{ width: "100%", padding: "6px 8px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13.5 }} />
                      </td>
                      <td style={{ padding: "10px", color: C.szary, fontSize: 12.5 }}>{u.email}</td>
                      <td style={{ padding: "10px", textAlign: "center" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 12, color: u.rola === "admin" ? C.czarny : C.szary, background: u.rola === "admin" ? C.zolty : C.jasny }}>
                          {u.rola === "admin" ? "ADMIN" : "PM"}
                        </span>
                      </td>
                      <td style={{ padding: "10px", textAlign: "right" }}>
                        <button style={miniBtn} onClick={() => przelaczRole(u)}>
                          {u.rola === "admin" ? "Cofnij admina" : "Nadaj admina"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* Przypisania PM -> inwestycje */}
            <section style={card}>
              <div style={secTitle}>Przypisania PM do inwestycji</div>
              <p style={{ color: C.szary, fontSize: 13, marginTop: -6, marginBottom: 14 }}>
                Wybierz użytkownika, a następnie zaznacz budowy, dla których ma móc tworzyć raporty. Administrator ma dostęp do wszystkich budów niezależnie od przypisań.
              </p>
              <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", paddingBottom: 16, borderBottom: `1px solid ${C.linia}` }}>
                <input style={{ ...inp, flex: "1 1 280px" }} value={nowaBudowa} onChange={(e) => setNowaBudowa(e.target.value)} placeholder="Nazwa nowej inwestycji" onKeyDown={(e) => { if (e.key === "Enter") utworzBudowe(); }} />
                <button style={btnPrimary} onClick={utworzBudowe}>+ Dodaj inwestycję</button>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={lbl}>Użytkownik</label>
                <select style={inp} value={wybranyPM} onChange={(e) => setWybranyPM(e.target.value)}>
                  {uzytkownicy.map((u) => (
                    <option key={u.id} value={u.id}>{nazwaOsoby(u)}{u.rola === "admin" ? " (admin)" : ""}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                {projektyAll.map((p) => {
                  const zazn = przypisaniaWybranego.has(p.id);
                  return (
                    <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1px solid ${zazn ? C.zolty : C.linia}`, borderRadius: 6, cursor: "pointer", background: zazn ? C.zoltyJasny : C.bialy }}>
                      <input type="checkbox" checked={zazn} onChange={() => przelaczPrzypisanie(p.id)} />
                      <span style={{ fontSize: 13 }}>{p.nazwa}</span>
                    </label>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- KOMPAKTOWA LISTA INWESTYCJI (koordynacja) -------------------- */
function KompaktowaListaInwestycji({ projekty, przypisania, zakresy, zakresMap, uzytMap, terminyDomyslne, punktyLok, setPunktyLok, zapiszPunkty, zapiszZakres, zapiszTermin, zakonczInwestycje }) {
  const [otwarty, setOtwarty] = React.useState(null);
  const th = { textAlign: "left", padding: "7px 10px", color: C.szary, fontSize: 11, textTransform: "uppercase", letterSpacing: .5, borderBottom: `2px solid ${C.linia}` };
  const td = { padding: "6px 10px", borderBottom: `1px solid ${C.jasny}`, fontSize: 13 };
  const numInp = { width: 60, padding: "5px 7px", border: `1px solid ${C.linia}`, borderRadius: 5, fontSize: 13, textAlign: "center" };

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={th}>Inwestycja</th>
          <th style={{ ...th, width: 150 }}>Zakres</th>
          <th style={{ ...th, width: 150 }}>Termin</th>
          <th style={{ ...th, width: 70, textAlign: "center" }}>PM</th>
          <th style={{ ...th, width: 90 }}></th>
        </tr>
      </thead>
      <tbody>
        {projekty.map((p) => {
          const przypP = przypisania.filter((x) => x.projekt_id === p.id);
          const zk = zakresMap[p.zakres];
          const auto = terminyDomyslne?.[p.id] || "";
          const reczny = p.termin_zakonczenia || "";
          const wartosc = reczny || auto;
          const zAuto = !reczny && !!auto;
          const otw = otwarty === p.id;
          return (
            <React.Fragment key={p.id}>
              <tr style={{ background: otw ? C.jasny : "transparent" }}>
                <td style={{ ...td, fontWeight: 700, cursor: "pointer" }} onClick={() => setOtwarty(otw ? null : p.id)}>
                  <span style={{ color: C.szary, marginRight: 6, fontSize: 11 }}>{otw ? "▼" : "▶"}</span>{p.nazwa}
                </td>
                <td style={td}>
                  <select value={p.zakres || ""} onChange={(e) => zapiszZakres(p.id, e.target.value)}
                    style={{ padding: "5px 7px", border: `1px solid ${C.linia}`, borderRadius: 5, fontSize: 12.5, width: "100%" }}>
                    <option value="">— brak —</option>
                    {zakresy.map((z) => <option key={z.kod} value={z.kod}>{z.nazwa}</option>)}
                  </select>
                </td>
                <td style={td}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <input type="date" defaultValue={wartosc} onBlur={(e) => zapiszTermin(p.id, e.target.value)}
                      title={zAuto ? "Termin z harmonogramu — zapisz, by ustawić na stałe" : ""}
                      style={{ padding: "4px 6px", border: `1px solid ${zAuto ? C.zolty : C.linia}`, borderRadius: 5, fontSize: 12, background: zAuto ? "#FFFDF5" : C.bialy, width: "100%" }} />
                    {zAuto && <span style={{ fontSize: 9, color: "#B8860B", fontWeight: 700 }}>AUTO</span>}
                  </span>
                </td>
                <td style={{ ...td, textAlign: "center", color: przypP.length ? C.czarny : C.szary }}>{przypP.length || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button onClick={() => zakonczInwestycje(p.id, p.nazwa)} title="Oznacz jako zakończoną"
                    style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 5, padding: "4px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer", color: C.szary }}>
                    ✓ Zakończ
                  </button>
                </td>
              </tr>
              {otw && (
                <tr>
                  <td colSpan={5} style={{ padding: "0 10px 12px 30px", background: C.jasny }}>
                    {przypP.length === 0 ? (
                      <div style={{ fontSize: 12, color: C.szary, fontStyle: "italic", padding: "8px 0" }}>
                        brak przypisanych kierowników — dodaj ich w zakładce „Zarządzanie"
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: 8 }}>
                        {przypP.map((x) => {
                          const u = uzytMap[x.uzytkownik];
                          const val = punktyLok[x.id] !== undefined ? punktyLok[x.id] : (x.punkty ?? "");
                          return (
                            <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <span style={{ flex: "1 1 auto", fontSize: 13 }}>{nazwaOsoby(u)}</span>
                              <input type="number" min="0" step="0.5" value={val} placeholder={zk ? String(zk.punkty) : "—"}
                                onChange={(e) => setPunktyLok((s) => ({ ...s, [x.id]: e.target.value }))}
                                onBlur={(e) => zapiszPunkty(x.id, e.target.value)} style={numInp} />
                              <span style={{ fontSize: 11.5, color: C.szary, width: 26 }}>pkt</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------- ZAKŁADKA KOORDYNACJA PM (panel admina) ----------------------- */
function ZakladkaKoordynacja({ uzytkownicy, projektyAll, przypisania, zakresy, terminyDomyslne, nieaktywne, pokazToast, odswiez }) {
  // lokalny stan edycji (żeby pola reagowały płynnie); zapis do bazy on-blur
  const [punktyLok, setPunktyLok] = React.useState({});   // przypisanieId -> wartość
  const [pmLok, setPmLok] = React.useState({});           // uzytkownikId -> {pojemnosc, inne_obowiazki}
  const zakresMap = React.useMemo(() => Object.fromEntries(zakresy.map((z) => [z.kod, z])), [zakresy]);
  const uzytMap = React.useMemo(() => Object.fromEntries(uzytkownicy.map((u) => [u.id, u])), [uzytkownicy]);

  // Tylko konta z co najmniej jednym przypisaniem — reguła widoczności w koordynacji
  const idZPrzypisaniem = React.useMemo(
    () => new Set(przypisania.map((p) => p.uzytkownik)), [przypisania]
  );
  const kierownicy = uzytkownicy.filter((u) => idZPrzypisaniem.has(u.id));

  // --- WIDOK ANALIZY: horyzont czasu + szukajka inwestycji ---
  const [horyzont, setHoryzont] = React.useState(0); // 0/30/60/90 dni
  const [szukaj, setSzukaj] = React.useState("");
  const projektMap = React.useMemo(() => Object.fromEntries(projektyAll.map((p) => [p.id, p])), [projektyAll]);

  // Efektywny termin inwestycji: ręczny (termin_zakonczenia) albo dociągnięty z harmonogramu.
  function terminProjektu(p) {
    return (p.termin_zakonczenia) || (terminyDomyslne?.[p.id]) || null;
  }

  // Obciążenie per kierownik dla wybranego horyzontu.
  // Inwestycja "schodzi", gdy jej termin < granica (dziś + horyzont). Inne obowiązki stałe.
  const analiza = React.useMemo(() => {
    const granica = new Date();
    granica.setHours(0, 0, 0, 0);
    granica.setDate(granica.getDate() + horyzont);
    const wynik = kierownicy.map((u) => {
      const mojePrzyp = przypisania.filter((x) => x.uzytkownik === u.id);
      const tematy = [];
      let pkt = 0;
      for (const x of mojePrzyp) {
        const p = projektMap[x.projekt_id];
        if (!p) continue; // inwestycja nieaktywna/zakończona — pomijamy
        const termin = terminProjektu(p);
        const schodzi = termin ? new Date(termin + "T00:00:00") < granica : false;
        const punkty = x.punkty != null ? Number(x.punkty) : (zakresMap[p.zakres]?.punkty || 0);
        if (!schodzi) pkt += punkty;
        tematy.push({ nazwa: p.nazwa, zakres: p.zakres, punkty, termin, schodzi });
      }
      const inne = Number(u.inne_obowiazki || 0);
      const razem = pkt + inne;
      const poj = Number(u.pojemnosc || 20);
      const proc = poj > 0 ? Math.round(razem / poj * 100) : 0;
      tematy.sort((a, b) => (a.schodzi - b.schodzi) || (b.punkty - a.punkty));
      return { u, tematy, pkt, inne, razem, poj, proc };
    });
    wynik.sort((a, b) => b.proc - a.proc);
    return wynik;
  }, [kierownicy, przypisania, projektMap, terminyDomyslne, zakresMap, horyzont]);

  const [rozwiniety, setRozwiniety] = React.useState(null); // id kierownika z rozwiniętymi tematami
  function kolorProc(p) { return p > 100 ? C.czerwony : p >= 80 ? "#D98A00" : "#1B7A3D"; }
  function stanProc(p) { return p > 100 ? ["przeciążony", C.czerwony, "#FBE6E6"] : p >= 80 ? ["pełne obłożenie", "#D98A00", "#FBF0DC"] : ["ma zapas", "#1B7A3D", "#E4F4E9"]; }

  // Inwestycje przefiltrowane szukajką (do sekcji edycji)
  const projektyWidoczne = React.useMemo(() => {
    const q = szukaj.trim().toLowerCase();
    if (!q) return projektyAll;
    return projektyAll.filter((p) => p.nazwa.toLowerCase().includes(q));
  }, [projektyAll, szukaj]);

  async function zapiszPunkty(przypisanieId, wartosc) {
    try { await ustawPunktyPrzypisania(przypisanieId, wartosc); }
    catch (e) { console.error(e); pokazToast("Błąd zapisu punktów"); }
  }
  async function zapiszZakres(projektId, kod) {
    try { await ustawKoordynacjeProjektu(projektId, { zakres: kod || null }); odswiez(); }
    catch (e) { console.error(e); pokazToast("Błąd zapisu zakresu"); }
  }
  async function zapiszTermin(projektId, data) {
    try { await ustawKoordynacjeProjektu(projektId, { termin_zakonczenia: data || null }); }
    catch (e) { console.error(e); pokazToast("Błąd zapisu terminu"); }
  }
  async function zapiszPM(uzytkownikId, pola) {
    try { await ustawDanePM(uzytkownikId, pola); }
    catch (e) { console.error(e); pokazToast("Błąd zapisu danych kierownika"); }
  }
  async function zakonczInwestycje(projektId, nazwa) {
    if (!window.confirm(`Oznaczyć „${nazwa}" jako zakończoną?\n\nZniknie z listy przypisań i z koordynacji. Możesz ją przywrócić w sekcji „Zakończone".`)) return;
    try { await ustawAktywnoscProjektu(projektId, false); odswiez(); pokazToast(`„${nazwa}" przeniesiona do zakończonych`); }
    catch (e) { console.error(e); pokazToast("Błąd archiwizacji inwestycji"); }
  }
  async function przywrocInwestycje(projektId, nazwa) {
    try { await ustawAktywnoscProjektu(projektId, true); odswiez(); pokazToast(`„${nazwa}" przywrócona`); }
    catch (e) { console.error(e); pokazToast("Błąd przywracania inwestycji"); }
  }

  const th = { textAlign: "left", padding: "8px 10px", color: C.szary, fontSize: 11, textTransform: "uppercase", letterSpacing: .5 };
  const td = { padding: "8px 10px", borderBottom: `1px solid ${C.jasny}`, fontSize: 13.5 };
  const numInp = { width: 70, padding: "6px 8px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, textAlign: "center" };

  return (
    <>
      {/* SEKCJA ANALIZY — OBCIĄŻENIE ZESPOŁU (na górze) */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div style={secTitle}>Obciążenie zespołu</div>
          <div style={{ display: "flex", border: `1px solid ${C.linia}`, borderRadius: 8, overflow: "hidden" }}>
            {[[0, "Dziś"], [30, "Za miesiąc"], [60, "Za 2 msc"], [90, "Za 3 msc"]].map(([d, et]) => (
              <button key={d} onClick={() => setHoryzont(d)}
                style={{ border: "none", background: horyzont === d ? C.czarny : C.bialy, color: horyzont === d ? C.bialy : C.czarny,
                  padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRight: `1px solid ${C.linia}` }}>
                {et}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: C.szary, marginBottom: 14 }}>
          <span>● <span style={{ color: "#1B7A3D" }}>do 80%</span> zapas</span>
          <span>● <span style={{ color: "#D98A00" }}>80–100%</span> pełne</span>
          <span>● <span style={{ color: C.czerwony }}>ponad 100%</span> przeciążenie</span>
        </div>
        {analiza.length === 0 ? (
          <div style={{ color: C.szary, fontSize: 13, fontStyle: "italic" }}>Brak kierowników z przypisanymi inwestycjami.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {analiza.map((a) => {
              const [st, stCol, stBg] = stanProc(a.proc);
              const szer = Math.min(a.proc, 100);
              const otw = rozwiniety === a.u.id;
              return (
                <div key={a.u.id} style={{ border: `1px solid ${C.linia}`, borderRadius: 8, padding: "10px 14px", background: C.bialy, cursor: "pointer" }}
                  onClick={() => setRozwiniety(otw ? null : a.u.id)}>
                  <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 110px", gap: 14, alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{nazwaOsoby(a.u)}</div>
                      <div style={{ fontSize: 11.5, color: C.szary, marginTop: 1 }}>{a.tematy.filter((t) => !t.schodzi).length} akt. · {a.razem} pkt{a.inne > 0 ? ` (w tym ${a.inne} inne)` : ""}</div>
                      <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, marginTop: 3, color: stCol, background: stBg }}>{st}</span>
                    </div>
                    <div style={{ position: "relative", height: 24, background: C.jasny, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.linia}` }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(szer, 2)}%`, background: kolorProc(a.proc) }} />
                      <div style={{ position: "absolute", left: "100%", top: -2, bottom: -2, width: 2, background: C.czarny, opacity: .3 }} />
                      <div style={{ position: "absolute", right: 8, top: 0, bottom: 0, display: "flex", alignItems: "center", fontSize: 11.5, fontWeight: 700 }}>{a.razem}/{a.poj} pkt</div>
                    </div>
                    <div style={{ textAlign: "right", fontWeight: 800, fontSize: 19, color: kolorProc(a.proc) }}>{a.proc}%</div>
                  </div>
                  {otw && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.linia}` }}>
                      {a.tematy.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: C.szary }}>Brak inwestycji.</div>
                      ) : a.tematy.map((t, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", opacity: t.schodzi ? .45 : 1 }}>
                          <span style={{ textDecoration: t.schodzi ? "line-through" : "none" }}>
                            {t.nazwa} <span style={{ fontSize: 10.5, color: C.szary, background: C.jasny, padding: "1px 6px", borderRadius: 4 }}>{zakresMap[t.zakres]?.nazwa || "—"}</span>
                          </span>
                          <span style={{ color: C.szary }}>{t.termin ? `do ${fmtPL(t.termin)}` : "bez terminu"} · <b style={{ color: C.czarny }}>{t.punkty} pkt</b>{t.schodzi ? " — zejdzie" : ""}</span>
                        </div>
                      ))}
                      {a.inne > 0 && <div style={{ fontSize: 12.5, padding: "3px 0", color: C.szary }}>Inne obowiązki · <b style={{ color: C.czarny }}>{a.inne} pkt</b></div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* SEKCJA 1 — INWESTYCJE: zakres, termin, punkty per PM */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={secTitle}>Inwestycje — zakres i punkty PM</div>
          <input type="text" value={szukaj} onChange={(e) => setSzukaj(e.target.value)} placeholder="Szukaj inwestycji…"
            style={{ padding: "7px 11px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, width: 220 }} />
        </div>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: -2, marginBottom: 14, lineHeight: 1.5 }}>
          Kliknij inwestycję, aby rozwinąć punkty kierowników. Termin „auto" pochodzi z harmonogramu.
        </p>
        <KompaktowaListaInwestycji
          projekty={projektyWidoczne} przypisania={przypisania} zakresy={zakresy} zakresMap={zakresMap}
          uzytMap={uzytMap} terminyDomyslne={terminyDomyslne} punktyLok={punktyLok} setPunktyLok={setPunktyLok}
          zapiszPunkty={zapiszPunkty} zapiszZakres={zapiszZakres} zapiszTermin={zapiszTermin} zakonczInwestycje={zakonczInwestycje}
        />
      </section>

      {/* STARY UKŁAD KAFLI — ZASTĄPIONY KOMPAKTOWĄ LISTĄ */}
      {false && (
      <section style={card}>
        <div style={secTitle}>Inwestycje — zakres i punkty PM</div>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
          Ustaw zakres każdej inwestycji (podpowiada punkty) oraz wpisz punkty obciążenia dla każdego przypisanego kierownika.
          Termin zakończenia decyduje, kiedy inwestycja „schodzi" z obciążenia w analizie.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {projektyAll.map((p) => {
            const przypP = przypisania.filter((x) => x.projekt_id === p.id);
            const zk = zakresMap[p.zakres];
            return (
              <div key={p.id} style={{ border: `1px solid ${C.linia}`, borderRadius: 8, padding: "12px 14px", background: C.bialy }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: przypP.length ? 10 : 0 }}>
                  <div style={{ fontWeight: 700, flex: "1 1 200px" }}>{p.nazwa}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label style={{ fontSize: 11, color: C.szary, textTransform: "uppercase" }}>Zakres</label>
                    <select value={p.zakres || ""} onChange={(e) => zapiszZakres(p.id, e.target.value)}
                      style={{ padding: "6px 8px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13 }}>
                      <option value="">— brak —</option>
                      {zakresy.map((z) => <option key={z.kod} value={z.kod}>{z.nazwa}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <label style={{ fontSize: 11, color: C.szary, textTransform: "uppercase" }}>Termin</label>
                    {(() => {
                      const auto = terminyDomyslne?.[p.id] || "";
                      const reczny = p.termin_zakonczenia || "";
                      // wartość pola: ręczny ma pierwszeństwo, inaczej auto z harmonogramu
                      const wartosc = reczny || auto;
                      const zAuto = !reczny && !!auto;
                      return (
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="date" defaultValue={wartosc}
                            onBlur={(e) => zapiszTermin(p.id, e.target.value)}
                            title={zAuto ? "Termin dociągnięty z harmonogramu — zapisz, by ustawić na stałe, lub zmień ręcznie" : ""}
                            style={{ padding: "6px 8px", border: `1px solid ${zAuto ? C.zolty : C.linia}`, borderRadius: 6, fontSize: 13,
                              background: zAuto ? "#FFFDF5" : C.bialy }} />
                          {zAuto && <span style={{ fontSize: 10, color: "#B8860B", fontWeight: 700, textTransform: "uppercase" }}>auto</span>}
                        </span>
                      );
                    })()}
                  </div>
                  <button onClick={() => zakonczInwestycje(p.id, p.nazwa)} title="Oznacz jako zakończoną (przenosi do archiwum)"
                    style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: C.szary }}>
                    ✓ Zakończona
                  </button>
                </div>
                {przypP.length > 0 && (
                  <div style={{ borderTop: `1px dashed ${C.linia}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {przypP.map((x) => {
                      const u = uzytMap[x.uzytkownik];
                      const val = punktyLok[x.id] !== undefined ? punktyLok[x.id] : (x.punkty ?? "");
                      return (
                        <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ flex: "1 1 auto", fontSize: 13.5 }}>{nazwaOsoby(u)}</span>
                          <input type="number" min="0" step="0.5" value={val}
                            placeholder={zk ? String(zk.punkty) : "—"}
                            onChange={(e) => setPunktyLok((s) => ({ ...s, [x.id]: e.target.value }))}
                            onBlur={(e) => zapiszPunkty(x.id, e.target.value)}
                            style={numInp} />
                          <span style={{ fontSize: 12, color: C.szary, width: 30 }}>pkt</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {przypP.length === 0 && (
                  <div style={{ fontSize: 12, color: C.szary, fontStyle: "italic", marginTop: 4 }}>
                    brak przypisanych kierowników — dodaj ich w zakładce „Zarządzanie"
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      )}

      {/* SEKCJA 2 — KIEROWNICY: pojemność, inne obowiązki */}
      <section style={card}>
        <div style={secTitle}>Kierownicy — pojemność i inne obowiązki</div>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
          Pojemność to punkty odpowiadające pełnemu obłożeniu (100%). „Inne obowiązki" to punkty za zadania spoza inwestycji
          (gwarancje, usterki itp.). Widoczni są tylko kierownicy z przypisanymi inwestycjami.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${C.linia}` }}>
              <th style={th}>Kierownik</th>
              <th style={{ ...th, textAlign: "center" }}>Pojemność</th>
              <th style={{ ...th, textAlign: "center" }}>Inne obowiązki</th>
            </tr>
          </thead>
          <tbody>
            {kierownicy.map((u) => {
              const lok = pmLok[u.id] || {};
              const poj = lok.pojemnosc !== undefined ? lok.pojemnosc : (u.pojemnosc ?? 20);
              const inne = lok.inne_obowiazki !== undefined ? lok.inne_obowiazki : (u.inne_obowiazki ?? 0);
              return (
                <tr key={u.id}>
                  <td style={td}>{nazwaOsoby(u)}{u.rola === "admin" ? <span style={{ fontSize: 10, color: C.szary }}> (admin)</span> : ""}</td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input type="number" min="1" step="1" value={poj}
                      onChange={(e) => setPmLok((s) => ({ ...s, [u.id]: { ...s[u.id], pojemnosc: e.target.value } }))}
                      onBlur={(e) => zapiszPM(u.id, { pojemnosc: Number(e.target.value) || 20 })}
                      style={numInp} />
                  </td>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input type="number" min="0" step="0.5" value={inne}
                      onChange={(e) => setPmLok((s) => ({ ...s, [u.id]: { ...s[u.id], inne_obowiazki: e.target.value } }))}
                      onBlur={(e) => zapiszPM(u.id, { inne_obowiazki: Number(e.target.value) || 0 })}
                      style={numInp} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* SEKCJA 3 — ZAKOŃCZONE (archiwum inwestycji) */}
      {nieaktywne && nieaktywne.length > 0 && (
        <section style={card}>
          <div style={secTitle}>Zakończone inwestycje</div>
          <p style={{ fontSize: 12.5, color: C.szary, marginTop: -6, marginBottom: 16, lineHeight: 1.5 }}>
            Inwestycje oznaczone jako zakończone. Nie liczą się do obciążenia i nie pojawiają się w przypisaniach.
            Możesz je przywrócić.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {nieaktywne.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", border: `1px solid ${C.linia}`, borderRadius: 6, background: C.jasny }}>
                <span style={{ fontSize: 13.5, color: C.szary }}>{p.nazwa}</span>
                <button onClick={() => przywrocInwestycje(p.id, p.nazwa)}
                  style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  ↩ Przywróć
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/* ---------- ARCHIWUM ----------------------------------------------------- */
/* ---------- WIDOK "KTO CO PROWADZI" (dla wszystkich zalogowanych) --------- */
function WidokKtoCoProwadzi({ jestAdmin, email, onForm, onArchiwum, onAdmin, onWyloguj }) {
  const [ladowanie, setLadowanie] = React.useState(true);
  const [grupy, setGrupy] = React.useState([]);          // po PM
  const [wgInwestycji, setWgInwestycji] = React.useState([]); // po inwestycji
  const [tryb, setTryb] = React.useState("pm");          // "pm" | "inwestycje"
  const [blad, setBlad] = React.useState("");

  React.useEffect(() => {
    (async () => {
      try {
        const [uzyt, przyp, projekty, terminy] = await Promise.all([
          listaUzytkownikow(),
          listaPrzypisan(),
          listaAktywnychProjektow(),
          terminyZHarmonogramu(),
        ]);
        const uzytMap = Object.fromEntries(uzyt.map((u) => [u.id, u]));
        const projMap = Object.fromEntries(projekty.map((p) => [p.id, p]));

        // --- Grupowanie 1: po użytkowniku (tylko aktywne inwestycje) ---
        const wg = {};
        for (const x of przyp) {
          const p = projMap[x.projekt_id];
          if (!p) continue; // nieaktywna/zakończona
          const termin = (p.termin_zakonczenia) || (terminy?.[p.id]) || null;
          (wg[x.uzytkownik] ||= []).push({ nazwa: p.nazwa, termin });
        }
        const listaPM = Object.entries(wg)
          .map(([uid, tematy]) => ({
            osoba: nazwaOsoby(uzytMap[uid]),
            tematy: tematy.sort((a, b) => a.nazwa.localeCompare(b.nazwa, "pl")),
          }))
          .filter((g) => g.tematy.length > 0)
          .sort((a, b) => a.osoba.localeCompare(b.osoba, "pl"));
        setGrupy(listaPM);

        // --- Grupowanie 2: po inwestycji (wszystkie aktywne, także bez PM) ---
        // najpierw mapa projekt_id -> [nazwiska PM]
        const pmWgProjektu = {};
        for (const x of przyp) {
          if (!projMap[x.projekt_id]) continue;
          const u = uzytMap[x.uzytkownik];
          (pmWgProjektu[x.projekt_id] ||= []).push(nazwaOsoby(u));
        }
        const listaInw = projekty
          .map((p) => ({
            nazwa: p.nazwa,
            termin: (p.termin_zakonczenia) || (terminy?.[p.id]) || null,
            pmowie: (pmWgProjektu[p.id] || []).sort((a, b) => a.localeCompare(b, "pl")),
          }))
          .sort((a, b) => a.nazwa.localeCompare(b.nazwa, "pl"));
        setWgInwestycji(listaInw);
      } catch (e) {
        console.error(e);
        setBlad("Nie udało się wczytać zestawienia.");
      } finally {
        setLadowanie(false);
      }
    })();
  }, []);

  const th = { textAlign: "left", padding: "9px 12px", color: C.szary, fontSize: 11, textTransform: "uppercase", letterSpacing: .5, borderBottom: `2px solid ${C.linia}` };
  const td = { padding: "9px 12px", borderBottom: `1px solid ${C.jasny}`, fontSize: 13.5 };

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: C.jasny, minHeight: "100vh", color: C.czarny }}>
      <style>{globalCSS}</style>
      <PasekNawigacji
        aktywny="koordynacja-pm"
        jestAdmin={jestAdmin}
        email={email}
        onForm={onForm}
        onArchiwum={onArchiwum}
        onKoordynacja={() => {}}
        onAdmin={onAdmin}
        onWyloguj={onWyloguj}
      />
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 80px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>Kto co prowadzi</h1>

        {/* Przełącznik widoku */}
        <div style={{ display: "flex", border: `1px solid ${C.linia}`, borderRadius: 8, overflow: "hidden", width: "fit-content", marginBottom: 12 }}>
          {[["pm", "Wg kierownika"], ["inwestycje", "Wg inwestycji"]].map(([kod, et]) => (
            <button key={kod} onClick={() => setTryb(kod)}
              style={{ border: "none", background: tryb === kod ? C.czarny : C.bialy, color: tryb === kod ? C.bialy : C.czarny,
                padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRight: kod === "pm" ? `1px solid ${C.linia}` : "none" }}>
              {et}
            </button>
          ))}
        </div>

        <p style={{ color: C.szary, fontSize: 13.5, marginBottom: 22 }}>
          {tryb === "pm"
            ? "Zestawienie kierowników i przypisanych im inwestycji. Data zakończenia pochodzi z harmonogramu (najpóźniejsza z terminów) lub z ręcznego wpisu w panelu koordynacji."
            : "Zestawienie inwestycji i przypisanych do nich kierowników. Data zakończenia pochodzi z harmonogramu (najpóźniejsza z terminów) lub z ręcznego wpisu w panelu koordynacji."}
        </p>

        {ladowanie ? (
          <div style={{ textAlign: "center", padding: 40, color: C.szary }}>Wczytywanie…</div>
        ) : blad ? (
          <div style={{ color: "#B22", fontSize: 14 }}>{blad}</div>
        ) : tryb === "pm" ? (
          grupy.length === 0 ? (
            <div style={{ color: C.szary, fontSize: 14, fontStyle: "italic" }}>Brak przypisanych inwestycji.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {grupy.map((g, i) => (
                <section key={i} style={{ ...card, padding: 0, overflow: "hidden" }}>
                  <div style={{ background: C.grafit, color: C.bialy, padding: "10px 16px", fontWeight: 700, fontSize: 14 }}>
                    {g.osoba} <span style={{ color: C.zolty, fontWeight: 600 }}>· {g.tematy.length}</span>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th}>Inwestycja</th>
                        <th style={{ ...th, width: 180 }}>Data zakończenia</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.tematy.map((t, j) => (
                        <tr key={j}>
                          <td style={td}>{t.nazwa}</td>
                          <td style={{ ...td, color: t.termin ? C.czarny : C.szary }}>{t.termin ? fmtPL(t.termin) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          )
        ) : (
          wgInwestycji.length === 0 ? (
            <div style={{ color: C.szary, fontSize: 14, fontStyle: "italic" }}>Brak aktywnych inwestycji.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {wgInwestycji.map((inw, i) => (
                <section key={i} style={{ ...card, padding: 0, overflow: "hidden" }}>
                  <div style={{ background: C.grafit, color: C.bialy, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{inw.nazwa}</span>
                    <span style={{ fontSize: 12.5, color: inw.termin ? C.zolty : "#C89B3C", fontWeight: 600 }}>
                      {inw.termin ? `zakończenie: ${fmtPL(inw.termin)}` : "brak terminu"}
                    </span>
                  </div>
                  {inw.pmowie.length === 0 ? (
                    <div style={{ padding: "12px 16px", fontSize: 13, color: "#B22", fontStyle: "italic" }}>
                      brak przypisanego kierownika
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr><th style={th}>Kierownik</th></tr>
                      </thead>
                      <tbody>
                        {inw.pmowie.map((osoba, j) => (
                          <tr key={j}><td style={td}>{osoba}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}

/* ---------- ARCHIWUM ----------------------------------------------------- */
function WidokArchiwum({ raporty, ladowanie, filtr, setFiltr, onOdswiez, onOtworz, onEdytuj, onUsun, mozeEdytowac, godzinyDoEdycji, onNowyRaport, jestAdmin, email, onForm, onKoordynacja, onAdmin, onWyloguj }) {
  // Status z podsumowania. Uwaga: obie standardowe formuły zawierają rdzeń "zagroż"
  // ("powoduje zagrożenie" vs "nie powoduje zagrożenia"), więc najpierw wykrywamy
  // przeczenie (brak zagrożenia), a dopiero potem samo zagrożenie.
  function statusZPodsumowania(p) {
    if (!p) return { txt: "—", kolor: C.szary, tlo: "transparent" };
    const t = p.toLowerCase();
    const brakZagrozenia = t.includes("nie powoduje") || t.includes("niezagroż") || t.includes("nie ma zagroż") || t.includes("bez zagroż");
    if (brakZagrozenia) return { txt: "Termin niezagrożony", kolor: "#1B7A3D", tlo: "#E4F4E9" };
    const zagrozenie = t.includes("zagroż") || t.includes("zagroz");
    if (zagrozenie) return { txt: "Zagrożenie terminu", kolor: "#B22", tlo: "#FBE6E6" };
    return { txt: "Termin niezagrożony", kolor: "#1B7A3D", tlo: "#E4F4E9" };
  }

  const lista = raporty || [];
  const budowy = przegladBudow(lista);
  const widoczne = filtr ? lista.filter((r) => r.nazwaProjektu === filtr) : lista;

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: C.jasny, minHeight: "100vh", color: C.czarny }}>
      <style>{globalCSS}</style>

      <PasekNawigacji
        aktywny="archiwum"
        jestAdmin={jestAdmin}
        email={email}
        onForm={onForm}
        onArchiwum={() => {}}
        onKoordynacja={onKoordynacja}
        onAdmin={onAdmin}
        onWyloguj={onWyloguj}
      />
      <div style={{ background: C.grafit, borderBottom: `1px solid ${C.linia}` }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "10px 24px", display: "flex", justifyContent: "flex-end", gap: 12, alignItems: "center" }}>
          <button onClick={onOdswiez} style={btnGhostDark}>Odśwież</button>
          <button onClick={onNowyRaport} style={{ background: C.zolty, color: C.czarny, border: "none", padding: "8px 18px", borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>+ Nowy raport</button>
        </div>
      </div>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 80px" }}>
        {ladowanie && (
          <div style={{ textAlign: "center", padding: 40, color: C.szary }}>Wczytywanie z bazy…</div>
        )}

        {!ladowanie && lista.length === 0 && (
          <div style={{ textAlign: "center", padding: 60, color: C.szary }}>
            <div style={{ fontSize: 16, marginBottom: 8 }}>Brak zapisanych raportów</div>
            <div style={{ fontSize: 13 }}>Gdy zapiszesz pierwszy raport w bazie, pojawi się tutaj.</div>
          </div>
        )}

        {!ladowanie && lista.length > 0 && (
          <>
            {/* 1) Przegląd zbiorczy budów */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14, marginBottom: 28 }}>
              {budowy.map((b) => {
                const st = statusZPodsumowania(b.ostatni?.podsumowanie);
                const aktywny = filtr === b.nazwa;
                return (
                  <div
                    key={b.nazwa}
                    onClick={() => setFiltr(aktywny ? "" : b.nazwa)}
                    style={{
                      background: C.bialy,
                      border: `2px solid ${aktywny ? C.zolty : C.linia}`,
                      borderRadius: 10,
                      padding: 16,
                      cursor: "pointer",
                      transition: "border-color .15s",
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 8 }}>{b.nazwa}</div>
                    <div style={{ fontSize: 13, color: C.szary, marginBottom: 4 }}>
                      Raportów: <strong style={{ color: C.czarny }}>{b.liczba}</strong> · ostatni: <strong style={{ color: C.czarny }}>nr {b.ostatni?.numer}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: C.szary, marginBottom: 10 }}>
                      {b.ostatni?.data_opracowania ? fmtPL(b.ostatni.data_opracowania) : "—"}
                    </div>
                    {(() => {
                      const o = b.ostatni || {};
                      const postep = sredniPostep(o.harmonogram);
                      const opoz = opoznienieInwestycji(o.harmonogram, o.data_opracowania);
                      const komorka = (etykieta, wartosc, kolor) => (
                        <div style={{ flex: "1 1 calc(50% - 4px)", background: C.jasny, borderRadius: 6, padding: "6px 8px" }}>
                          <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: C.szary }}>{etykieta}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: kolor || C.czarny }}>{wartosc}</div>
                        </div>
                      );
                      return (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                          {komorka("Postęp ogólny", postep !== null ? `${postep}%` : "—")}
                          {komorka(
                            "Opóźnienie",
                            opoz === null ? "—" : opoz.dni > 0 ? `${opoz.dni} dni` : "brak",
                            opoz && opoz.dni > 0 ? "#B22" : C.czarny
                          )}
                          {komorka("Zakończenie wg umowy", (() => {
                            const zHarm = najpozniejszePlanowaneZakonczenie(o.harmonogram);
                            if (zHarm) return fmtPL(zHarm);
                            return o.zakonczenie_robot ? fmtPL(o.zakonczenie_robot) : "—";
                          })())}
                          {komorka("Pozwolenie (PNU)", o.pnu_nie_dotyczy ? "Nie dotyczy" : (o.pnu ? fmtPL(o.pnu) : "—"))}
                        </div>
                      );
                    })()}
                    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, color: st.kolor, background: st.tlo }}>
                      {st.txt}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Filtr aktywny — informacja */}
            {filtr && (
              <div style={{ marginBottom: 14, fontSize: 13, color: C.szary }}>
                Filtr: <strong style={{ color: C.czarny }}>{filtr}</strong> ·{" "}
                <span onClick={() => setFiltr("")} style={{ color: "#1668C7", cursor: "pointer", textDecoration: "underline" }}>pokaż wszystkie</span>
              </div>
            )}

            {/* 2) Lista raportów */}
            <div style={{ background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr style={{ background: C.czarny }}>
                    <th style={thArch}>Nr</th>
                    <th style={{ ...thArch, textAlign: "left" }}>Budowa</th>
                    <th style={thArch}>Okres</th>
                    <th style={thArch}>Data</th>
                    <th style={{ ...thArch, textAlign: "left" }}>Opracował</th>
                    <th style={thArch}>Status</th>
                    <th style={thArch}></th>
                  </tr>
                </thead>
                <tbody>
                  {widoczne.map((r) => {
                    const st = statusZPodsumowania(r.podsumowanie);
                    return (
                      <tr key={r.id} style={{ borderTop: `1px solid ${C.linia}` }}>
                        <td style={{ ...tdArch, fontWeight: 800, textAlign: "center" }}>{r.numer}</td>
                        <td style={{ ...tdArch, fontWeight: 600 }}>{r.nazwaProjektu}</td>
                        <td style={{ ...tdArch, textAlign: "center", whiteSpace: "nowrap" }}>
                          {r.okres_od ? `${fmtPL(r.okres_od)} – ${fmtPL(r.okres_do)}` : "—"}
                        </td>
                        <td style={{ ...tdArch, textAlign: "center", whiteSpace: "nowrap" }}>{r.data_opracowania ? fmtPL(r.data_opracowania) : "—"}</td>
                        <td style={tdArch}>{r.opracowal || "—"}</td>
                        <td style={{ ...tdArch, textAlign: "center" }}>
                          <span style={{ display: "inline-block", width: 11, height: 11, borderRadius: "50%", background: st.kolor }} title={st.txt} />
                        </td>
                        <td style={{ ...tdArch, textAlign: "right", whiteSpace: "nowrap" }}>
                          {mozeEdytowac && mozeEdytowac(r) && (() => {
                            const h = godzinyDoEdycji && godzinyDoEdycji(r);
                            return (
                              <>
                                <button onClick={() => onEdytuj(r.id)} style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600, marginRight: h ? 4 : 6 }}>Edytuj</button>
                                {h != null && (
                                  <span style={{ fontSize: 11, color: C.szary, marginRight: 6, whiteSpace: "nowrap" }} title="Czas, przez jaki możesz jeszcze edytować ten raport">zostało ~{h}h</span>
                                )}
                              </>
                            );
                          })()}
                          <button onClick={() => onOtworz(r.id)} title="Podgląd raportu — stamtąd zapiszesz PDF lub wygenerujesz link dla inwestora" style={{ ...miniBtn, background: C.zolty, border: "none", fontWeight: 700 }}>Otwórz</button>
                          {jestAdmin && onUsun && (
                            <button onClick={() => onUsun(r)} title="Usuń raport wraz ze zdjęciami (nieodwracalne)"
                              style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.czerwony}`, color: C.czerwony, fontWeight: 600, marginLeft: 6 }}>
                              Usuń
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: C.szary, textAlign: "right" }}>
              Raportów w archiwum: {widoczne.length}{filtr ? ` (z ${lista.length})` : ""}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- Udostępnianie raportu linkiem ---------------------------------
   Panel zarządzania linkami (dla zalogowanych, w podglądzie z archiwum)
   + publiczny widok raportu otwieranego z linku (#r/<token>).
   Link pokazuje ŻYWĄ wersję raportu — po edycji inwestor widzi stan aktualny. */

function PanelLinkow({ raportId, jestAdmin }) {
  const [linki, setLinki] = useState(null); // null = wczytywanie
  const [robie, setRobie] = useState(false);
  const [info, setInfo] = useState("");

  const odswiez = useCallback(() => {
    listaUdostepnien(raportId)
      .then(setLinki)
      .catch((e) => { console.error(e); setInfo("Błąd wczytywania linków — czy tabela `udostepnienia` istnieje w Supabase?"); setLinki([]); });
  }, [raportId]);
  useEffect(() => { odswiez(); }, [odswiez]);

  const urlZTokenu = (t) => `${window.location.origin}${window.location.pathname}#r/${t}`;

  async function kopiuj(token) {
    const url = urlZTokenu(token);
    try {
      await navigator.clipboard.writeText(url);
      setInfo("Skopiowano link do schowka ✓");
    } catch {
      // clipboard bywa zablokowany (http / stare Safari) — pokaż link do ręcznego skopiowania
      setInfo(url);
    }
  }
  async function nowyLink() {
    setRobie(true);
    try {
      const u = await utworzUdostepnienie(raportId);
      await kopiuj(u.token);
      odswiez();
    } catch (e) {
      console.error(e);
      setInfo("Nie udało się utworzyć linku");
    } finally {
      setRobie(false);
    }
  }
  async function uniewaznij(id) {
    try { await wylaczUdostepnienie(id); setInfo("Link unieważniony"); odswiez(); }
    catch (e) { console.error(e); setInfo("Nie udało się unieważnić linku"); }
  }

  const aktywny = (l) => !l.wylaczony;
  const statusLinku = (l) => l.wylaczony
    ? { txt: "unieważniony", kolor: "#B22" }
    : { txt: "aktywny", kolor: "#1B7A3D" };

  return (
    <div className="noprint" style={{ maxWidth: 794, margin: "16px auto 0", background: C.bialy, borderRadius: 8, padding: "16px 20px", boxShadow: "0 4px 30px rgba(0,0,0,0.3)", fontSize: 13, color: C.czarny }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, fontSize: 12 }}>Linki do raportu dla inwestora</div>
        <button onClick={nowyLink} disabled={robie} style={{ background: C.zolty, color: C.czarny, border: "none", padding: "7px 16px", borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
          {robie ? "Tworzę…" : "+ Nowy link (kopiuje do schowka)"}
        </button>
      </div>
      <p style={{ margin: "0 0 10px", color: C.szary, fontSize: 12, lineHeight: 1.4 }}>
        Osoba z linkiem widzi raport bez logowania (zawsze aktualną wersję) i może zapisać go jako PDF.
        Link działa bezterminowo{jestAdmin ? " — możesz go unieważnić w każdej chwili." : "; unieważnić może go administrator."}
      </p>
      {info && <div style={{ background: C.zoltyJasny, borderLeft: `3px solid ${C.zolty}`, padding: "6px 10px", marginBottom: 10, fontSize: 12, wordBreak: "break-all" }}>{info}</div>}
      {linki === null && <div style={{ color: C.szary }}>Wczytywanie…</div>}
      {linki !== null && linki.length === 0 && <div style={{ color: C.szary }}>Ten raport nie ma jeszcze żadnych linków.</div>}
      {linki !== null && linki.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Utworzony", "Otwarcia", "Ostatnio otwarty", "Status", ""].map((h, i, arr) => (
                <th key={i} style={{ textAlign: i === arr.length - 1 ? "right" : "left", padding: "4px 6px", borderBottom: `2px solid ${C.czarny}`, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linki.map((l) => {
              const st = statusLinku(l);
              return (
                <tr key={l.id} style={{ borderBottom: `1px solid ${C.linia}` }}>
                  <td style={{ padding: "6px" }}>{fmtPL(l.utworzono?.slice(0, 10))}</td>
                  <td style={{ padding: "6px" }}>{l.otwarcia}</td>
                  <td style={{ padding: "6px" }}>{l.ostatnie_otwarcie ? fmtPL(l.ostatnie_otwarcie.slice(0, 10)) : "—"}</td>
                  <td style={{ padding: "6px", color: st.kolor, fontWeight: 700 }}>{st.txt}</td>
                  <td style={{ padding: "6px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {aktywny(l) && (
                      <>
                        <button onClick={() => kopiuj(l.token)} style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600, marginRight: jestAdmin ? 6 : 0 }}>Kopiuj</button>
                        {jestAdmin && (
                          <button onClick={() => uniewaznij(l.id)} style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.czerwony}`, color: C.czerwony, fontWeight: 600 }}>Unieważnij</button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function WidokPubliczny({ token }) {
  const [stan, setStan] = useState("laduje"); // laduje | ok | brak | blad
  const [formPub, setFormPub] = useState(null);

  useEffect(() => {
    raportPoTokenie(token)
      .then((w) => {
        if (!w) { setStan("brak"); return; }
        const f = mapWierszNaForm(w);
        f.projekt = w.projekt_nazwa || "";
        setFormPub(f);
        setStan("ok");
      })
      .catch((e) => { console.error(e); setStan("blad"); });
  }, [token]);

  if (stan === "ok" && formPub) {
    return <PodgladPDF form={formPub} onBack={null} nazwaPliku={nazwaPliku(formPub)} publiczny />;
  }
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.czarny, fontFamily: "'Segoe UI', system-ui, sans-serif", padding: 20 }}>
      {stan === "laduje" ? (
        <div style={{ color: C.szary }}>Wczytywanie raportu…</div>
      ) : (
        <div style={{ background: C.bialy, borderRadius: 10, padding: "32px 36px", maxWidth: 440, textAlign: "center" }}>
          <div style={{ marginBottom: 10 }}><span style={{ color: C.zolty, fontWeight: 800, fontSize: 26 }}>/</span><span style={{ fontWeight: 800, fontSize: 24 }}>Abyard</span></div>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>Ten link jest nieaktywny</div>
          <p style={{ color: C.szary, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {stan === "brak"
              ? "Link został unieważniony lub nie istnieje. Poproś nadawcę o nowy link do raportu."
              : "Nie udało się wczytać raportu. Spróbuj ponownie za chwilę lub poproś nadawcę o nowy link."}
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------- Podgląd / PDF ------------------------------------------------- */
function PodgladPDF({ form, onBack, nazwaPliku, raportId, publiczny, jestAdmin }) {
  const [pokazLinki, setPokazLinki] = useState(false);
  return (
    <div style={{ background: "#888", minHeight: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <style>{printCSS}</style>
      <div className="noprint" style={{ position: "sticky", top: 0, background: C.czarny, padding: "12px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 10, flexWrap: "wrap", gap: 10 }}>
        <span style={{ color: C.bialy, fontSize: 14 }}>Podgląd raportu — <strong>{nazwaPliku}.pdf</strong></span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: C.zolty, fontSize: 12, maxWidth: 260, lineHeight: 1.3 }}>
            W oknie zapisu zaznacz <strong>„Grafika w tle"</strong>, by zachować kolory
          </span>
          {onBack && <button style={btnGhostDark} onClick={onBack}>← Wróć do edycji</button>}
          {!publiczny && (raportId ? (
            <button style={btnGhostDark} onClick={() => setPokazLinki((v) => !v)}>
              {pokazLinki ? "Zamknij linki" : "🔗 Udostępnij link"}
            </button>
          ) : (
            <button style={{ ...btnGhostDark, opacity: 0.45, cursor: "not-allowed" }} disabled
              title="Najpierw zapisz raport w bazie — link musi wskazywać zapisany raport">
              🔗 Udostępnij link
            </button>
          ))}
          <button style={btnPrimary} onClick={() => {
            const poprzedni = document.title;
            document.title = nazwaPliku;
            const przywroc = () => { document.title = poprzedni; window.removeEventListener("afterprint", przywroc); };
            window.addEventListener("afterprint", przywroc);
            window.print();
            setTimeout(przywroc, 1500);
          }}>Zapisz / Drukuj PDF</button>
        </div>
      </div>

      {pokazLinki && raportId && !publiczny && <PanelLinkow raportId={raportId} jestAdmin={jestAdmin} />}

      <div className="pdf-page" style={{ background: C.bialy, maxWidth: 794, margin: "20px auto", padding: 56, boxShadow: "0 4px 30px rgba(0,0,0,0.3)", color: C.czarny }}>
        {/* Logo + kontakt */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `2px solid ${C.czarny}`, paddingBottom: 10, marginBottom: 18 }}>
          <div><span style={{ color: C.zolty, fontWeight: 800, fontSize: 22 }}>/</span><span style={{ fontWeight: 800, fontSize: 20 }}>Abyard</span></div>
          <div style={{ fontSize: 10, color: C.szary }}>www.abyard.com · biuro@abyard.pl · tel. (12) 431 30 87</div>
        </div>

        <div style={{ textAlign: "right", fontSize: 11, color: C.szary, fontStyle: "italic", marginBottom: 4 }}>Kraków, dn. {fmtPL(form.dataOpracowania)}</div>

        <div style={{ textAlign: "center", marginTop: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 3, color: C.szary, textTransform: "uppercase" }}>Raport numer</div>
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1, margin: "2px 0 10px" }}>
            <span style={{ color: C.zolty }}>/</span>{String(form.numer).padStart(3, "0")}
          </div>
        </div>

        <div style={{ display: "inline-block", background: C.czarny, color: C.zolty, fontWeight: 700, fontSize: 12, padding: "6px 18px", letterSpacing: 1, width: "100%", textAlign: "center", boxSizing: "border-box" }}>
          RAPORT ZA OKRES&nbsp;&nbsp;{fmtPL(form.okresOd) || "…"} – {fmtPL(form.okresDo) || "…"}
        </div>

        <h2 style={{ textAlign: "center", fontSize: 30, margin: "20px 0 4px", fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.1 }}>{form.projekt}</h2>
        {form.adres && <p style={{ textAlign: "center", margin: "2px 0", color: C.czarny, fontSize: 14, fontWeight: 600 }}>{form.adres}</p>}
        {form.tytulZadania && <p style={{ textAlign: "center", fontStyle: "italic", margin: "8px auto 0", fontSize: 13, color: C.szary, maxWidth: 600, lineHeight: 1.4 }}>„{form.tytulZadania}”</p>}
        {form.grafikaInwestycji && (
          <div style={{ textAlign: "center", margin: "16px 0 10px" }}>
            <img className="grafika-okladka" src={form.grafikaInwestycji.dataUrl} alt="" style={{ width: "auto", maxWidth: "100%", maxHeight: "108mm", objectFit: "contain", borderRadius: 6, border: `1px solid ${C.linia}` }} />
          </div>
        )}

        <div className="klucz-daty" style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
          <BlokPDF tytul="Kluczowe daty">
            <p style={pPDF}><strong>Rozpoczęcie budowy:</strong> {fmtPL(form.rozpoczecie) || "—"}</p>
            <p style={pPDF}><strong>Zakończenie robót:</strong> {fmtPL(form.zakonczenieRobot) || "—"}</p>
            <p style={pPDF}><strong>Pozwolenie na użytkowanie:</strong> {form.pnuNieDotyczy ? "Nie dotyczy" : (fmtPL(form.pnu) || "—")}</p>
            <p style={pPDF}><strong>Opracował:</strong> {form.opracowal || "—"}</p>
          </BlokPDF>
        </div>

        {/* Twardy podział strony — strona tytułowa kończy się na kluczowych datach */}
        <div className="lamanie-strony" style={{ breakBefore: "page", pageBreakBefore: "always" }} />

        <BlokPDF tytul="Informacje ogólne">
          <Tekst v={form.infoOgolne} />
          {form.opoznienia && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, color: C.czarny, marginBottom: 4 }}>Opóźnienia i działania naprawcze</div>
              <div style={{ background: C.zoltyJasny, borderLeft: `3px solid ${C.zolty}`, padding: "8px 12px", fontSize: 12.5 }}><Tekst v={form.opoznienia} /></div>
            </div>
          )}
        </BlokPDF>

        {form.wykonawcy && <BlokPDF tytul="Wykonawcy prac"><Tekst v={form.wykonawcy} /></BlokPDF>}
        {form.przetargi && <BlokPDF tytul="Przetargi"><Tekst v={form.przetargi} /></BlokPDF>}
        {form.sprawyBudowy && <BlokPDF tytul="Sprawy ogólne budowy"><Tekst v={form.sprawyBudowy} /></BlokPDF>}
        {form.sprawyInwestora && <BlokPDF tytul="Sprawy dotyczące Inwestora"><Tekst v={form.sprawyInwestora} /></BlokPDF>}
        {form.placBudowy && <BlokPDF tytul="Teren placu budowy"><Tekst v={form.placBudowy} /></BlokPDF>}

        <BlokPDF tytul="Podsumowanie">
          <div style={{ borderLeft: `4px solid ${C.zolty}`, paddingLeft: 12, fontWeight: 700, fontSize: 13 }}>{form.podsumowanie}</div>
        </BlokPDF>

        {(() => {
          const maObrazy = form.harmonogramObrazy && form.harmonogramObrazy.length > 0;
          const wiersze = (form.harmonogram || [])
            .map((r, idx) => ({ ...r, nr: idx + 1 }))
            .filter((r) => {
              const ef = efektywnyWiersz(r);
              return ef.start || ef.koniec || ef.rzecz || ef.proc !== "";
            });
          // Gdy są obrazy harmonogramu — używamy ich ZAMIAST tabeli ZZK.
          if (maObrazy) {
            return (
              <BlokPDF tytul="Harmonogram budowy">
                <div>
                  {form.harmonogramObrazy.map((o, i) => (
                    <img key={i} className="harm-pdf" src={o.dataUrl} alt="" style={{ width: "100%", maxHeight: "230mm", objectFit: "contain", borderRadius: 4, display: "block", marginBottom: 12, breakInside: "avoid", pageBreakInside: "avoid" }} />
                  ))}
                </div>
              </BlokPDF>
            );
          }
          // Brak obrazów — pokazujemy tabelę ZZK, o ile cokolwiek wypełniono.
          if (wiersze.length === 0) return null;
          return (
            <BlokPDF tytul="Harmonogram budowy">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ ...thHarmPdf, width: 28 }}>#</th>
                    <th style={thHarmPdf}>Zadanie</th>
                    <th style={thHarmPdf}>Start (umowa)</th>
                    <th style={thHarmPdf}>Koniec (umowa)</th>
                    <th style={thHarmPdf}>Koniec (progn./rzecz.)</th>
                    <th style={thHarmPdf}>% wyk.</th>
                    <th style={thHarmPdf}>Opóźnienie</th>
                  </tr>
                </thead>
                <tbody>
                  {wiersze.map((r) => {
                    const ef = efektywnyWiersz(r);
                    const op = obliczOpoznienie(ef, form.dataOpracowania);
                    const pod = maPodpozycje(r) ? r.pod.filter((p) => p && (p.zadanie || p.start || p.koniec || p.rzecz || p.proc)) : [];
                    return (
                      <React.Fragment key={r.nr}>
                        {/* Pozycja główna (zadanie) — wyróżniona */}
                        <tr style={{ background: pod.length ? "#F3F0E8" : "transparent" }}>
                          <td style={{ ...tdHarmPdf, fontWeight: 800, color: C.czarny }}>{r.nr}</td>
                          <td style={{ ...tdHarmPdf, textAlign: "left", fontWeight: 700 }}>{r.zadanie}</td>
                          <td style={tdHarmPdf}>{fmtPL(ef.start) || "—"}</td>
                          <td style={tdHarmPdf}>{fmtPL(ef.koniec) || "—"}</td>
                          <td style={{ ...tdHarmPdf, fontWeight: ef.rzecz ? 700 : 400 }}>{fmtPL(ef.rzecz) || "—"}</td>
                          <td style={{ ...tdHarmPdf, fontWeight: 700 }}>{ef.proc !== "" ? `${ef.proc}%` : "—"}</td>
                          <td style={{ ...tdHarmPdf, color: op ? "#B22" : C.czarny, fontWeight: op ? 800 : 400 }}>{op || "—"}</td>
                        </tr>
                        {/* Podpozycje — cieńsze, wcięte */}
                        {pod.map((p, j) => {
                          const opP = obliczOpoznienie(p, form.dataOpracowania);
                          return (
                            <tr key={`${r.nr}-${j}`}>
                              <td style={{ ...tdHarmPdf, color: "#999", fontSize: 10 }}>{r.nr}.{j + 1}</td>
                              <td style={{ ...tdHarmPdf, textAlign: "left", fontWeight: 400, paddingLeft: 18, color: "#444" }}>{p.zadanie || "—"}</td>
                              <td style={{ ...tdHarmPdf, fontWeight: 400 }}>{fmtPL(p.start) || "—"}</td>
                              <td style={{ ...tdHarmPdf, fontWeight: 400 }}>{fmtPL(p.koniec) || "—"}</td>
                              <td style={{ ...tdHarmPdf, fontWeight: 400 }}>{fmtPL(p.rzecz) || "—"}</td>
                              <td style={{ ...tdHarmPdf, fontWeight: 400 }}>{p.proc !== "" && p.proc != null ? `${p.proc}%` : "—"}</td>
                              <td style={{ ...tdHarmPdf, color: opP ? "#B22" : C.czarny, fontWeight: 400 }}>{opP || "—"}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                {(() => {
                  const konce = [], starty = [];
                  for (const w of (form.harmonogram || [])) {
                    const ef = efektywnyWiersz(w);
                    if (ef.start) starty.push(ef.start);
                    const kon = ef.rzecz || ef.koniec;
                    if (kon) konce.push(kon);
                  }
                  const dataMin = starty.sort()[0] || "";
                  const dataMax = konce.sort()[konce.length - 1] || "";
                  const opoz = opoznienieInwestycji(form.harmonogram, form.dataOpracowania);
                  const sumaKwot = sumaWartosciUmowy(form.harmonogram);
                  const maKwoty = harmonogramMaKwoty(form.harmonogram);
                  const st = { ...tdHarmPdf, borderTop: `2px solid ${C.czarny}`, background: "#F3F0E8", fontWeight: 800 };
                  return (
                    <tfoot>
                      <tr>
                        <td style={st}>Σ</td>
                        <td style={{ ...st, textAlign: "left" }}>PODSUMOWANIE{maKwoty ? ` · wartość umowy: ${Math.round(sumaKwot).toLocaleString("pl-PL")} zł` : ""}</td>
                        <td style={{ ...st, fontWeight: 400 }}>{fmtPL(dataMin) || "—"}</td>
                        <td style={{ ...st, fontWeight: 400 }} colSpan={2}>{fmtPL(dataMax) || "—"}</td>
                        <td style={st}></td>
                        <td style={{ ...st, color: opoz && opoz.dni > 0 ? "#B22" : C.czarny }}>{opoz ? (opoz.dni > 0 ? `${opoz.dni} dni` : "brak") : "—"}</td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </BlokPDF>
          );
        })()}

        {/* CASHFLOW — macierz na osobnej stronie PDF (poziomo/landscape) */}
        {harmonogramMaKwoty(form.harmonogram) && (() => {
          const macierz = macierzCashflow(form.harmonogram);
          if (!macierz.zadania.length || !macierz.miesiace.length) return null;
          const { miesiace, zadania, sumaMies, sumaNaras, sumaCalosc } = macierz;
          const nM = miesiace.length;
          // Skalowanie do szerokości pionowej A4 (~182mm po marginesach).
          // Im więcej miesięcy, tym mniejsza czcionka/padding; przy bardzo wielu — kwoty w tysiącach.
          const wTys = nM > 16;                       // kwoty w tys. zł, gdy dużo kolumn
          const fs = nM > 20 ? 6 : nM > 16 ? 6.5 : nM > 12 ? 7.5 : nM > 8 ? 8.5 : 9.5;
          const pad = nM > 16 ? "1px 2px" : nM > 12 ? "1px 3px" : "3px 5px";
          const fmtZ = (n) => {
            if (!n) return "";
            if (wTys) return Math.round(n / 1000).toLocaleString("pl-PL"); // w tysiącach
            return Math.round(n).toLocaleString("pl-PL");
          };
          const thO = { padding: pad, border: "1px solid #C9C6BE", fontSize: fs, whiteSpace: "nowrap", background: C.czarny, color: C.zolty };
          const thM = { padding: pad, border: "1px solid #C9C6BE", fontSize: fs, whiteSpace: "nowrap", background: "#3A3A3A", color: "#FFF", textAlign: "right" };
          const td = { padding: pad, border: "1px solid #D9D6CE", fontSize: fs };
          return (
            <div className="strona-cashflow">
            <BlokPDF tytul={`Harmonogram rzepływów finansowych — sprzedaż${wTys ? " (kwoty w tys. zł)" : ""}`}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    <th style={{ ...thO, textAlign: "left" }}>Zadanie</th>
                    <th style={{ ...thO, textAlign: "right" }}>Kwota netto</th>
                    <th style={{ ...thO, textAlign: "center" }}>Start</th>
                    <th style={{ ...thO, textAlign: "center" }}>Koniec</th>
                    {miesiace.map((m) => <th key={m.klucz} style={thM}>{m.etykieta}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {zadania.map((z, i) => (
                    <tr key={i}>
                      <td style={{ ...td, textAlign: "left" }}>{z.nazwa}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtZ(z.kwota)}</td>
                      <td style={{ ...td, textAlign: "center", color: C.szary }}>{z.start ? fmtPL(z.start) : "—"}</td>
                      <td style={{ ...td, textAlign: "center", color: C.szary }}>{z.koniec ? fmtPL(z.koniec) : "—"}</td>
                      {miesiace.map((m) => {
                        const v = z.komorki[m.klucz];
                        return <td key={m.klucz} style={{ ...td, textAlign: "right", background: v ? "#FFF9E6" : "transparent" }}>{v ? fmtZ(v) : "–"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ ...td, textAlign: "left", fontWeight: 800, background: "#F3F0E8" }}>RAZEM mies.</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 800, background: "#F3F0E8" }}>{fmtZ(sumaCalosc)}</td>
                    <td colSpan={2} style={{ ...td, background: "#F3F0E8" }}></td>
                    {miesiace.map((m) => <td key={m.klucz} style={{ ...td, textAlign: "right", fontWeight: 700, background: "#F3F0E8" }}>{fmtZ(sumaMies[m.klucz])}</td>)}
                  </tr>
                  <tr>
                    <td style={{ ...td, textAlign: "left", fontWeight: 800, background: C.zolty, color: C.czarny }}>Narastająco</td>
                    <td colSpan={3} style={{ ...td, background: C.zolty }}></td>
                    {miesiace.map((m) => <td key={m.klucz} style={{ ...td, textAlign: "right", fontWeight: 700, background: C.zolty, color: C.czarny }}>{fmtZ(sumaNaras[m.klucz])}</td>)}
                  </tr>
                </tfoot>
              </table>
            </BlokPDF>
            </div>
          );
        })()}

        {form.zdjecia.length > 0 && (() => {
          // Grupujemy zdjęcia w "strony fotograficzne":
          //  - pionowe (lub bez orientacji): 1 na stronę
          //  - poziome: 2 na stronę
          // Każda strona wypełnia wysokość druku; zdjęcia skalują się równo (bez cięcia, bez pustek).
          const strony = [];
          let bufor = [];
          for (const z of form.zdjecia) {
            const poziome = z.pion === false;
            if (!poziome) {
              if (bufor.length) { strony.push(bufor); bufor = []; }
              strony.push([z]);
            } else {
              bufor.push(z);
              if (bufor.length === 2) { strony.push(bufor); bufor = []; }
            }
          }
          if (bufor.length) strony.push(bufor);

          const naglowek = (
            <div className="blok-pdf" style={{ display: "flex", alignItems: "stretch", marginBottom: 10 }}>
              <div style={{ width: 6, background: C.zolty, flexShrink: 0 }} />
              <div style={{ background: C.czarny, color: C.bialy, fontWeight: 800, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.5, padding: "8px 16px", flex: 1 }}>Dokumentacja fotograficzna</div>
            </div>
          );

          // Strona fotograficzna: kontener flex w pionie wypełniający wysokość druku.
          // pierwszaZNaglowkiem = trochę niższy, bo dzieli miejsce z nagłówkiem sekcji.
          const stronaFoto = (zdj, key, zNaglowkiem) => (
            <div key={key} className={`foto-strona foto-n${zdj.length}${zNaglowkiem ? "" : " foto-strona-break"}`}
              style={{ display: "flex", flexDirection: "column", gap: 12, justifyContent: "center", alignItems: "center", height: 900, marginBottom: 8 }}>
              {zNaglowkiem && naglowek}
              {zdj.map((z, k) => (
                <figure key={k} className="foto-fig" style={{ margin: 0, flex: "1 1 0", minHeight: 0, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <img src={z.dataUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain", borderRadius: 4, display: "block" }} />
                  {z.opis && <figcaption style={{ fontSize: 12.5, color: C.czarny, marginTop: 6, textAlign: "center", fontWeight: 600, flexShrink: 0 }}>{z.opis}</figcaption>}
                </figure>
              ))}
            </div>
          );

          return (
            <div style={{ marginTop: 20 }} className="foto-sekcja">
              {strony.map((zdj, idx) => stronaFoto(zdj, `s${idx}`, idx === 0))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ---------- Komponenty pomocnicze ---------------------------------------- */
function Sekcja({ tytul, children }) {
  return (
    <section style={card}>
      <div style={secTitle}>{tytul}</div>
      {children}
    </section>
  );
}
function Pole({ label, children }) {
  return (<div style={{ marginBottom: 12 }}><label style={lbl}>{label}</label>{children}</div>);
}
function BlokPDF({ tytul, children }) {
  return (
    <div className="blokpdf" style={{ marginTop: 20 }}>
      <div className="blokpdf-naglowek" style={{ display: "flex", alignItems: "stretch", marginBottom: 8, breakAfter: "avoid", pageBreakAfter: "avoid", breakInside: "avoid", pageBreakInside: "avoid" }}>
        <div style={{ width: 6, background: C.zolty, flexShrink: 0 }} />
        <div style={{ background: C.czarny, color: C.bialy, fontWeight: 800, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.5, padding: "8px 16px", flex: 1 }}>{tytul}</div>
      </div>
      <div style={{ padding: "2px 4px" }}>{children}</div>
    </div>
  );
}
function Tekst({ v }) {
  // v może być HTML (z edytora rich-text) — renderujemy bezpiecznie jako sformatowany
  return <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55 }} dangerouslySetInnerHTML={{ __html: v || "—" }} />;
}

/* Edytor rich-text: zaznacz fragment i kliknij B / I / U aby sformatować */
function RichEdytor({ value, onChange, placeholder, minHeight = 84 }) {
  const ref = useRef(null);
  const [pusty, setPusty] = useState(!value);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || "")) {
      ref.current.innerHTML = value || "";
      setPusty(!value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function format(komenda) {
    document.execCommand(komenda, false, null);
    ref.current?.focus();
    handleInput();
  }
  function handleInput() {
    const html = ref.current?.innerHTML || "";
    setPusty(!ref.current?.innerText.trim());
    onChange(html);
  }

  // Wklejanie: bierzemy CZYSTY tekst (bez obcego HTML), a złamania linii
  // zamieniamy na jednolite <br>, by odstępy między wierszami były równe.
  function handlePaste(e) {
    e.preventDefault();
    const tekst = (e.clipboardData || window.clipboardData).getData("text/plain");
    if (!tekst) return;
    // normalizujemy końce linii i zamieniamy na <br>; puste linie też = pojedynczy <br>
    const html = tekst
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((linia) => linia.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "")
      .join("<br>");
    document.execCommand("insertHTML", false, html);
    handleInput();
  }

  // Enter wstawia pojedyncze <br> (zamiast nowego bloku <div>/<p>),
  // dzięki czemu każdy nowy wiersz ma taki sam, równy odstęp.
  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      handleInput();
    }
  }

  const btn = (etykieta, komenda, tytul, styl) => (
    <button type="button" onMouseDown={(e) => { e.preventDefault(); format(komenda); }}
      style={{ width: 30, height: 26, border: `1px solid ${C.linia}`, borderRadius: 4, background: C.bialy, cursor: "pointer", fontSize: 14, ...styl }}
      title={tytul}>{etykieta}</button>
  );

  return (
    <div style={{ border: `1px solid #C9C2B2`, borderRadius: 5, background: "#FCFBF8", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4, padding: "5px 6px", borderBottom: `1px solid ${C.linia}`, background: "#F3F0E8" }}>
        {btn("B", "bold", "Pogrub zaznaczony tekst (np. nowe informacje w tym raporcie)", { fontWeight: 800 })}
        {btn("I", "italic", "Pochyl zaznaczony tekst (kursywa)", { fontStyle: "italic", fontFamily: "Georgia, serif" })}
        {btn("U", "underline", "Podkreśl zaznaczony tekst", { textDecoration: "underline" })}
        <span style={{ fontSize: 11, color: C.szary, alignSelf: "center", marginLeft: 4 }}>zaznacz fragment i kliknij B / I / U</span>
      </div>
      <div style={{ position: "relative" }}>
        {pusty && placeholder && (
          <div style={{ position: "absolute", top: 9, left: 11, color: "#A09A88", fontSize: 14, pointerEvents: "none" }}>{placeholder}</div>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          style={{ minHeight, padding: "9px 11px", fontSize: 14, lineHeight: 1.5, outline: "none", fontFamily: "inherit" }}
        />
      </div>
    </div>
  );
}


/* ---------- Style --------------------------------------------------------- */
const card = { background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 8, padding: 22, marginBottom: 18, boxShadow: "0 1px 2px rgba(0,0,0,0.03)" };
const secTitle = { display: "inline-block", fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: C.bialy, background: C.czarny, padding: "7px 16px 7px 12px", marginBottom: 18, borderLeft: `4px solid ${C.zolty}`, borderRadius: "0 4px 4px 0" };
const lbl = { display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: C.szary, marginBottom: 5 };
const inp = { width: "100%", padding: "9px 11px", border: `1px solid #C9C2B2`, borderRadius: 5, fontSize: 14, boxSizing: "border-box", background: "#FCFBF8", fontFamily: "inherit" };
const ta = { ...inp, minHeight: 84, resize: "vertical" };
const taBig = { ...inp, minHeight: 120, resize: "vertical" };
const grid3 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 };
const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 };
const btnPrimary = { background: C.zolty, color: C.czarny, border: "none", padding: "11px 22px", borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { background: "transparent", color: C.czarny, border: `1.5px solid ${C.czarny}`, padding: "10px 18px", borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const btnGhostDark = { background: "transparent", color: C.bialy, border: `1.5px solid ${C.bialy}`, padding: "8px 16px", borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const miniBtn = { background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 4, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
const pPDF = { margin: "2px 0", fontSize: 12.5 };
const thHarm = { background: C.czarny, color: C.zolty, fontSize: 11, fontWeight: 700, padding: "8px 6px", textAlign: "center", border: `1px solid ${C.grafit}` };
const tdHarm = { padding: "3px 6px", border: `1px solid ${C.linia}`, textAlign: "center" };
const cellInp = { border: "none", background: "transparent", fontSize: 13, fontFamily: "inherit", padding: "4px 2px", width: "100%", boxSizing: "border-box" };
const thHarmPdf = { background: C.czarny, color: C.zolty, fontSize: 9.5, fontWeight: 700, padding: "5px 4px", textAlign: "center", border: `1px solid ${C.grafit}` };
const tdHarmPdf = { padding: "4px", border: `1px solid ${C.linia}`, textAlign: "center", fontSize: 10.5 };
const thArch = { color: C.zolty, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, padding: "12px 14px", textAlign: "center" };
const tdArch = { padding: "12px 14px", color: C.czarny, verticalAlign: "middle" };

const globalCSS = `
  * { box-sizing: border-box; }
  select:focus, input:focus, textarea:focus { outline: 2px solid ${C.zolty}; outline-offset: 0; border-color: ${C.zolty}; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  @media screen and (max-width: 640px) {
    footer > div { flex-direction: column; align-items: stretch !important; }
    footer button { width: 100%; }
    /* Szerokie tabele na telefonie: własne poziome przewijanie zamiast rozpychania strony.
       Tylko ekran (screen) i wąski — laptop oraz druk PDF nietknięte.
       display:block daje przewijanie; width:max-content wymusza, by tabela nie ściskała
       kolumn poniżej ich naturalnej szerokości (dzięki temu pojawia się pasek, a nie obcięcie). */
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; width: max-content; max-width: 100%; }
    /* Tabele, które MAJĄ już własny kontener przewijania (np. harmonogram) — nie nakładaj
       drugiego mechanizmu, bo zagnieżdżone przewijania blokują dojazd do końca. */
    .tabela-scroll-own { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tabela-scroll-own table { display: table; width: 100%; }
  }
`;
const printCSS = `
  /* Granica między stronami fotograficznymi w podglądzie na ekranie (nie w druku) */
  @media screen {
    .foto-strona-break { border-top: 2px dashed #ccc; padding-top: 18px; margin-top: 10px; }
  }
  /* Wymuszenie druku kolorów tła i grafik — kluczowe dla czarnych pasków i żółtych akcentów */
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  @media print {
    .noprint { display: none !important; }
    html, body { background: white !important; }
    .pdf-page { box-shadow: none !important; margin: 0 !important; max-width: 100% !important; padding: 0 !important; }
    @page { size: A4; margin: 14mm; }
    figure, tr, .blok-pdf { break-inside: avoid; page-break-inside: avoid; }
    .foto-pdf { break-inside: avoid; page-break-inside: avoid; }
    .foto-rzad { break-inside: avoid; page-break-inside: avoid; }
    .foto-pdf img, .harm-pdf img, .foto-rzad img { break-inside: avoid; page-break-inside: avoid; object-fit: contain; }
    /* Strony fotograficzne — wersja odporna na Safari/WebKit.
       Zamiast sztywnej wysokości 267mm (Safari zaokrągla inaczej niż Chrome,
       blok wychodził poza stronę i overflow:hidden OBCINAŁ zdjęcia) każda
       strona fotograficzna ma wysokość auto, twardy podział strony przed sobą
       i JAWNE limity wysokości zdjęć w mm — z zapasem względem obszaru druku
       (269mm). Nic nie jest przycinane, bo nic nie może przekroczyć strony. */
    .foto-strona { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; break-inside: avoid; page-break-inside: avoid; margin-bottom: 0 !important; }
    .foto-strona .foto-fig { flex: 0 0 auto !important; min-height: 0 !important; break-inside: avoid; page-break-inside: avoid; }
    /* 1 zdjęcie (pionowe) na stronę: 225mm + podpis + nagłówek sekcji < 269mm */
    .foto-n1 img { max-height: 225mm !important; }
    /* 2 zdjęcia (poziome) na stronę: 2×110mm + podpisy + odstęp < 269mm */
    .foto-n2 img { max-height: 110mm !important; }
    .foto-strona-break { break-before: page !important; page-break-before: always !important; }
    /* Sekcja "Dokumentacja fotograficzna" ZAWSZE zaczyna się od nowej strony */
    .foto-sekcja { break-before: page !important; page-break-before: always !important; margin-top: 0 !important; }
    .foto-strona img { object-fit: contain; max-width: 100% !important; width: auto !important; height: auto !important; }
    /* Nagłówek sekcji nie może zostać sam na końcu strony — zawsze idzie z treścią */
    .blokpdf-naglowek { break-after: avoid !important; page-break-after: avoid !important; break-inside: avoid !important; page-break-inside: avoid !important; }
    .klucz-daty { break-inside: avoid; page-break-inside: avoid; }
    .lamanie-strony { break-before: page !important; page-break-before: always !important; display: block; height: 0; }
    /* Cashflow — cała macierz jako całość: mieści się albo w całości przechodzi na nową stronę */
    .strona-cashflow { break-inside: avoid; page-break-inside: avoid; }
    /* Grafika okładki w druku — duża, ale z zapasem, by grafika + kluczowe daty
       zmieściły się razem na stronie tytułowej (obszar druku A4 ≈ 269 mm). */
    .grafika-okladka { max-height: 108mm !important; width: auto !important; max-width: 100% !important; }
  }
`;
