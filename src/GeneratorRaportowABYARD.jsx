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
  ustawOknoEdycji,
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

// Czy opóźnienie w harmonogramie realnie opóźnia zakończenie CAŁEGO projektu.
// Reużywa opoznienieInwestycji (opóźnienie całej inwestycji): dni > 0 => zagrożenie.
// Gdy true — w raporcie wymuszany jest status „zagrożenie" (bez możliwości zmiany).
function harmonogramWymuszaZagrozenie(harmonogram, dataOdniesienia) {
  const opoz = opoznienieInwestycji(harmonogram, dataOdniesienia);
  return !!(opoz && opoz.dni > 0);
}

// Liczba dni między dwoma datami ISO (a - b). Dodatnia gdy a jest później niż b.
function dniMiedzy(aISO, bISO) {
  if (!aISO || !bISO) return null;
  return Math.round((new Date(aISO + "T00:00:00") - new Date(bISO + "T00:00:00")) / 86400000);
}

// Ocena statusu inwestycji na podstawie NAJNOWSZEGO raportu (do kokpitu koordynacji
// inwestycji). Reużywa tej samej logiki, co plakietka w archiwum: harmonogram
// wymuszający zagrożenie ma pierwszeństwo, dalej treść pola „Podsumowanie".
// Zwraca { kod, txt, kolor, tlo }. kod: "zagrozenie" | "ok" | "brak".
function statusZRaportu(raport) {
  if (!raport) return { kod: "brak", txt: "brak raportu", kolor: "#8A8A8A", tlo: "#EFEFEF" };
  if (harmonogramWymuszaZagrozenie(raport.harmonogram, raport.data_opracowania))
    return { kod: "zagrozenie", txt: "Zagrożenie terminu", kolor: "#C0392B", tlo: "#FBECEA" };
  const t = (raport.podsumowanie || "").toLowerCase();
  const brakZagrozenia = t.includes("nie powoduje") || t.includes("niezagroż") || t.includes("nie ma zagroż") || t.includes("bez zagroż");
  if (brakZagrozenia) return { kod: "ok", txt: "Termin niezagrożony", kolor: "#1B7A3D", tlo: "#E6F3EA" };
  if (t.includes("zagroż") || t.includes("zagroz")) return { kod: "zagrozenie", txt: "Zagrożenie terminu", kolor: "#C0392B", tlo: "#FBECEA" };
  return { kod: "ok", txt: "Termin niezagrożony", kolor: "#1B7A3D", tlo: "#E6F3EA" };
}

// Najnowszy raport z listy (po dacie opracowania, przy remisie po numerze).
function najnowszyRaport(raporty) {
  let best = null;
  for (const r of (raporty || [])) {
    if (!best) { best = r; continue; }
    const da = r.data_opracowania || "", db = best.data_opracowania || "";
    if (da && db && da !== db) { if (da > db) best = r; }
    else if (da && !db) best = r;
    else if (!da && !db && (r.numer || 0) > (best.numer || 0)) best = r;
    else if (da && db && da === db && (r.numer || 0) > (best.numer || 0)) best = r;
  }
  return best;
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

// Pozycje harmonogramu BEZ uzupełnionej wartości umowy (cashflow) — do egzekwowania
// obowiązkowego cashflow w 1. raporcie nowej inwestycji. Liczymy per pozycja główna,
// tą samą logiką co sam cashflow (kwotaZadania): pozycja jest kompletna, gdy ma
// wartość NA SOBIE albo w podpozycjach (główna sumuje podpozycje). Dzięki temu nie
// blokujemy PM-a, który wpisał kwotę łączną na pozycji nadrzędnej, a podpozycje
// służą tylko do dat.
//
// WAŻNE: kwota jest obowiązkowa TYLKO dla zakresu, który realnie występuje w czasie —
// czyli ma wpisane daty (start i koniec, także wyliczone z podpozycji). Zadanie bez
// kompletu dat i tak nie wchodzi do rozkładu cashflow (rozlozKalendarzowo wymaga obu
// dat), a brak dat może oznaczać, że zakres w danym projekcie w ogóle nie występuje —
// wtedy zmuszanie do kwoty nie ma sensu. Puste wiersze (bez nazwy i podpozycji) pomijamy.
function brakiCashflowu(harmonogram) {
  const braki = [];
  (harmonogram || []).forEach((w, i) => {
    const istotna = (w.zadanie || "").trim() || maPodpozycje(w);
    if (!istotna) return;
    const ef = efektywnyWiersz(w);
    if (!ef.start || !ef.koniec) return; // brak dat = zakres nie występuje → kwota niewymagana
    if (!(kwotaZadania(w) > 0)) braki.push(`${i + 1}. ${w.zadanie || "(pozycja)"}`);
  });
  return braki;
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
        <div style={{ marginTop: 8, padding: "8px 12px", background: "#FBECEA", border: "1px solid #E0B4B4", borderRadius: 6, fontSize: 12, color: "#B22222" }}>
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

/* ============================================================================
   WERSJA ROBOCZA (auto-zapis w przeglądarce)
   ---------------------------------------------------------------------------
   Chroni wpisaną treść przed utratą przy przypadkowym zamknięciu/odświeżeniu
   przeglądarki. Trzymamy CAŁY formularz (łącznie ze zdjęciami base64) w
   IndexedDB — w przeciwieństwie do localStorage nie ma tu limitu ~5 MB, więc
   zdjęcia też przeżywają. Jeden rekord („aktualny") = bieżąca, niezapisana praca.
   ========================================================================== */
const DRAFT_DB = "abyard_raporty";
const DRAFT_STORE = "wersje_robocze";
const DRAFT_KLUCZ = "aktualny";

function otworzDraftDB() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("brak IndexedDB")); return; }
    const req = indexedDB.open(DRAFT_DB, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE); };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function zapiszDraftIDB(dane) {
  const db = await otworzDraftDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).put(dane, DRAFT_KLUCZ);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
  db.close();
}
async function wczytajDraftIDB() {
  const db = await otworzDraftDB();
  const wynik = await new Promise((res, rej) => {
    const tx = db.transaction(DRAFT_STORE, "readonly");
    const r = tx.objectStore(DRAFT_STORE).get(DRAFT_KLUCZ);
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
  db.close();
  return wynik;
}
async function usunDraftIDB() {
  const db = await otworzDraftDB();
  await new Promise((res) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).delete(DRAFT_KLUCZ);
    tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
  });
  db.close();
}
// Czy formularz ma treść wartą zapisania (żeby nie tworzyć pustej wersji roboczej)?
function maDraftTresc(f) {
  if (!f) return false;
  const teksty = ["projekt", "adres", "tytulZadania", "infoOgolne", "opoznienia", "wykonawcy", "przetargi", "sprawyBudowy", "sprawyInwestora", "placBudowy", "rozpoczecie", "zakonczenieRobot", "pnu", "okresOd", "okresDo"];
  if (teksty.some((k) => (f[k] || "").toString().replace(/<[^>]*>/g, "").trim().length > 0)) return true;
  if ((f.zdjecia || []).length || (f.harmonogramObrazy || []).length || f.grafikaInwestycji) return true;
  if (Array.isArray(f.harmonogram) && f.harmonogram.some((r) => r && (r.zadanie || r.start || r.koniec || r.rzecz || (r.proc !== "" && r.proc != null)))) return true;
  return false;
}

// Globalna paleta aplikacji — ujednolicona z abyard.com i z raportem:
// ciepła czerń + złocisty amber jako jedyny akcent, mono do etykiet/overline'ów.
const C = {
  zolty: "#F2A900",
  zoltyBright: "#FBC441",
  zoltyDeep: "#C8880B",
  czarny: "#0F0F0E",
  ink2: "#191917",
  grafit: "#232320",
  szary: "#6E6A62",
  szary2: "#9A958B",
  jasny: "#F4F3EF",
  bialy: "#FFFFFF",
  linia: "#E4E1D9",
  zoltyJasny: "#FFF6DF",
  czerwony: "#C0392B",
  zielony: "#1B7A3D",
  mono: "'AbyMono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

// Paleta PODGLĄDU RAPORTU (odwzorowuje dokładnie eksport PDF / abyard.com).
// Osobna od globalnej `C`, żeby zmiana designu raportu nie ruszała reszty
// aplikacji (nawigacja, formularze, panele).
const CR = {
  ink: "#0F0F0E", ink2: "#191917", gold: "#F2A900", goldBright: "#FBC441", goldDeep: "#C8880B",
  card: "#FFFFFF", line: "#E4E1D9", muted: "#6E6A62", muted2: "#9A958B",
  danger: "#C0392B", ok: "#1B7A3D", band: "#FFF6DF", callout: "#FFF8EC", foot: "#FBF3DF",
  mono: "'AbyMono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

// Overline sekcji podglądu: „/ TYTUŁ" (mono, amber) + hairline + opcjonalny podpis.
function Overline({ tytul, idx }) {
  return (
    <div className="blokpdf-naglowek" style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 10, breakAfter: "avoid", pageBreakAfter: "avoid", breakInside: "avoid", pageBreakInside: "avoid" }}>
      <div style={{ fontFamily: CR.mono, fontSize: 12.5, letterSpacing: "0.13em", color: CR.goldDeep, whiteSpace: "nowrap", flexShrink: 0 }}>
        <span style={{ color: CR.gold, fontWeight: 700 }}>/ </span>{String(tytul).toUpperCase()}
      </div>
      <div style={{ flex: 1, height: 1, background: CR.line, marginBottom: 5 }} />
      {idx && <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted2, flexShrink: 0, marginBottom: 1 }}>{idx}</div>}
    </div>
  );
}

// Nagłówek ekranu w języku abyard.com: mono eyebrow „/ X", wielki tytuł
// (Roboto Black) z opcjonalną złotą liczbą, podtytuł. Po prawej opcjonalne akcje.
function NaglowekEkranu({ eyebrow, tytul, num, sub, akcje }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: C.mono, fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: C.zoltyDeep }}>
          <span style={{ color: C.zolty, fontWeight: 700 }}>/</span> {eyebrow}
        </div>
        <h1 style={{ fontFamily: "'Roboto', system-ui, sans-serif", fontWeight: 900, fontSize: 30, letterSpacing: "-0.02em", color: C.czarny, margin: "6px 0 0", textWrap: "balance" }}>
          {tytul}{num != null && <span style={{ color: C.zolty }}> {num}</span>}
        </h1>
        {sub && <p style={{ color: C.szary, fontSize: 13.5, margin: "6px 0 0", lineHeight: 1.5 }}>{sub}</p>}
      </div>
      {akcje && <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>{akcje}</div>}
    </div>
  );
}

// Status jako chip-pigułka z kropką (mono, uppercase) — spójne z mockupem.
// wariant: "warn" (zagrożenie, czerwony) | "ok" (zielony) | "hold" (wstrzymana, bursztyn) | "neutral".
function Chip({ wariant = "neutral", children, title }) {
  const M = {
    warn: { kolor: C.czerwony, tlo: "#FBECEA" },
    ok: { kolor: C.zielony, tlo: "#E6F3EA" },
    hold: { kolor: "#B9791A", tlo: "#FBF0DC" },
    neutral: { kolor: C.szary, tlo: C.jasny },
  }[wariant] || { kolor: C.szary, tlo: C.jasny };
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: C.mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, padding: "5px 10px", borderRadius: 999, color: M.kolor, background: M.tlo, whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor", flexShrink: 0 }} />
      {children}
    </span>
  );
}

// Pasek postępu (zaawansowanie) — cienki, złoty; z opcjonalnym podpisem pod spodem.
function PasekPostepu({ proc, etykieta, szer = 120 }) {
  const p = Math.max(0, Math.min(100, Number(proc) || 0));
  const pelny = p >= 100;
  return (
    <div style={{ width: szer }}>
      <div style={{ height: 6, borderRadius: 3, background: C.linia, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${p}%`, background: pelny ? C.zielony : C.zolty }} />
      </div>
      {etykieta !== undefined && (
        <div style={{ fontFamily: C.mono, fontSize: 10, color: C.szary, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
          <span>{etykieta}</span><span>{proc == null ? "—" : `${p}%`}</span>
        </div>
      )}
    </div>
  );
}

// Overline sekcji w panelach (mono „/ TYTUŁ", amber) — spójny z designem abyard.com.
function TytulSekcji({ children }) {
  return (
    <div style={secTitle}><span style={{ color: C.zolty, fontWeight: 700 }}>/ </span>{children}</div>
  );
}

// Przełącznik-pigułka (segmentowy) w stylu abyard.com: mono, uppercase, aktywny =
// ciemne tło + jasnozłoty tekst. opcje: [[wartosc, etykieta], ...].
function PigulkaPrzelacznik({ opcje, wartosc, onZmiana }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.linia}`, borderRadius: 999, overflow: "hidden", fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {opcje.map(([val, et]) => {
        const akt = wartosc === val;
        return (
          <button key={String(val)} onClick={() => onZmiana(val)}
            style={{ border: "none", background: akt ? C.czarny : C.bialy, color: akt ? C.zoltyBright : C.szary,
              fontWeight: akt ? 700 : 400, padding: "7px 13px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "inherit", textTransform: "inherit" }}>
            {et}
          </button>
        );
      })}
    </div>
  );
}

// Wspólny pasek nawigacji — jeden dla wszystkich widoków (formularz, archiwum, panel).
// aktywny: "form" | "archiwum" | "admin". Zakładka panelu tylko dla admina.
function PasekNawigacji({ aktywny, jestAdmin, email, onForm, onArchiwum, onKoordynacja, onAdmin, onWyloguj }) {
  const zakl = (kod, etykieta, onClick) => {
    const akt = aktywny === kod;
    return (
      <button onClick={onClick}
        style={{ background: akt ? C.zolty : "transparent", color: akt ? "#161512" : "#CFCCC5",
          border: `1px solid ${akt ? C.zolty : "rgba(255,255,255,0.12)"}`, padding: "8px 13px", borderRadius: 4,
          fontWeight: akt ? 700 : 400, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase",
          fontFamily: C.mono, cursor: "pointer" }}>
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
          <span style={{ color: "#8A867E", fontFamily: C.mono, fontSize: 11, display: "flex", alignItems: "center", gap: 8, marginLeft: 4 }}>
            {email}
            {jestAdmin && <span style={{ background: C.zolty, color: "#161512", fontWeight: 700, fontSize: 9, letterSpacing: "0.06em", padding: "2px 6px", borderRadius: 3 }}>ADMIN</span>}
          </span>
          <button onClick={onWyloguj}
            style={{ background: "transparent", color: "#8A867E", fontFamily: C.mono, border: `1px solid rgba(255,255,255,0.12)`, padding: "6px 12px", borderRadius: 4, fontSize: 10.5, cursor: "pointer" }}>
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

// Usuwa POGRUBIENIE z HTML pola rich-text (zachowuje kursywę, podkreślenie, treść).
// Pogrubienie w formularzu oznacza „nowe informacje w tym raporcie" — przy wczytaniu
// poprzedniego raportu (baza nowego) odziedziczona treść nie jest już „nowa", więc
// pogrubienia znikają; PM pogrubia dopiero to, co dopisze w bieżącym raporcie.
function usunPogrubienie(html) {
  if (!html || typeof document === "undefined") return html || "";
  const div = document.createElement("div");
  div.innerHTML = html;
  // rozwiń znaczniki <b>/<strong> (zostaw ich zawartość)
  div.querySelectorAll("b, strong").forEach((el) => {
    const rodzic = el.parentNode;
    while (el.firstChild) rodzic.insertBefore(el.firstChild, el);
    rodzic.removeChild(el);
  });
  // usuń font-weight z inline-styli (np. <span style="font-weight:bold">)
  div.querySelectorAll("[style]").forEach((el) => {
    if (/font-weight/i.test(el.getAttribute("style") || "")) {
      el.style.fontWeight = "";
      if (!(el.getAttribute("style") || "").trim()) el.removeAttribute("style");
    }
  });
  return div.innerHTML;
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
  // Czy formularz ma zmiany niezapisane w bazie? Blokuje „Generuj raport", dopóki
  // PM nie zapisze (częsty błąd: dodają zdjęcia i generują raport bez zapisu).
  const [niezapisaneZmiany, setNiezapisaneZmiany] = useState(false);
  const pomijajDirtyRef = useRef(false); // pomiń najbliższe oznaczenie „dirty" (po programowym załadowaniu)
  const draftGotowyRef = useRef(false);  // czy próba przywrócenia wersji roboczej już się odbyła (dopiero potem auto-zapis)
  const draftTimerRef = useRef(null);    // debouncer auto-zapisu wersji roboczej
  // Pomija najbliższą auto-aktualizację „daty zakończenia robót" z harmonogramu —
  // ustawiane przy PROGRAMOWYM wczytaniu formularza (wybór budowy, edycja z archiwum,
  // wersja robocza, wyczyszczenie), żeby nie nadpisać wczytanej/ręcznie ustawionej daty.
  const harmProgRef = useRef(false);
  const [przywroconoDraft, setPrzywroconoDraft] = useState(null); // {ts} — pasek „przywrócono wersję roboczą"
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
  // Zbiór id budów, do których bieżący użytkownik jest przypisany — do sprawdzania,
  // czy PM może edytować raport w oknie odblokowanym przez admina.
  const mojeProjektyIds = React.useMemo(
    () => new Set((mojePrzypisania || []).map((x) => x.projekt_id)),
    [mojePrzypisania]
  );
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

  // „Data zakończenia robót" (Kluczowe daty) auto-synchronizuje się z najpóźniejszą
  // planowaną datą zakończenia z harmonogramu. Przy każdej ZMIANIE harmonogramu przez
  // użytkownika nadpisuje pole (można je potem ręcznie zmienić — zmiana utrzyma się do
  // następnej edycji harmonogramu). Programowe wczytania (wybór budowy, edycja z archiwum,
  // wersja robocza) są pomijane przez harmProgRef, by nie kasować wczytanej/ręcznej daty.
  useEffect(() => {
    if (harmProgRef.current) { harmProgRef.current = false; return; }
    setForm((f) => {
      const najp = najpozniejszePlanowaneZakonczenie(f.harmonogram);
      return najp && najp !== f.zakonczenieRobot ? { ...f, zakonczenieRobot: najp } : f;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.harmonogram]);

  // Gdy opóźnienie w harmonogramie opóźnia zakończenie CAŁEGO projektu — wymuś status
  // „zagrożenie" (w formularzu opcja „nie powoduje zagrożenia" jest wtedy zablokowana).
  useEffect(() => {
    if (harmonogramWymuszaZagrozenie(form.harmonogram, form.dataOpracowania)
        && form.podsumowanie !== PODSUMOWANIE_OPCJE[1]) {
      setForm((f) => ({ ...f, podsumowanie: PODSUMOWANIE_OPCJE[1] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.harmonogram, form.dataOpracowania]);

  // Śledzenie niezapisanych zmian: każda zmiana formularza (pola, harmonogram,
  // zdjęcia, grafika) idzie przez setForm, więc wystarczy obserwować `form`.
  // Programowe załadowanie (wczytanie raportu do edycji) ustawia pomijajDirtyRef,
  // by nie liczyć się jako zmiana użytkownika. Zapis czyści flagę bezpośrednio.
  useEffect(() => {
    if (pomijajDirtyRef.current) {
      pomijajDirtyRef.current = false;
      setNiezapisaneZmiany(false);
      return;
    }
    setNiezapisaneZmiany(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // ---- WERSJA ROBOCZA: przywrócenie przy starcie -----------------------------
  // Raz, przy montowaniu: jeśli w przeglądarce jest niezapisana wersja robocza,
  // wczytujemy ją do formularza i pokazujemy pasek informacyjny. Dopiero po tej
  // próbie włączamy auto-zapis (żeby pusty formularz nie nadpisał wersji roboczej).
  useEffect(() => {
    let anulowane = false;
    wczytajDraftIDB()
      .then((d) => {
        if (anulowane) return;
        if (d && d.form && maDraftTresc(d.form)) {
          harmProgRef.current = true; // wczytanie wersji roboczej — nie nadpisuj daty zakończenia
          setForm(d.form); // brak pomijajDirtyRef → traktujemy jako niezapisane zmiany
          if (d.zapisanyId) setZapisanyId(d.zapisanyId);
          if (typeof d.cashflowWlaczony === "boolean") setCashflowWlaczony(d.cashflowWlaczony);
          setPrzywroconoDraft({ ts: d.ts || null });
        }
      })
      .catch(() => {})
      .finally(() => { if (!anulowane) draftGotowyRef.current = true; });
    return () => { anulowane = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- WERSJA ROBOCZA: auto-zapis przy każdej zmianie (z opóźnieniem) ---------
  // Zapisujemy CAŁY formularz (ze zdjęciami) do IndexedDB. Debounce 800 ms, żeby
  // nie pisać przy każdym znaku. Pusty formularz kasuje wersję roboczą.
  useEffect(() => {
    if (!draftGotowyRef.current) return;
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (maDraftTresc(form)) {
        zapiszDraftIDB({ form, zapisanyId, cashflowWlaczony, ts: Date.now() }).catch(() => {});
      } else {
        usunDraftIDB().catch(() => {});
      }
    }, 800);
    return () => clearTimeout(draftTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, zapisanyId, cashflowWlaczony]);

  // Ręczne wyczyszczenie formularza (kasuje też wersję roboczą).
  function wyczyscFormularz() {
    if (!window.confirm("Wyczyścić formularz? Wpisana treść i wersja robocza zostaną usunięte. Zapisane w bazie raporty pozostają nietknięte.")) return;
    pomijajDirtyRef.current = true; // reset do pustego to nie „zmiana użytkownika"
    harmProgRef.current = true; // reset do pustego — nie wywołuj auto-daty zakończenia
    setForm({ ...PUSTY_RAPORT, dataOpracowania: dzisISO(), opracowal: nazwaZalogowanego });
    setZapisanyId(null);
    setCashflowWlaczony(false);
    setNiezapisaneZmiany(false);
    setPrzywroconoDraft(null);
    wczytanaBudowaRef.current = null;
    usunDraftIDB().catch(() => {});
  }

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
        // Pogrubienie oznacza „nowe informacje w tym raporcie". Treść odziedziczona po
        // poprzednim raporcie nie jest już nowa — czyścimy pogrubienia w polach opisowych,
        // by PM pogrubiał od zera to, co dopisze w bieżącym raporcie.
        const POLA_OPISOWE = ["infoOgolne", "opoznienia", "wykonawcy", "przetargi", "sprawyBudowy", "sprawyInwestora", "placBudowy"];
        const bezPogrubien = {};
        for (const k of POLA_OPISOWE) bezPogrubien[k] = usunPogrubienie(bazowy[k]);
        harmProgRef.current = true; // wczytanie poprzedniego raportu — nie nadpisuj daty (jest wczytana)
        setForm({
          ...bazowy,
          ...bezPogrubien,
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
        // Kolejny raport: cashflow włączony tylko, gdy poprzedni raport miał kwoty.
        setCashflowWlaczony(harmonogramMaKwoty(bazowy.harmonogram));
        pokazToast(`Wczytano dane z raportu nr ${ost.numer} — do aktualizacji`);
      } else {
        // pierwszy raport tej budowy — czysty formularz (nie zostawiamy danych z poprzedniej budowy)
        harmProgRef.current = true; // pusty formularz — nie wywołuj auto-daty zakończenia
        setForm({
          ...PUSTY_RAPORT,
          projekt: nazwa,
          numer: "1",
          dataOpracowania: dzisISO(),
          opracowal: nazwaZalogowanego || PUSTY_RAPORT.opracowal,
        });
        plikiRef.current = { grafika: null, harm: [], zdjecia: [] };
        // Pierwszy raport nowej inwestycji: cashflow domyślnie WŁĄCZONY (można wyłączyć).
        // To on ustanawia finansową bazę projektu, dziedziczoną przez kolejne raporty.
        setCashflowWlaczony(true);
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
    // Egzekwowanie obowiązkowego cashflow dla PIERWSZEGO raportu inwestycji.
    // Raport nr 1 ustanawia bazę finansową (wartości umowy pozycji harmonogramu),
    // którą dziedziczą kolejne raporty tej budowy — dlatego musi być kompletny:
    // cashflow włączony i KAŻDA pozycja harmonogramu z wartością umowy > 0.
    // Egzekwujemy TYLKO przy pierwszym utworzeniu raportu nr 1 (jeszcze nie zapisany
    // w tej sesji ani nie otwarty do edycji z archiwum). Dzięki temu edycja starego
    // (legacy) raportu nr 1 bez cashflow — np. poprawka literówki — nie jest blokowana.
    const pierwszyRaport = (parseInt(form.numer, 10) || 0) === 1 && !zapisanyId;
    if (pierwszyRaport) {
      // Cashflow musi realnie istnieć: włączony ORAZ z jakąkolwiek wartością umowy.
      // Sam warunek `cashflowWlaczony` nie wystarczy — pusty/nietknięty harmonogram
      // (PUSTY_RAPORT.harmonogram = null) przeszedłby blokadę mimo zera cashflow.
      if (!cashflowWlaczony || !harmonogramMaKwoty(form.harmonogram)) {
        window.alert(
          "Nie można zapisać pierwszego raportu tej inwestycji bez cashflow.\n\n" +
          "Cashflow (wartości umowy pozycji harmonogramu) jest obowiązkowy dla raportu nr 1 — " +
          "ustanawia bazę finansową dziedziczoną przez kolejne raporty tej budowy.\n\n" +
          "Włącz cashflow w sekcji harmonogramu i uzupełnij wartości umowy przy pozycjach."
        );
        return;
      }
      const braki = brakiCashflowu(form.harmonogram);
      if (braki.length > 0) {
        const lista = braki.slice(0, 12).join("\n");
        const wiecej = braki.length > 12 ? `\n…i ${braki.length - 12} więcej` : "";
        window.alert(
          "Nie można zapisać pierwszego raportu tej inwestycji.\n\n" +
          "Uzupełnij wartość umowy (cashflow) dla każdej pozycji harmonogramu, która ma wpisane daty. " +
          "Pozycje bez dat (zakres nie występuje) pomijamy. Brakuje:\n\n" +
          `${lista}${wiecej}`
        );
        return;
      }
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
      setNiezapisaneZmiany(false); // stan formularza = stan w bazie → „Generuj raport" odblokowany
      setPrzywroconoDraft(null);
      usunDraftIDB().catch(() => {}); // praca jest już w bazie — wersja robocza niepotrzebna
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

  // Czy można generować raport? Tylko gdy jest zapisany w bazie i nie ma zmian
  // niezapisanych — inaczej PM wygenerowałby raport bez świeżo dodanych zdjęć.
  const mozeGenerowac = !!zapisanyId && !niezapisaneZmiany;
  // Pierwszy raport inwestycji (nr 1), świeżo tworzony (nie z edycji archiwum) —
  // tylko dla niego cashflow jest obowiązkowy (spójne z blokadą zapisu poniżej).
  const pierwszyRaportForm = (parseInt(form.numer, 10) || 0) === 1 && !zapisanyId;

  // Otwiera podgląd raportu — tam użytkownik wybiera: zapis do PDF lub link
  // dla inwestora (druk nie odpala się już automatycznie).
  function generujPDF() {
    if (!mozeGenerowac) {
      pokazToast(zapisanyId
        ? "Masz niezapisane zmiany — najpierw zapisz raport"
        : "Najpierw zapisz raport w bazie, potem go wygenerujesz");
      return;
    }
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
  async function wczytajArchiwum({ ciche = false } = {}) {
    if (!ciche) setArchLadowanie(true);
    try {
      const dane = await listaWszystkichRaportow();
      setArchRaporty(dane);
    } catch (e) {
      console.error(e);
      if (!ciche) {
        pokazToast("Nie udało się wczytać archiwum z bazy");
        setArchRaporty([]);
      }
    } finally {
      if (!ciche) setArchLadowanie(false);
    }
  }

  // Gdy Archiwum jest otwarte — odświeżaj listę w tle (co 45s), by admini widzieli
  // na bieżąco odblokowania edycji ustawione przez innych i by odliczanie „zostało
  // ~Xh" nie zastygało. Ciche odświeżenie nie miga overlayem „Wczytywanie…".
  useEffect(() => {
    if (widok !== "archiwum") return;
    const t = setInterval(() => { wczytajArchiwum({ ciche: true }); }, 45000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widok]);
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

  // Edycja raportu z archiwum. Wczytuje raport do formularza.
  // Czy bieżący użytkownik może edytować dany raport (obiekt z listy archiwum).
  //  - admin: zawsze,
  //  - autor: przez 24h od utworzenia,
  //  - okno przyznane przez admina (edycja_do w przyszłości): autor ORAZ PM
  //    przypisani do tej budowy.
  // Zwraca timestamp (ms) końca aktywnego okna edycji dla bieżącego użytkownika,
  // albo 0 gdy nie może edytować. Admin nie ma odliczania (zwraca 0).
  function koniecOknaEdycji(r) {
    if (!r || profil?.rola === "admin") return 0;
    const teraz = Date.now();
    const jestAutorem = !!profil?.id && r.utworzony_przez === profil.id;
    let koniec = 0;
    // Okno 24h od utworzenia — tylko autor.
    if (jestAutorem && r.utworzono) {
      const kon24 = new Date(r.utworzono).getTime() + 24 * 3600 * 1000;
      if (kon24 > teraz) koniec = Math.max(koniec, kon24);
    }
    // Okno przyznane przez admina — autor lub PM przypisany do budowy.
    if (r.edycja_do) {
      const konAdmin = new Date(r.edycja_do).getTime();
      const przypisany = mojeProjektyIds.has(r.projekt_id);
      if (konAdmin > teraz && (jestAutorem || przypisany)) koniec = Math.max(koniec, konAdmin);
    }
    return koniec;
  }

  function mozeEdytowac(r) {
    if (!r) return false;
    if (profil?.rola === "admin") return true;
    return koniecOknaEdycji(r) > Date.now();
  }

  // Pozostały czas edycji dla PM w pełnych godzinach (zaokrąglony w górę).
  // Zwraca null gdy nie dotyczy (admin / brak okna / już po czasie).
  function godzinyDoEdycji(r) {
    if (!r || profil?.rola === "admin") return null;
    const zostalo = koniecOknaEdycji(r) - Date.now();
    if (zostalo <= 0) return null;
    return Math.ceil(zostalo / (3600 * 1000));
  }

  // Odblokowanie edycji raportu przez admina na 24h (autor + przypisani PM).
  async function pozwolNaEdycje(r) {
    if (!r?.id) return;
    const doKiedy = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    try {
      await ustawOknoEdycji(r.id, doKiedy);
      pokazToast(`Edycja raportu nr ${r.numer} odblokowana na 24h`);
      await wczytajArchiwum();
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się odblokować edycji");
    }
  }

  // Cofnięcie odblokowania (admin) — zamyka okno edycji od razu.
  async function cofnijPozwolenieEdycji(r) {
    if (!r?.id) return;
    try {
      await ustawOknoEdycji(r.id, null);
      pokazToast(`Edycja raportu nr ${r.numer} zamknięta`);
      await wczytajArchiwum();
    } catch (e) {
      console.error(e);
      pokazToast("Nie udało się zamknąć edycji");
    }
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
      pomijajDirtyRef.current = true;    // to wczytanie to nie zmiana użytkownika
      harmProgRef.current = true;        // edycja z archiwum — nie nadpisuj zapisanej daty zakończenia
      setForm(f);
      // Stan cashflow ustaw jawnie wg wczytanego raportu (inaczej mógłby „zawisnąć"
      // na true z poprzedniej pracy i pokazać pustą kolumnę wartości dla raportu bez kwot).
      setCashflowWlaczony(harmonogramMaKwoty(f.harmonogram));
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
    // raportId = zapisanyId: linki do raportu dostępne, gdy raport jest już w bazie
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
        onPozwolEdycje={pozwolNaEdycje}
        onCofnijEdycje={cofnijPozwolenieEdycji}
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

      <main className="ekran-formularz" style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 120px" }}>

        {przywroconoDraft && (
          <div style={{ marginBottom: 16, padding: "10px 16px", background: C.zoltyJasny, border: `1px solid ${C.zolty}`, borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13, flexWrap: "wrap" }}>
            <span>↩︎ <strong>Przywrócono niezapisaną wersję roboczą</strong>{przywroconoDraft.ts ? ` (z ${new Date(przywroconoDraft.ts).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})` : ""}. Kontynuuj pracę albo wyczyść formularz.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={miniBtn} onClick={() => setPrzywroconoDraft(null)}>OK, kontynuuję</button>
              <button style={{ ...miniBtn, borderColor: C.czerwony, color: C.czerwony, fontWeight: 700 }} onClick={wyczyscFormularz}>Wyczyść</button>
            </div>
          </div>
        )}

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
                  <button style={{ ...miniBtn, color: "#C0392B", borderColor: "#E0B4B4" }} onClick={usunGrafike}>Usuń grafikę</button>
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
                          <span style={{ color: C.zolty, marginRight: 6, fontSize: 8, verticalAlign: "middle" }}>●</span>{r.zadanie}
                          {wymaga && <div style={{ fontSize: 11, color: "#C0392B", fontWeight: 600, marginTop: 2 }}>⚠ uzupełnij prognozę</div>}
                        </td>
                        {sumaryczny ? (
                          <>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 600, color: C.czarny }}>{fmtPL(ef.start) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 600, color: C.czarny }}>{fmtPL(ef.koniec) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 700, color: C.czarny, background: C.zoltyJasny }}>{fmtPL(ef.rzecz) || "—"}</td>
                            <td style={{ ...tdHarm, textAlign: "center", fontWeight: 700, color: C.czarny }}>{ef.proc !== "" ? `${ef.proc}%` : "—"}</td>
                          </>
                        ) : (
                          <>
                            <td style={tdHarm}><input type="date" style={cellInp} value={r.start} onChange={(e) => updHarm(i, "start", e.target.value)} /></td>
                            <td style={tdHarm}><input type="date" style={cellInp} value={r.koniec} onChange={(e) => updHarm(i, "koniec", e.target.value)} /></td>
                            <td style={{ ...tdHarm, background: C.zoltyJasny }}><input type="date" style={{ ...cellInp, background: "transparent", fontWeight: 700, ...(wymaga ? { border: "2px solid #C0392B", outline: "none" } : {}) }} value={r.rzecz} onChange={(e) => updHarm(i, "rzecz", e.target.value)} /></td>
                            <td style={tdHarm}><input type="number" min="0" max="100" style={{ ...cellInp, width: 64, textAlign: "center" }} value={r.proc} onChange={(e) => updHarm(i, "proc", e.target.value)} placeholder="—" /></td>
                          </>
                        )}
                        <td style={{ ...tdHarm, textAlign: "center", color: op ? "#C0392B" : C.szary, fontWeight: op ? 700 : 400 }}>{op || "—"}</td>
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
                            {wymagaP && <div style={{ fontSize: 10, color: "#C0392B", fontWeight: 600, marginTop: 2 }}>⚠ uzupełnij prognozę</div>}
                          </td>
                          <td style={tdHarm}><input type="date" style={cellInp} value={p.start} onChange={(e) => updPodpozycje(i, j, "start", e.target.value)} /></td>
                          <td style={tdHarm}><input type="date" style={cellInp} value={p.koniec} onChange={(e) => updPodpozycje(i, j, "koniec", e.target.value)} /></td>
                          <td style={tdHarm}><input type="date" style={{ ...cellInp, ...(wymagaP ? { border: "2px solid #B22", outline: "none" } : {}) }} value={p.rzecz} onChange={(e) => updPodpozycje(i, j, "rzecz", e.target.value)} /></td>
                          <td style={tdHarm}><input type="number" min="0" max="100" style={{ ...cellInp, width: 64, textAlign: "center" }} value={p.proc} onChange={(e) => updPodpozycje(i, j, "proc", e.target.value)} placeholder="—" /></td>
                          <td style={{ ...tdHarm, textAlign: "center", color: obliczOpoznienie(p, form.dataOpracowania) ? "#C0392B" : C.szary, fontSize: 12 }}>{obliczOpoznienie(p, form.dataOpracowania) || "—"}</td>
                          {cashflowWlaczony && <td style={tdHarm}><input type="number" min="0" step="1000" style={{ ...cellInp, width: 110, textAlign: "right" }} value={p.kwota || ""} onChange={(e) => updPodpozycje(i, j, "kwota", e.target.value)} placeholder="—" /></td>}
                          <td style={{ ...tdHarm, textAlign: "center" }}>
                            <button type="button" onClick={() => usunPodpozycje(i, j)} title="Usuń podpozycję"
                              style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 4, cursor: "pointer", fontSize: 14, lineHeight: 1, width: 26, height: 26, color: "#C0392B" }}>×</button>
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
                <label style={lbl}>Cashflow sprzedażowy (wartość umowy rozłożona w czasie)
                  {pierwszyRaportForm && <span style={{ marginLeft: 8, fontFamily: C.mono, fontSize: 9, fontWeight: 700, color: C.czerwony, background: "#FBECEA", padding: "2px 7px", borderRadius: 999, letterSpacing: "0.06em" }}>WYMAGANE — RAPORT NR 1</span>}
                </label>
                {pierwszyRaportForm && (
                  <p style={{ fontSize: 12.5, color: C.czerwony, marginTop: 2, marginBottom: 8, lineHeight: 1.5 }}>
                    To pierwszy raport tej inwestycji — cashflow jest obowiązkowy. Ustanawia bazę finansową dziedziczoną przez kolejne raporty. Wartość umowy trzeba podać przy każdej pozycji harmonogramu, która ma wpisane daty (pozycje bez dat pomijamy).
                  </p>
                )}
                <p style={{ fontSize: 12, color: C.szary, marginTop: -2, marginBottom: 10 }}>
                  Włącz, aby przy zadaniach harmonogramu pojawiła się kolumna „Wartość umowy". Na jej podstawie oraz dat i procentu zaawansowania powstanie miesięczne zestawienie sprzedaży (narastająco). Kwoty można podać na zadaniu głównym lub podpozycjach.
                </p>
                <button style={pierwszyRaportForm ? btnPrimary : btnGhost} onClick={() => setCashflowWlaczony(true)}>+ Utwórz cashflow</button>
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                  <label style={{ ...lbl, marginBottom: 0 }}>Cashflow sprzedażowy
                    {pierwszyRaportForm && <span style={{ marginLeft: 8, fontFamily: C.mono, fontSize: 9, fontWeight: 700, color: C.czerwony, background: "#FBECEA", padding: "2px 7px", borderRadius: 999, letterSpacing: "0.06em" }}>WYMAGANE — RAPORT NR 1</span>}
                  </label>
                  <button style={{ ...miniBtn, color: "#C0392B", borderColor: "#E0B4B4" }}
                    onClick={() => {
                      const ostrz = pierwszyRaportForm
                        ? "Cashflow jest OBOWIĄZKOWY dla pierwszego raportu inwestycji — bez niego nie zapiszesz raportu. Wyłączyć mimo to? Wpisane wartości umowy zostaną usunięte."
                        : "Wyłączyć cashflow? Wpisane wartości umowy zostaną usunięte z tego raportu.";
                      if (window.confirm(ostrz)) { wyczyscKwoty(); setCashflowWlaczony(false); }
                    }}>
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
                    <button style={{ ...miniBtn, color: "#C0392B", borderColor: "#E0B4B4" }} onClick={() => usunZdjecie(i)}>Usuń</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Sekcja>

        {/* Podsumowanie */}
        <Sekcja tytul="Podsumowanie (wymagany wybór)">
          {(() => {
            const wymuszone = harmonogramWymuszaZagrozenie(form.harmonogram, form.dataOpracowania);
            return (
              <>
                {PODSUMOWANIE_OPCJE.map((opt, idx) => {
                  const zablokowana = wymuszone && idx === 0; // „nie powoduje zagrożenia" — niedostępne
                  return (
                    <label key={opt} style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 14, cursor: zablokowana ? "not-allowed" : "pointer", alignItems: "flex-start", opacity: zablokowana ? 0.5 : 1 }}>
                      <input
                        type="radio"
                        name="podsum"
                        checked={form.podsumowanie === opt}
                        onChange={() => {
                          if (zablokowana) {
                            window.alert("Występujące opóźnienie w harmonogramie powoduje zagrożenie terminu zakończenia całości projektu. Nie można wybrać opcji „nie powoduje zagrożenia”.");
                            return;
                          }
                          upd("podsumowanie", opt);
                        }}
                        style={{ marginTop: 3, accentColor: C.czarny }}
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
                {wymuszone && (
                  <div style={{ marginTop: 2, fontSize: 12.5, color: "#C0392B", background: "#FBECEA", borderLeft: "3px solid #B22", padding: "8px 12px", borderRadius: 4 }}>
                    Opóźnienie w harmonogramie opóźnia zakończenie całości projektu — status „zagrożenie” jest ustawiony automatycznie i zablokowany.
                  </div>
                )}
              </>
            );
          })()}
        </Sekcja>

      </main>

      {/* Dolny pasek akcji */}
      <footer style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.bialy, borderTop: `1px solid ${C.linia}`, boxShadow: "0 -2px 10px rgba(0,0,0,0.05)", zIndex: 20 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: C.szary, maxWidth: 460, lineHeight: 1.45 }}>
            {niezapisaneZmiany
              ? <><strong>Masz niezapisane zmiany.</strong> Zapisz raport, aby móc go wygenerować (inaczej pominiesz np. dodane zdjęcia).</>
              : zapisanyId
                ? "Raport zapisany — możesz go wygenerować. Kolejny zapis nadpisze (aktualizacja)."
                : <>Najpierw <strong>zapisz raport w bazie</strong> — dopiero wtedy odblokuje się „Generuj raport".</>}
          </span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...btnGhost, borderColor: C.linia, color: C.szary }} onClick={wyczyscFormularz} disabled={zapisywanie} title="Wyczyść widoczny formularz (i wersję roboczą). Zapisane raporty w bazie zostają.">
              Wyczyść
            </button>
            <button style={btnGhost} onClick={zapiszArchiwum} disabled={zapisywanie}>
              {zapisywanie ? "Zapisywanie…" : zapisanyId ? "Aktualizuj raport" : "Zapisz raport w bazie"}
            </button>
            <button
              style={mozeGenerowac ? btnPrimary : { ...btnPrimary, opacity: 0.45, cursor: "not-allowed" }}
              onClick={generujPDF}
              disabled={!mozeGenerowac}
              title={mozeGenerowac ? "" : (zapisanyId ? "Masz niezapisane zmiany — najpierw zapisz raport" : "Najpierw zapisz raport w bazie")}
            >Generuj raport →</button>
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

  const loginInp = { ...inp, background: C.ink2, border: "1px solid rgba(255,255,255,0.12)", color: C.bialy, marginBottom: 0 };
  const loginLab = { ...lbl, color: C.zoltyDeep };
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.czarny, fontFamily: "'Roboto', 'Segoe UI', system-ui, sans-serif", padding: 20 }}>
      <style>{globalCSS}</style>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ fontWeight: 900, fontSize: 30, color: C.bialy, letterSpacing: "-0.01em" }}>
          <span style={{ color: C.zolty }}>/</span>Abyard
        </div>
        <div style={{ fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.2em", textTransform: "uppercase", color: C.szary2, marginTop: 6 }}>/ Generator raportów z budowy</div>

        <h2 style={{ fontWeight: 900, fontSize: 34, color: C.bialy, margin: "30px 0 22px", letterSpacing: "-0.01em" }}>{tytul}</h2>

        <div style={{ marginBottom: 16 }}>
          <label style={loginLab}>Adres e-mail</label>
          <input style={loginInp} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="np. jkowalski@abyard.pl" autoComplete="username" />
        </div>

        {tryb !== "reset" && (
          <div style={{ marginBottom: 16 }}>
            <label style={loginLab}>Hasło</label>
            <input
              style={loginInp}
              type="password"
              value={haslo}
              onChange={(e) => setHaslo(e.target.value)}
              placeholder="min. 6 znaków"
              autoComplete={tryb === "login" ? "current-password" : "new-password"}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </div>
        )}

        {info && (
          <div style={{ fontSize: 13, color: info.includes("błąd") || info.includes("Błędny") || info.includes("Podaj") || info.includes("Hasło musi") ? "#F0A79E" : "#7DDBA0", marginBottom: 14, lineHeight: 1.4 }}>
            {info}
          </div>
        )}

        <button onClick={submit} disabled={busy} style={{ ...btnPrimary, width: "100%", padding: "13px", fontSize: 14, marginTop: 4, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Proszę czekać…" : (tryb === "login" ? "Zaloguj się →" : tytul)}
        </button>

        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.szary2, textAlign: "center", marginTop: 18, letterSpacing: "0.04em", lineHeight: 1.9 }}>
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
const linkStyl = { color: "#FBC441", cursor: "pointer", textDecoration: "none" };

/* ---------- PANEL ADMINISTRATORA ----------------------------------------- */
function PanelAdmina({ pokazToast, email, onForm, onArchiwum, onKoordynacja, onWyloguj }) {
  const [uzytkownicy, setUzytkownicy] = useState([]);
  const [projektyAll, setProjektyAll] = useState([]); // wszystkie aktywne
  const [przypisania, setPrzypisania] = useState([]);
  const [zakresy, setZakresy] = useState([]);
  const [terminyDomyslne, setTerminyDomyslne] = useState({});
  const [nieaktywne, setNieaktywne] = useState([]);
  const [raporty, setRaporty] = useState([]); // wszystkie raporty (lekkie) — do Koordynacji Inwestycji
  const [ladowanie, setLadowanie] = useState(true);
  const [nowaBudowa, setNowaBudowa] = useState("");
  const [wybranyPM, setWybranyPM] = useState("");
  const [zakladka, setZakladka] = useState("zarzadzanie"); // zarzadzanie | koordynacja

  async function wczytaj() {
    setLadowanie(true);
    try {
      const [u, p, prz, zak, term, nieakt, rap] = await Promise.all([
        listaUzytkownikow(),
        listaAktywnychProjektow(),
        listaPrzypisan(),
        listaZakresow(),
        terminyZHarmonogramu(),
        listaNieaktywnychProjektow(),
        listaWszystkichRaportow(),
      ]);
      setUzytkownicy(u);
      setProjektyAll(p);
      setPrzypisania(prz);
      setZakresy(zak);
      setTerminyDomyslne(term);
      setNieaktywne(nieakt);
      setRaporty(rap);
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
        <NaglowekEkranu
          eyebrow="Administracja"
          tytul="Użytkownicy i uprawnienia"
          akcje={
            <button onClick={async () => { await wczytaj(); pokazToast("Odświeżono dane"); }}
              style={{ ...miniBtn, padding: "8px 14px", fontWeight: 600 }}>
              ↻ Odśwież
            </button>
          }
        />
        {/* Zakładki panelu */}
        <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 22, borderBottom: `2px solid ${C.linia}`, gap: 4, flexWrap: "wrap" }}>
          {[["zarzadzanie", "Zarządzanie"], ["koordynacja", "Koordynacja PM"], ["inwestycje", "Koordynacja Inwestycji"]].map(([kod, et]) => (
            <button key={kod} onClick={() => setZakladka(kod)}
              style={{ border: "none", background: "transparent", padding: "10px 16px", fontFamily: C.mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: zakladka === kod ? 700 : 400, cursor: "pointer",
                color: zakladka === kod ? C.czarny : C.szary,
                borderBottom: zakladka === kod ? `3px solid ${C.zolty}` : "3px solid transparent", marginBottom: -2 }}>
              {et}
            </button>
          ))}
        </div>
        {ladowanie ? (
          <div style={{ textAlign: "center", padding: 40, color: C.szary }}>Wczytywanie…</div>
        ) : zakladka === "koordynacja" ? (
          <ZakladkaKoordynacja
            uzytkownicy={uzytkownicy} projektyAll={projektyAll} przypisania={przypisania} zakresy={zakresy}
            terminyDomyslne={terminyDomyslne} nieaktywne={nieaktywne}
            pokazToast={pokazToast} odswiez={wczytaj}
          />
        ) : zakladka === "inwestycje" ? (
          <ZakladkaKoordynacjaInwestycji
            projektyAll={projektyAll} przypisania={przypisania} uzytkownicy={uzytkownicy} zakresy={zakresy}
            terminyDomyslne={terminyDomyslne} raporty={raporty} nieaktywne={nieaktywne}
            pokazToast={pokazToast} odswiez={wczytaj}
          />
        ) : (
          <></>
        )}
        {ladowanie || zakladka !== "zarzadzanie" ? null : (
          <>
            {/* Użytkownicy i role */}
            <section style={card}>
              <div style={secTitle}><span style={{ color: C.zolty, fontWeight: 700 }}>/ </span>Użytkownicy i role</div>
              <div className="tabela-scroll-own" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={thAdm}>Imię i nazwisko</th>
                    <th style={thAdm}>E-mail</th>
                    <th style={{ ...thAdm, textAlign: "center" }}>Rola</th>
                  </tr>
                </thead>
                <tbody>
                  {uzytkownicy.map((u) => (
                    <tr key={u.id} style={{ borderBottom: `1px solid ${C.linia}` }}>
                      <td style={{ padding: "10px 12px" }}>
                        <input type="text" defaultValue={u.imie_nazwisko || ""} placeholder="—"
                          onBlur={(e) => zapiszImie(u.id, e.target.value)}
                          style={{ width: "100%", padding: "6px 8px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13.5, background: "#FCFBF8" }} />
                      </td>
                      <td style={{ padding: "10px 12px", color: C.szary, fontFamily: C.mono, fontSize: 11.5 }}>{u.email}</td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        <span style={{ display: "inline-flex", border: `1px solid ${C.linia}`, borderRadius: 999, overflow: "hidden", fontFamily: C.mono, fontSize: 10, letterSpacing: "0.06em", cursor: "pointer" }}
                          onClick={() => przelaczRole(u)} title="Kliknij, aby przełączyć rolę">
                          <span style={{ padding: "5px 12px", background: u.rola === "admin" ? C.czarny : "transparent", color: u.rola === "admin" ? C.zoltyBright : C.szary, fontWeight: u.rola === "admin" ? 700 : 400 }}>Admin</span>
                          <span style={{ padding: "5px 12px", background: u.rola !== "admin" ? C.czarny : "transparent", color: u.rola !== "admin" ? C.zoltyBright : C.szary, fontWeight: u.rola !== "admin" ? 700 : 400 }}>PM</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>

            {/* Przypisania PM -> inwestycje */}
            <section style={card}>
              <div style={secTitle}><span style={{ color: C.zolty, fontWeight: 700 }}>/ </span>Przypisania PM do inwestycji</div>
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
// Koordynacja PM — UPROSZCZONA lista: tylko przypisywanie punktów obciążenia PM
// do inwestycji. Zarządzanie samą inwestycją (zakres, termin, wstrzymanie,
// zakończenie) przeniesione do zakładki „Koordynacja Inwestycji".
function KompaktowaListaInwestycji({ projekty, przypisania, zakresMap, uzytMap, punktyLok, setPunktyLok, zapiszPunkty }) {
  const [otwarty, setOtwarty] = React.useState(null);
  const numInp = { width: 60, padding: "5px 7px", border: `1px solid ${C.linia}`, borderRadius: 5, fontSize: 13, textAlign: "center" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {projekty.map((p) => {
        const przypP = przypisania.filter((x) => x.projekt_id === p.id);
        const zk = zakresMap[p.zakres];
        const otw = otwarty === p.id;
        return (
          <div key={p.id} style={{ border: `1px solid ${C.linia}`, borderRadius: 8, background: C.bialy, opacity: p.wstrzymana ? 0.6 : 1 }}>
            <div onClick={() => setOtwarty(otw ? null : p.id)}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", cursor: "pointer" }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                <span style={{ color: C.szary, marginRight: 6, fontSize: 11 }}>{otw ? "▼" : "▶"}</span>{p.nazwa}
                {p.wstrzymana && <span style={odznakaWstrzymana}>WSTRZYMANA</span>}
              </div>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.szary2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {przypP.length ? `${przypP.length} PM` : "brak PM"}
              </span>
            </div>
            {otw && (
              <div style={{ borderTop: `1px dashed ${C.linia}`, padding: "10px 14px 12px 32px" }}>
                {przypP.length === 0 ? (
                  <div style={{ fontSize: 12, color: C.szary, fontStyle: "italic" }}>
                    brak przypisanych kierowników — dodaj ich w zakładce „Zarządzanie"
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
              </div>
            )}
          </div>
        );
      })}
    </div>
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
        const wstrzymana = !!p.wstrzymana; // wstrzymana zostaje na liście, ale bez punktów
        const punkty = x.punkty != null ? Number(x.punkty) : (zakresMap[p.zakres]?.punkty || 0);
        if (!schodzi && !wstrzymana) pkt += punkty;
        tematy.push({ nazwa: p.nazwa, zakres: p.zakres, punkty, termin, schodzi, wstrzymana });
      }
      const inne = Number(u.inne_obowiazki || 0);
      const razem = pkt + inne;
      const poj = Number(u.pojemnosc || 20);
      const proc = poj > 0 ? Math.round(razem / poj * 100) : 0;
      tematy.sort((a, b) => (a.schodzi - b.schodzi) || (a.wstrzymana - b.wstrzymana) || (b.punkty - a.punkty));
      return { u, tematy, pkt, inne, razem, poj, proc };
    });
    wynik.sort((a, b) => b.proc - a.proc);
    return wynik;
  }, [kierownicy, przypisania, projektMap, terminyDomyslne, zakresMap, horyzont]);

  const [rozwiniety, setRozwiniety] = React.useState(null); // id kierownika z rozwiniętymi tematami
  function kolorProc(p) { return p > 100 ? C.czerwony : p >= 80 ? "#B9791A" : "#1B7A3D"; }
  function stanProc(p) { return p > 100 ? ["przeciążony", C.czerwony, "#FBECEA"] : p >= 80 ? ["pełne obłożenie", "#B9791A", "#FBF0DC"] : ["ma zapas", "#1B7A3D", "#E6F3EA"]; }

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
  async function zapiszPM(uzytkownikId, pola) {
    try { await ustawDanePM(uzytkownikId, pola); }
    catch (e) { console.error(e); pokazToast("Błąd zapisu danych kierownika"); }
  }

  const td = { padding: "8px 10px", borderBottom: `1px solid ${C.jasny}`, fontSize: 13.5 };
  const numInp = { width: 70, padding: "6px 8px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, textAlign: "center" };

  return (
    <>
      {/* SEKCJA ANALIZY — OBCIĄŻENIE ZESPOŁU (na górze) */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <TytulSekcji>Obciążenie zespołu</TytulSekcji>
          <PigulkaPrzelacznik opcje={[[0, "Dziś"], [30, "Za miesiąc"], [60, "Za 2 msc"], [90, "Za 3 msc"]]} wartosc={horyzont} onZmiana={setHoryzont} />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: C.mono, fontSize: 10, color: C.szary2, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
          <span style={{ color: "#1B7A3D" }}>● <span style={{ color: C.szary2 }}>do 80% — zapas</span></span>
          <span style={{ color: "#B9791A" }}>● <span style={{ color: C.szary2 }}>80–100% — pełne</span></span>
          <span style={{ color: C.czerwony }}>● <span style={{ color: C.szary2 }}>ponad 100% — przeciążenie</span></span>
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
                      <div style={{ fontSize: 11.5, color: C.szary, marginTop: 1 }}>{a.tematy.filter((t) => !t.schodzi && !t.wstrzymana).length} akt. · {a.razem} pkt{a.inne > 0 ? ` (w tym ${a.inne} inne)` : ""}</div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: C.mono, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, marginTop: 4, color: stCol, background: stBg }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />{st}</span>
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
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", opacity: (t.schodzi || t.wstrzymana) ? .45 : 1 }}>
                          <span style={{ textDecoration: t.schodzi ? "line-through" : "none" }}>
                            {t.nazwa} <span style={{ fontSize: 10.5, color: C.szary, background: C.jasny, padding: "1px 6px", borderRadius: 4 }}>{zakresMap[t.zakres]?.nazwa || "—"}</span>
                            {t.wstrzymana && <span style={odznakaWstrzymana}>WSTRZYMANA</span>}
                          </span>
                          <span style={{ color: C.szary }}>{t.termin ? `do ${fmtPL(t.termin)}` : "bez terminu"} · <b style={{ color: C.czarny }}>{t.punkty} pkt</b>{t.schodzi ? " — zejdzie" : t.wstrzymana ? " — nie liczone" : ""}</span>
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

      {/* SEKCJA 1 — PUNKTY PM: przypisywanie punktów obciążenia PM do inwestycji */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <TytulSekcji>Punkty PM per inwestycja</TytulSekcji>
          <input type="text" value={szukaj} onChange={(e) => setSzukaj(e.target.value)} placeholder="Szukaj inwestycji…"
            style={{ padding: "7px 11px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, width: 220 }} />
        </div>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: -2, marginBottom: 14, lineHeight: 1.5 }}>
          Kliknij inwestycję, aby rozwinąć i przypisać punkty obciążenia kierownikom. Zakres, termin, wstrzymanie i zakończenie ustawiasz w zakładce „Koordynacja Inwestycji".
        </p>
        <KompaktowaListaInwestycji
          projekty={projektyWidoczne} przypisania={przypisania} zakresMap={zakresMap}
          uzytMap={uzytMap} punktyLok={punktyLok} setPunktyLok={setPunktyLok} zapiszPunkty={zapiszPunkty}
        />
      </section>

      {/* SEKCJA 2 — KIEROWNICY: pojemność, inne obowiązki */}
      <section style={card}>
        <TytulSekcji>Kierownicy — pojemność i inne obowiązki</TytulSekcji>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: 6, marginBottom: 16, lineHeight: 1.5 }}>
          Pojemność to punkty odpowiadające pełnemu obłożeniu (100%). „Inne obowiązki" to punkty za zadania spoza inwestycji
          (gwarancje, usterki itp.). Widoczni są tylko kierownicy z przypisanymi inwestycjami.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thAdm}>Kierownik</th>
              <th style={{ ...thAdm, textAlign: "center" }}>Pojemność</th>
              <th style={{ ...thAdm, textAlign: "center" }}>Inne obowiązki</th>
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

    </>
  );
}

/* ---------- ZAKŁADKA KOORDYNACJA INWESTYCJI (panel admina) --------------- */
/* Kokpit przekrojowy: wszystkie aktywne inwestycje w jednym miejscu — status
   z najnowszego raportu, opóźnienie, data ostatniego raportu, najbliższy termin
   i PnU, przypisani PM. Plus monitor kompletności: kto nie złożył raportu. */
function ZakladkaKoordynacjaInwestycji({ projektyAll, przypisania, uzytkownicy, zakresy, terminyDomyslne, raporty, nieaktywne, pokazToast, odswiez }) {
  const uzytMap = React.useMemo(() => Object.fromEntries(uzytkownicy.map((u) => [u.id, u])), [uzytkownicy]);
  const zakresMap = React.useMemo(() => Object.fromEntries(zakresy.map((z) => [z.kod, z])), [zakresy]);
  const [filtrStatus, setFiltrStatus] = React.useState("wszystkie"); // wszystkie | zagrozone | bez-raportu
  const [prog, setProg] = React.useState(30);                        // próg dni „bez aktualnego raportu"
  const [szukaj, setSzukaj] = React.useState("");
  const [otwarty, setOtwarty] = React.useState(null);                // id inwestycji z rozwiniętym panelem zarządzania
  const dzis = dzisISO();

  // --- Zarządzanie inwestycją (zakres, termin, wstrzymanie, zakończenie, przywrócenie) ---
  async function zapiszZakres(projektId, kod) {
    try { await ustawKoordynacjeProjektu(projektId, { zakres: kod || null }); odswiez?.(); }
    catch (e) { console.error(e); pokazToast?.("Błąd zapisu zakresu"); }
  }
  async function zapiszTermin(projektId, data) {
    try { await ustawKoordynacjeProjektu(projektId, { termin_zakonczenia: data || null }); odswiez?.(); }
    catch (e) { console.error(e); pokazToast?.("Błąd zapisu terminu"); }
  }
  async function zakonczInwestycje(projektId, nazwa) {
    if (!window.confirm(`Oznaczyć „${nazwa}" jako zakończoną?\n\nZniknie z listy aktywnych inwestycji i z przypisań. Możesz ją przywrócić w sekcji „Zakończone".`)) return;
    try { await ustawAktywnoscProjektu(projektId, false); odswiez?.(); pokazToast?.(`„${nazwa}" przeniesiona do zakończonych`); }
    catch (e) { console.error(e); pokazToast?.("Błąd archiwizacji inwestycji"); }
  }
  async function przelaczWstrzymanie(p) {
    const wstrzymac = !p.wstrzymana;
    try {
      await ustawKoordynacjeProjektu(p.id, { wstrzymana: wstrzymac });
      odswiez?.();
      pokazToast?.(wstrzymac ? `„${p.nazwa}" wstrzymana — punkty nie liczą się do obciążenia` : `„${p.nazwa}" aktywna — punkty znów się naliczają`);
    } catch (e) { console.error(e); pokazToast?.("Błąd zmiany statusu inwestycji"); }
  }
  async function przywrocInwestycje(projektId, nazwa) {
    try { await ustawAktywnoscProjektu(projektId, true); odswiez?.(); pokazToast?.(`„${nazwa}" przywrócona`); }
    catch (e) { console.error(e); pokazToast?.("Błąd przywracania inwestycji"); }
  }

  // Najnowszy raport per projekt (klucz: projekt_id)
  const raportyProjektu = React.useMemo(() => {
    const mapa = {};
    for (const r of (raporty || [])) {
      (mapa[r.projekt_id] = mapa[r.projekt_id] || []).push(r);
    }
    return mapa;
  }, [raporty]);

  // Wiersz kokpitu dla każdej aktywnej inwestycji
  const dane = React.useMemo(() => {
    return projektyAll.map((p) => {
      const ost = najnowszyRaport(raportyProjektu[p.id]);
      const status = statusZRaportu(ost);
      const dniOd = ost ? dniMiedzy(dzis, ost.data_opracowania) : null;
      const opoz = ost ? opoznienieInwestycji(ost.harmonogram, ost.data_opracowania) : null;
      const opozDni = opoz && opoz.dni > 0 ? opoz.dni : 0;
      const postep = ost ? sredniPostep(ost.harmonogram) : null;
      const terminReczny = p.termin_zakonczenia || "";
      const terminAuto = terminyDomyslne?.[p.id] || "";
      const termin = terminReczny || terminAuto || "";
      const dniDoTerminu = termin ? dniMiedzy(termin, dzis) : null;
      const pnu = ost ? (ost.pnu_nie_dotyczy ? "—" : (ost.pnu || "")) : "";
      const pmy = przypisania.filter((x) => x.projekt_id === p.id).map((x) => nazwaOsoby(uzytMap[x.uzytkownik])).filter(Boolean);
      // sygnał kompletności: brak raportu w ogóle albo starszy niż próg
      const zalega = dniOd === null || dniOd > prog;
      return {
        projekt: p, status, ost, dniOd, opozDni, postep, termin, terminAuto: !terminReczny && !!terminAuto,
        dniDoTerminu, pnu, pnuNieDotyczy: !!ost?.pnu_nie_dotyczy, pmy, wstrzymana: !!p.wstrzymana, zalega,
      };
    });
  }, [projektyAll, raportyProjektu, terminyDomyslne, przypisania, uzytMap, prog, dzis]);

  const liczby = React.useMemo(() => ({
    razem: dane.length,
    zagrozone: dane.filter((d) => d.status.kod === "zagrozenie" && !d.wstrzymana).length,
    zalegle: dane.filter((d) => d.zalega && !d.wstrzymana).length,
    wstrzymane: dane.filter((d) => d.wstrzymana).length,
  }), [dane]);

  // Monitor kompletności: aktywne, niewstrzymane, zalegające; najgorsze na górze (nigdy → góra)
  const zalegle = React.useMemo(() => dane
    .filter((d) => d.zalega && !d.wstrzymana)
    .sort((a, b) => (a.dniOd === null ? Infinity : a.dniOd) < (b.dniOd === null ? Infinity : b.dniOd) ? 1 : -1),
    [dane]);

  // Kokpit: filtr + szukajka + sortowanie ryzykiem
  const widoczne = React.useMemo(() => {
    const q = szukaj.trim().toLowerCase();
    let lista = dane;
    if (filtrStatus === "zagrozone") lista = lista.filter((d) => d.status.kod === "zagrozenie");
    else if (filtrStatus === "bez-raportu") lista = lista.filter((d) => d.zalega);
    if (q) lista = lista.filter((d) => d.projekt.nazwa.toLowerCase().includes(q));
    const rank = (d) => (d.wstrzymana ? -1 : d.status.kod === "zagrozenie" ? 3 : d.zalega ? 2 : 1);
    return [...lista].sort((a, b) => (rank(b) - rank(a)) || (b.opozDni - a.opozDni) || ((b.dniOd || 0) - (a.dniOd || 0)) || a.projekt.nazwa.localeCompare(b.projekt.nazwa, "pl"));
  }, [dane, filtrStatus, szukaj]);

  const th = { textAlign: "left", padding: "9px 10px", color: C.szary, fontFamily: C.mono, fontSize: 9.5, fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: `2px solid ${C.czarny}` };
  const td = { padding: "8px 10px", borderBottom: `1px solid ${C.jasny}`, fontSize: 13, verticalAlign: "top" };
  // Chip statusu w stylu abyard.com: mono, uppercase, z kropką w kolorze tekstu.
  const chip = (txt, kolor, tlo) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: C.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 999, color: kolor, background: tlo, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", flexShrink: 0 }} />{txt}
    </span>
  );
  // Etykieta „ostatni raport": ile dni temu + numer, z kolorem wg zalegania
  function ostatniRaportKom(d) {
    if (d.dniOd === null) return <span style={{ color: "#C0392B", fontWeight: 700 }}>brak raportu</span>;
    const kol = d.zalega ? "#B9791A" : C.szary;
    return (
      <span style={{ color: kol }}>
        {d.dniOd === 0 ? "dziś" : `${d.dniOd} dni temu`}
        <span style={{ color: C.szary }}> · nr {d.ost.numer}</span>
      </span>
    );
  }

  return (
    <>
      {/* PASEK PODSUMOWUJĄCY */}
      <section style={{ ...card, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "stretch" }}>
        {[
          ["Inwestycje aktywne", liczby.razem, C.czarny, C.jasny],
          ["Zagrożony termin", liczby.zagrozone, "#C0392B", "#FBECEA"],
          [`Bez raportu > ${prog} dni`, liczby.zalegle, "#B9791A", "#FBF0DC"],
          ["Wstrzymane", liczby.wstrzymane, C.szary, C.jasny],
        ].map(([et, n, kol, tlo]) => (
          <div key={et} style={{ flex: "1 1 160px", border: `1px solid ${C.linia}`, borderRadius: 8, padding: "12px 16px", background: tlo }}>
            <div style={{ fontFamily: "'Roboto', system-ui, sans-serif", fontSize: 28, fontWeight: 900, color: kol, lineHeight: 1 }}>{n}</div>
            <div style={{ fontFamily: C.mono, fontSize: 10, color: C.szary, marginTop: 5, textTransform: "uppercase", letterSpacing: "0.1em" }}>{et}</div>
          </div>
        ))}
      </section>

      {/* MONITOR KOMPLETNOŚCI — KTO NIE ZŁOŻYŁ RAPORTU */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <TytulSekcji>Do uzupełnienia — brak aktualnego raportu</TytulSekcji>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.szary2, textTransform: "uppercase", letterSpacing: "0.08em" }}>Próg</span>
            <PigulkaPrzelacznik opcje={[[30, "30 dni"], [45, "45 dni"], [60, "60 dni"]]} wartosc={prog} onZmiana={setProg} />
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: C.szary, marginTop: -2, marginBottom: 14, lineHeight: 1.5 }}>
          Aktywne inwestycje bez żadnego raportu lub z raportem starszym niż {prog} dni. Wstrzymane pomijane.
        </p>
        {zalegle.length === 0 ? (
          <div style={{ fontSize: 13, color: "#1B7A3D", fontWeight: 600 }}>✓ Wszystkie aktywne inwestycje mają aktualny raport.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {zalegle.map((d) => (
              <div key={d.projekt.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 12px", border: `1px solid ${d.dniOd === null ? "#F0C0C0" : C.linia}`, borderRadius: 6, background: d.dniOd === null ? "#FCF3F3" : C.bialy }}>
                <div style={{ minWidth: 200, flex: "1 1 240px" }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{d.projekt.nazwa}</div>
                  <div style={{ fontSize: 11.5, color: C.szary, marginTop: 1 }}>{d.pmy.length ? d.pmy.join(", ") : "brak przypisanego PM"}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {d.dniOd === null
                    ? chip("BRAK RAPORTU", "#C0392B", "#FBECEA")
                    : chip(`${d.dniOd} dni od raportu (nr ${d.ost.numer})`, "#B9791A", "#FBF0DC")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* KOKPIT — WSZYSTKIE INWESTYCJE */}
      <section style={card}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <TytulSekcji>Kokpit inwestycji</TytulSekcji>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <PigulkaPrzelacznik opcje={[["wszystkie", "Wszystkie"], ["zagrozone", "Zagrożone"], ["bez-raportu", "Bez raportu"]]} wartosc={filtrStatus} onZmiana={setFiltrStatus} />
            <input type="text" value={szukaj} onChange={(e) => setSzukaj(e.target.value)} placeholder="Szukaj inwestycji…"
              style={{ padding: "7px 11px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, width: 200 }} />
          </div>
        </div>
        {widoczne.length === 0 ? (
          <div style={{ fontSize: 13, color: C.szary, fontStyle: "italic" }}>Brak inwestycji spełniających kryteria.</div>
        ) : (
          <div className="tabela-scroll-own">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Inwestycja</th>
                  <th style={{ ...th, width: 140 }}>PM</th>
                  <th style={{ ...th, width: 130 }}>Status</th>
                  <th style={{ ...th, width: 90, textAlign: "center" }}>Opóźnienie</th>
                  <th style={{ ...th, width: 70, textAlign: "center" }}>Postęp</th>
                  <th style={{ ...th, width: 150 }}>Ostatni raport</th>
                  <th style={{ ...th, width: 130 }}>Termin / PnU</th>
                </tr>
              </thead>
              <tbody>
                {widoczne.map((d) => {
                  const p = d.projekt;
                  const otw = otwarty === p.id;
                  const auto = terminyDomyslne?.[p.id] || "";
                  const reczny = p.termin_zakonczenia || "";
                  const wartoscT = reczny || auto;
                  const zAuto = !reczny && !!auto;
                  return (
                  <React.Fragment key={p.id}>
                  <tr style={{ opacity: d.wstrzymana ? 0.6 : 1, background: otw ? C.jasny : "transparent" }}>
                    <td style={{ ...td, fontWeight: 700, cursor: "pointer" }} onClick={() => setOtwarty(otw ? null : p.id)} title="Kliknij, aby zarządzać inwestycją">
                      <span style={{ color: C.szary, marginRight: 6, fontSize: 11 }}>{otw ? "▼" : "▶"}</span>
                      {p.nazwa}
                      {d.wstrzymana && <span style={odznakaWstrzymana}>WSTRZYMANA</span>}
                    </td>
                    <td style={{ ...td, color: d.pmy.length ? C.czarny : C.szary, fontSize: 12.5 }}>{d.pmy.length ? d.pmy.join(", ") : "—"}</td>
                    <td style={td}>{chip(d.status.txt, d.status.kolor, d.status.tlo)}</td>
                    <td style={{ ...td, textAlign: "center", color: d.opozDni > 0 ? "#C0392B" : C.szary, fontWeight: d.opozDni > 0 ? 800 : 400 }}>{d.opozDni > 0 ? `${d.opozDni} dni` : "—"}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{d.postep != null ? `${d.postep}%` : "—"}</td>
                    <td style={td}>{ostatniRaportKom(d)}</td>
                    <td style={{ ...td, fontSize: 12.5 }}>
                      {d.termin ? (
                        <span style={{ color: d.dniDoTerminu != null && d.dniDoTerminu < 0 ? "#C0392B" : (d.dniDoTerminu != null && d.dniDoTerminu <= 60 ? "#B9791A" : C.czarny), fontWeight: 600 }}>
                          {fmtPL(d.termin)}{d.terminAuto ? " ·auto" : ""}
                        </span>
                      ) : <span style={{ color: C.szary }}>—</span>}
                      <div style={{ fontSize: 11, color: C.szary, marginTop: 2 }}>
                        PnU: {d.pnuNieDotyczy ? "nie dotyczy" : (d.pnu ? fmtPL(d.pnu) : "—")}
                      </div>
                    </td>
                  </tr>
                  {otw && (
                    <tr>
                      <td colSpan={7} style={{ padding: "12px 14px 16px 30px", background: C.jasny, borderBottom: `1px solid ${C.linia}` }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <label style={lbl}>Zakres</label>
                            <select value={p.zakres || ""} onChange={(e) => zapiszZakres(p.id, e.target.value)}
                              style={{ padding: "7px 9px", border: `1px solid ${C.linia}`, borderRadius: 6, fontSize: 13, minWidth: 180, background: C.bialy }}>
                              <option value="">— brak —</option>
                              {zakresy.map((z) => <option key={z.kod} value={z.kod}>{z.nazwa}</option>)}
                            </select>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <label style={lbl}>Termin zakończenia</label>
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <input type="date" defaultValue={wartoscT} onBlur={(e) => zapiszTermin(p.id, e.target.value)}
                                title={zAuto ? "Termin dociągnięty z harmonogramu — zapisz, by ustawić na stałe, lub zmień ręcznie" : ""}
                                style={{ padding: "6px 8px", border: `1px solid ${zAuto ? C.zolty : C.linia}`, borderRadius: 6, fontSize: 13, background: zAuto ? "#FFFDF5" : C.bialy }} />
                              {zAuto && <span style={{ fontSize: 9.5, color: "#B8860B", fontWeight: 700 }}>AUTO</span>}
                            </span>
                          </div>
                          <button onClick={() => przelaczWstrzymanie(p)}
                            title={p.wstrzymana ? "Wznów — punkty znów liczą się do obciążenia" : "Wstrzymaj — punkty przestają liczyć się do obciążenia"}
                            style={{ border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "8px 14px", borderRadius: 6,
                              color: p.wstrzymana ? "#1B7A3D" : "#B9791A", background: p.wstrzymana ? "#E6F3EA" : "#FBF0DC" }}>
                            {p.wstrzymana ? "▶ Wznów inwestycję" : "⏸ Wstrzymaj inwestycję"}
                          </button>
                          <button onClick={() => zakonczInwestycje(p.id, p.nazwa)} title="Oznacz jako zakończoną (przenosi do sekcji Zakończone)"
                            style={{ border: `1px solid ${C.linia}`, background: C.bialy, borderRadius: 6, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: C.szary }}>
                            ✓ Zakończ inwestycję
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ZAKOŃCZONE INWESTYCJE — przywracanie */}
      {nieaktywne && nieaktywne.length > 0 && (
        <section style={card}>
          <TytulSekcji>Zakończone inwestycje</TytulSekcji>
          <p style={{ fontSize: 12.5, color: C.szary, marginTop: 6, marginBottom: 14, lineHeight: 1.5 }}>
            Inwestycje oznaczone jako zakończone. Nie liczą się do obciążenia i nie pojawiają się w przypisaniach. Możesz je przywrócić.
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
          (wg[x.uzytkownik] ||= []).push({ nazwa: p.nazwa, termin, wstrzymana: !!p.wstrzymana });
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
            wstrzymana: !!p.wstrzymana,
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

  const th = { textAlign: "left", padding: "9px 12px", color: C.szary, fontFamily: C.mono, fontSize: 9.5, fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: `2px solid ${C.linia}` };
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
        <NaglowekEkranu
          eyebrow="Koordynacja"
          tytul="Kto co prowadzi"
          sub={tryb === "pm"
            ? "Zestawienie kierowników i przypisanych im inwestycji. Data zakończenia pochodzi z harmonogramu (najpóźniejsza z terminów) lub z ręcznego wpisu w panelu koordynacji."
            : "Zestawienie inwestycji i przypisanych do nich kierowników. Data zakończenia pochodzi z harmonogramu (najpóźniejsza z terminów) lub z ręcznego wpisu w panelu koordynacji."}
          akcje={
            <div style={{ display: "inline-flex", border: `1px solid ${C.linia}`, borderRadius: 999, overflow: "hidden", fontFamily: C.mono, fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {[["pm", "Wg kierownika"], ["inwestycje", "Wg inwestycji"]].map(([kod, et]) => (
                <button key={kod} onClick={() => setTryb(kod)}
                  style={{ border: "none", background: tryb === kod ? C.czarny : C.bialy, color: tryb === kod ? C.zoltyBright : C.szary,
                    fontWeight: tryb === kod ? 700 : 400, padding: "7px 14px", cursor: "pointer", fontFamily: "inherit", letterSpacing: "inherit", textTransform: "inherit" }}>
                  {et}
                </button>
              ))}
            </div>
          }
        />

        {ladowanie ? (
          <div style={{ textAlign: "center", padding: 40, color: C.szary }}>Wczytywanie…</div>
        ) : blad ? (
          <div style={{ color: "#C0392B", fontSize: 14 }}>{blad}</div>
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
                        <tr key={j} style={{ opacity: t.wstrzymana ? 0.6 : 1 }}>
                          <td style={td}>
                            {t.nazwa}
                            {t.wstrzymana && <span style={odznakaWstrzymana} title="Inwestycja wstrzymana — nie liczy się do obciążenia">WSTRZYMANA</span>}
                          </td>
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
                    <span style={{ fontWeight: 700, fontSize: 14 }}>
                      {inw.nazwa}
                      {inw.wstrzymana && <span style={odznakaWstrzymana} title="Inwestycja wstrzymana — nie liczy się do obciążenia">WSTRZYMANA</span>}
                    </span>
                    <span style={{ fontSize: 12.5, color: inw.termin ? C.zolty : "#C89B3C", fontWeight: 600 }}>
                      {inw.termin ? `zakończenie: ${fmtPL(inw.termin)}` : "brak terminu"}
                    </span>
                  </div>
                  {inw.pmowie.length === 0 ? (
                    <div style={{ padding: "12px 16px", fontSize: 13, color: "#C0392B", fontStyle: "italic" }}>
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
function WidokArchiwum({ raporty, ladowanie, filtr, setFiltr, onOdswiez, onOtworz, onEdytuj, onUsun, mozeEdytowac, godzinyDoEdycji, onPozwolEdycje, onCofnijEdycje, onNowyRaport, jestAdmin, email, onForm, onKoordynacja, onAdmin, onWyloguj }) {
  // Status na plakietce czyta z pola „Podsumowanie" raportu. Dodatkowo, gdy opóźnienie
  // w harmonogramie realnie opóźnia zakończenie całości projektu, wymuszamy „zagrożenie"
  // (zabezpiecza też starsze raporty zapisane z domyślną opcją „nie powoduje zagrożenia").
  const ZAGROZENIE = { txt: "Zagrożenie terminu", kolor: "#C0392B", tlo: "#FBECEA", wariant: "warn" };
  const NIEZAGROZONY = { txt: "Termin niezagrożony", kolor: "#1B7A3D", tlo: "#E6F3EA", wariant: "ok" };
  function statusInwestycji(raport) {
    if (!raport) return { txt: "—", kolor: C.szary, tlo: "transparent", wariant: "neutral" };
    if (harmonogramWymuszaZagrozenie(raport.harmonogram, raport.data_opracowania)) return ZAGROZENIE;
    const t = (raport.podsumowanie || "").toLowerCase();
    const brakZagrozenia = t.includes("nie powoduje") || t.includes("niezagroż") || t.includes("nie ma zagroż") || t.includes("bez zagroż");
    if (brakZagrozenia) return NIEZAGROZONY;
    if (t.includes("zagroż") || t.includes("zagroz")) return ZAGROZENIE;
    return NIEZAGROZONY;
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
      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 24px 80px" }}>
        <NaglowekEkranu
          eyebrow="Archiwum"
          tytul="Raporty z budów"
          sub="Kliknij kartę budowy, aby zawęzić listę. Otwórz raport, by pobrać PDF lub udostępnić link."
          akcje={<>
            <button onClick={onOdswiez} style={{ ...miniBtn, padding: "8px 14px", fontWeight: 600 }}>↻ Odśwież</button>
            <button onClick={onNowyRaport} style={{ background: C.zolty, color: C.czarny, border: "none", padding: "9px 16px", borderRadius: 6, fontWeight: 700, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }}>+ Nowy raport</button>
          </>}
        />
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
                const st = statusInwestycji(b.ostatni);
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
                    <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>{b.nazwa}</div>
                    <div style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: "0.03em", color: C.szary2, textTransform: "uppercase", marginBottom: 12 }}>
                      {b.liczba} {b.liczba === 1 ? "raport" : "raportów"} · nr {b.ostatni?.numer} · {b.ostatni?.data_opracowania ? fmtPL(b.ostatni.data_opracowania) : "—"}
                    </div>
                    {(() => {
                      const o = b.ostatni || {};
                      const postep = sredniPostep(o.harmonogram);
                      const opoz = opoznienieInwestycji(o.harmonogram, o.data_opracowania);
                      const komorka = (etykieta, wartosc, kolor) => (
                        <div style={{ flex: "1 1 calc(50% - 4px)", background: C.jasny, borderRadius: 6, padding: "6px 8px" }}>
                          <div style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.08em", color: C.szary2 }}>{etykieta}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: kolor || C.czarny }}>{wartosc}</div>
                        </div>
                      );
                      return (<>
                        {postep !== null && <div style={{ marginBottom: 10 }}><PasekPostepu proc={postep} etykieta="zaawansowanie" szer="100%" /></div>}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                          {komorka(
                            "Opóźnienie",
                            opoz === null ? "—" : opoz.dni > 0 ? `${opoz.dni} dni` : "brak",
                            opoz && opoz.dni > 0 ? "#C0392B" : C.czarny
                          )}
                          {komorka("Zakończenie wg umowy", (() => {
                            const zHarm = najpozniejszePlanowaneZakonczenie(o.harmonogram);
                            if (zHarm) return fmtPL(zHarm);
                            return o.zakonczenie_robot ? fmtPL(o.zakonczenie_robot) : "—";
                          })())}
                          {komorka("Pozwolenie (PNU)", o.pnu_nie_dotyczy ? "Nie dotyczy" : (o.pnu ? fmtPL(o.pnu) : "—"))}
                        </div>
                      </>);
                    })()}
                    <Chip wariant={st.wariant}>{st.txt}</Chip>
                  </div>
                );
              })}
            </div>

            {/* Filtr aktywny — informacja */}
            {filtr && (
              <div style={{ marginBottom: 14, fontSize: 13, color: C.szary }}>
                Filtr: <strong style={{ color: C.czarny }}>{filtr}</strong> ·{" "}
                <span onClick={() => setFiltr("")} style={{ color: C.zoltyDeep, fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}>pokaż wszystkie</span>
              </div>
            )}

            {/* 2) Lista raportów — wiersze w stylu abyard.com (numbadge + meta mono + postęp + chip) */}
            <div style={{ background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 10, padding: "4px 20px" }}>
              {widoczne.map((r, idx) => {
                const st = statusInwestycji(r);
                const postep = sredniPostep(r.harmonogram);
                const meta = [
                  r.okres_od ? `${fmtPL(r.okres_od)} – ${fmtPL(r.okres_do)}` : null,
                  r.data_opracowania ? fmtPL(r.data_opracowania) : null,
                  r.opracowal || null,
                ].filter(Boolean).join(" · ");
                return (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 4px", borderBottom: idx === widoczne.length - 1 ? "none" : `1px solid ${C.linia}`, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: "'Roboto', system-ui, sans-serif", fontWeight: 900, fontSize: 22, color: C.czarny, width: 66, flexShrink: 0 }}>
                      <span style={{ color: C.zolty }}>/</span>{String(r.numer).padStart(3, "0")}
                    </div>
                    <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: C.czarny }}>{r.nazwaProjektu}</div>
                      <div style={{ fontFamily: C.mono, fontSize: 10.5, color: C.szary2, marginTop: 3, letterSpacing: "0.02em", textTransform: "uppercase" }}>{meta || "—"}</div>
                    </div>
                    {postep !== null && <PasekPostepu proc={postep} etykieta="zaawansowanie" szer={120} />}
                    <Chip wariant={st.wariant} title={st.txt}>{st.wariant === "warn" ? "Zagrożenie" : st.wariant === "ok" ? "Niezagrożony" : st.txt}</Chip>
                    <div className="arow-act" style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", alignItems: "center", flexShrink: 0 }}>
                      {mozeEdytowac && mozeEdytowac(r) && (() => {
                        const h = godzinyDoEdycji && godzinyDoEdycji(r);
                        return (
                          <>
                            <button onClick={() => onEdytuj(r.id)} style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600 }}>Edytuj</button>
                            {h != null && (
                              <span style={{ fontFamily: C.mono, fontSize: 10, color: C.szary, whiteSpace: "nowrap" }} title="Czas, przez jaki możesz jeszcze edytować ten raport">~{h}h</span>
                            )}
                          </>
                        );
                      })()}
                      <button onClick={() => onOtworz(r.id)} title="Podgląd raportu — stamtąd zapiszesz PDF lub wygenerujesz link do raportu" style={{ ...miniBtn, background: C.zolty, border: "none", fontWeight: 700 }}>Otwórz</button>
                      {jestAdmin && onPozwolEdycje && (() => {
                        const aktywne = r.edycja_do && new Date(r.edycja_do).getTime() > Date.now();
                        if (aktywne) {
                          const h = Math.max(1, Math.ceil((new Date(r.edycja_do).getTime() - Date.now()) / (3600 * 1000)));
                          return (
                            <>
                              <span style={{ fontFamily: C.mono, fontSize: 10, color: "#1B7A3D", whiteSpace: "nowrap" }} title="Edycja odblokowana — autor i przypisani PM mogą edytować">otwarta ~{h}h</span>
                              <button onClick={() => onPozwolEdycje(r)} title="Przedłuż okno edycji o kolejne 24h" style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600 }}>Przedłuż</button>
                              <button onClick={() => onCofnijEdycje(r)} title="Zamknij okno edycji od razu" style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600 }}>Cofnij</button>
                            </>
                          );
                        }
                        return (
                          <button onClick={() => onPozwolEdycje(r)} title="Odblokuj edycję tego raportu na 24h — dla autora i PM przypisanych do budowy" style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.linia}`, fontWeight: 600 }}>Pozwól na edycję</button>
                        );
                      })()}
                      {jestAdmin && onUsun && (
                        <button onClick={() => onUsun(r)} title="Usuń raport wraz ze zdjęciami (nieodwracalne)"
                          style={{ ...miniBtn, background: C.bialy, border: `1px solid ${C.czerwony}`, color: C.czerwony, fontWeight: 600 }}>
                          Usuń
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
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
    ? { txt: "unieważniony", kolor: "#C0392B" }
    : { txt: "aktywny", kolor: "#1B7A3D" };

  return (
    <div className="noprint" style={{ maxWidth: 794, margin: "16px auto 0", background: C.bialy, borderRadius: 8, padding: "16px 20px", boxShadow: "0 4px 30px rgba(0,0,0,0.3)", fontSize: 13, color: C.czarny }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, fontSize: 12 }}>Linki do raportu</div>
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
/* ============================================================================
   EKSPORT PDF (pdfmake) — wektorowy plik budowany z danych raportu.
   Jeden klik „Pobierz PDF", ten sam plik za każdym razem, tekst zaznaczalny.
   Jedyna droga do PDF — układ i typografia odwzorowują podgląd (PodgladPDF).
   ========================================================================== */

// URL/dataURL -> dataURL (base64). Zwraca null przy błędzie (pomijamy obraz).
async function urlNaDataUrl(url) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error("read"));
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}
function wczytajObrazek(dataUrl) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}
// Zwraca { dataUrl (PNG/JPEG — pdfmake nie przyjmuje innych), w, h } albo null.
async function przygotujObraz(url) {
  const dataUrl = await urlNaDataUrl(url);
  if (!dataUrl) return null;
  const img = await wczytajObrazek(dataUrl);
  if (!img) return null;
  const mime = (dataUrl.slice(5, dataUrl.indexOf(";")) || "").toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg") {
    return { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
  }
  // inny format (np. webp) — przekoduj na JPEG przez canvas (data: URI nie „truje" canvasu)
  try {
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    return { dataUrl: cv.toDataURL("image/jpeg", 0.85), w: img.naturalWidth, h: img.naturalHeight };
  } catch { return null; }
}

// HTML z edytora (b/i/u/span/listy/br/div/p) -> tablica „runs" dla pdfmake.
// Pogrubienia, kursywę i podkreślenia wykrywamy zarówno ze znaczników
// (b/strong, i/em, u/s), jak i ze STYLI INLINE (font-weight/style/text-decoration) —
// przeglądarki (i execCommand ze styleWithCSS, oraz wklejenia) często zapisują
// formatowanie właśnie jako style, a wcześniej takie pogrubienia „ginęły" w PDF.
function htmlNaPdfmake(html) {
  const runs = [];
  const dopisz = (t, st) => { if (t) runs.push({ text: t, ...st }); };
  // Zwraca stan formatowania rozszerzony o cechy danego elementu (znaczniki + style).
  const cechy = (el, st) => {
    const s = { ...st };
    const tag = el.tagName.toLowerCase();
    if (tag === "b" || tag === "strong") s.bold = true;
    if (tag === "i" || tag === "em") s.italics = true;
    if (tag === "u" || tag === "ins") s.decoration = "underline";
    if (tag === "s" || tag === "strike" || tag === "del") s.decoration = "lineThrough";
    const stl = el.style || {};
    const fw = String(stl.fontWeight || "").toLowerCase();
    if (fw === "bold" || fw === "bolder" || parseInt(fw, 10) >= 600) s.bold = true;
    if (String(stl.fontStyle || "").toLowerCase() === "italic") s.italics = true;
    const dec = (String(stl.textDecoration || "") + " " + String(stl.textDecorationLine || "")).toLowerCase();
    if (dec.includes("underline")) s.decoration = "underline";
    else if (dec.includes("line-through")) s.decoration = "lineThrough";
    return s;
  };
  if (html && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const walk = (node, st) => {
      node.childNodes.forEach((ch) => {
        if (ch.nodeType === 3) {
          dopisz(ch.textContent, st);
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName.toLowerCase();
          if (tag === "br") { runs.push({ text: "\n" }); return; }
          const s = cechy(ch, st);
          // Listy — każde <li> w osobnym wierszu, z wypunktowaniem/numeracją.
          if (tag === "ul" || tag === "ol") {
            let i = 0;
            ch.childNodes.forEach((li) => {
              if (li.nodeType === 1 && li.tagName.toLowerCase() === "li") {
                i += 1;
                dopisz(tag === "ol" ? `${i}.  ` : "•  ", s);
                walk(li, s);
                runs.push({ text: "\n" });
              }
            });
            return;
          }
          walk(ch, s);
          if (tag === "div" || tag === "p" || tag === "li") runs.push({ text: "\n" });
        }
      });
    };
    if (doc.body.firstChild) walk(doc.body.firstChild, {});
  } else if (html) {
    runs.push({ text: String(html).replace(/<[^>]+>/g, "") });
  }
  return { text: runs.length ? runs : [{ text: "—" }] };
}
function htmlBlok(html) {
  return { ...htmlNaPdfmake(html), fontSize: 10.5, lineHeight: 1.4, margin: [2, 0, 2, 0] };
}

// Czy pole rich-text ma realną treść? Puste akapity (<div><br></div>), same
// spacje lub &nbsp; nie liczą się — inaczej „pusta" sekcja rysowała sam
// nagłówek bez treści (w PDF i w podglądzie).
function maTresc(html) {
  if (!html) return false;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, "").length > 0;
}

// Paleta redesignu (spójna z abyard.com): ciepła czerń + złocisty amber jako
// jedyny akcent, ciepłe hairline'y, kolory semantyczne dla stanu.
const PDF_KOL = {
  ink: "#0F0F0E", ink2: "#191917", czarny: "#0F0F0E",
  zolty: "#F2A900", zoltyBright: "#FBC441", zoltyDeep: "#C8880B", zoltyJasny: "#FFF6DF",
  szary: "#6E6A62", szary2: "#9A958B", linia: "#E4E1D9",
  czerwony: "#C0392B", zielony: "#1B7A3D", stopka: "#FBF3DF",
};
const PDF_SZER = 515; // szerokość treści A4 przy marginesach 40

// Overline sekcji: „/ TYTUŁ" w monospace (amber) + cienki hairline pod spodem.
// idx — opcjonalny podpis po prawej (numer sekcji / etykieta, np. „TYS. ZŁ").
function overlineStack(tytul, idx, width) {
  return [
    { columns: [
      { text: [{ text: "/ ", color: PDF_KOL.zolty, bold: true }, { text: String(tytul).toUpperCase(), color: PDF_KOL.zoltyDeep }], font: "Mono", fontSize: 11.5, characterSpacing: 1.2, width: "*" },
      idx ? { text: String(idx), font: "Mono", fontSize: 10, color: PDF_KOL.szary2, alignment: "right", width: "auto", margin: [0, 3, 0, 0] } : {},
    ] },
    { canvas: [{ type: "line", x1: 0, y1: 4, x2: width || PDF_SZER, y2: 4, lineWidth: 0.8, lineColor: PDF_KOL.linia }], margin: [0, 4, 0, 0] },
  ];
}

function pdfNaglowekSekcji(tytul, idx) {
  return {
    // headlineLevel — używane przez pageBreakBefore, by nagłówek nie został
    // sam na dole strony (przenosimy go wtedy na następną, do swojej treści).
    headlineLevel: 1,
    stack: overlineStack(tytul, idx),
    margin: [0, 22, 0, 10],
  };
}

// Nagłówek sekcji jako KOMÓRKA (overline) do zagnieżdżenia w tabeli
// keepWithHeaderRows — używane przez pdfSekcjaTekst / pushSekcjaTabela.
function pdfNaglowekKomorka(tytul, idx) {
  return {
    border: [false, false, false, false],
    stack: overlineStack(tytul, idx),
    margin: [0, 0, 0, 2],
  };
}

// Sekcja tekstowa z nagłówkiem TRWALE związanym z pierwszą linią treści.
// Zamiast liczyć pozycję (zawodne pageBreakBefore), wkładamy nagłówek i pierwszą
// linię do jednej tabeli z keepWithHeaderRows — pdfmake nie może ich rozdzielić,
// więc nagłówek nigdy nie zostaje sam/ucięty na dole strony. Reszta treści płynie
// jako osobny węzeł (bez ryzyka ucięcia długich sekcji).
function pdfSekcjaTekst(content, tytul, val) {
  if (!maTresc(val)) return;
  const blok = htmlBlok(val);
  const runs = Array.isArray(blok.text) ? blok.text : [blok.text];
  const iNl = runs.findIndex((r) => r && r.text === "\n");
  const pierwsza = iNl < 0 ? runs : runs.slice(0, iNl);   // pierwsza linia (bez \n)
  const reszta = iNl < 0 ? [] : runs.slice(iNl + 1);      // reszta (podział daje granica węzła)
  content.push({
    table: {
      headerRows: 1,
      keepWithHeaderRows: 1,
      widths: ["*"],
      body: [
        [pdfNaglowekKomorka(tytul)],
        [{ text: pierwsza.length ? pierwsza : [{ text: "" }], fontSize: 10.5, lineHeight: 1.4, margin: [2, 6, 2, 0], border: [false, false, false, false] }],
      ],
    },
    layout: "noBorders",
    margin: [0, 16, 0, 0],
  });
  if (reszta.length) content.push({ text: reszta, fontSize: 10.5, lineHeight: 1.4, margin: [2, 0, 2, 0] });
}

// Sekcja tabelaryczna (harmonogram, cashflow) z nagłówkiem sekcji TRWALE
// związanym z początkiem tabeli. Pierwsza tabela (keepWithHeaderRows) trzyma
// razem: nagłówek sekcji + nagłówek kolumn + pierwszy wiersz danych — pdfmake
// nie może ich rozdzielić, więc nagłówek nie zostaje sam na dole strony. Reszta
// wierszy płynie jako druga tabela z powtarzanym nagłówkiem kolumn.
// body[0] = wiersz nagłówka kolumn; body[1..] = dane (+ podsumowanie).
function pushSekcjaTabela(content, tytul, widths, body, layout) {
  const n = widths.length;
  const naglRow = [{ ...pdfNaglowekKomorka(tytul), colSpan: n }];
  for (let i = 1; i < n; i++) naglRow.push({});
  const colH = body[0];
  const dane = body.slice(1);
  const first = dane.length ? [dane[0]] : [];
  const rest = dane.slice(1);
  // W tabeli-kluczu chowamy górną linię nad paskiem nagłówka sekcji.
  const layKey = { ...layout, hLineWidth: (i, node) => (i === 0 ? 0 : (layout.hLineWidth ? layout.hLineWidth(i, node) : 0.5)) };
  content.push({
    table: { widths, headerRows: 2, keepWithHeaderRows: 1, body: [naglRow, colH, ...first] },
    layout: layKey,
    margin: [0, 16, 0, 0],
  });
  if (rest.length) content.push({ table: { headerRows: 1, widths, body: [colH, ...rest] }, layout });
}

async function pdfHarmonogram(content, form) {
  const { ink, zolty, zoltyBright, zoltyJasny, szary, szary2, linia, czerwony, zielony, stopka } = PDF_KOL;
  if (form.harmonogramObrazy && form.harmonogramObrazy.length > 0) {
    content.push(pdfNaglowekSekcji("Harmonogram budowy"));
    for (const o of form.harmonogramObrazy) {
      const im = await przygotujObraz(o.dataUrl || o.url);
      if (im) content.push({ image: im.dataUrl, fit: [PDF_SZER, 700], alignment: "center", margin: [0, 0, 0, 10] });
    }
    return;
  }
  const wiersze = (form.harmonogram || []).map((r, idx) => ({ ...r, nr: idx + 1 }))
    .filter((r) => { const ef = efektywnyWiersz(r); return ef.start || ef.koniec || ef.rzecz || ef.proc !== ""; });
  if (wiersze.length === 0) return;

  // Kolumna „Progn./rzecz." (kluczowa data) wyróżniona: amber-band + pogrubienie.
  // Daty umowne (Start/Koniec) przygaszone na szaro, żeby się cofnęły — inaczej
  // trzy identyczne kolumny dat zlewały się w oczach.
  const th = (t, al, col) => ({ text: String(t).toUpperCase(), font: "Mono", fontSize: 7, color: col || "#FFFFFF", fillColor: ink, alignment: al || "left", margin: [3, 7, 3, 7], border: [false, false, false, false] });
  const dot = { text: "●", font: "Mono", color: zolty, fontSize: 5.5 };
  const umowa = (t) => ({ text: t, font: "Mono", fontSize: 7, color: szary2, alignment: "center", margin: [3, 7, 3, 7] });
  const rzeczCell = (t, main) => ({ text: t, font: "Mono", fontSize: 7.5, bold: true, color: main ? ink : "#6B6552", alignment: "center", fillColor: zoltyJasny, margin: [3, 7, 3, 7] });

  const body = [[ th("#", "left"), th("Zadanie", "left"), th("Start", "center"), th("Koniec um.", "center"), th("Progn./rzecz.", "center", zoltyBright), th("%", "right"), th("Opóźn.", "right") ]];
  for (const r of wiersze) {
    const ef = efektywnyWiersz(r);
    const op = obliczOpoznienie(ef, form.dataOpracowania);
    const pctN = parseInt(ef.proc, 10);
    const pod = maPodpozycje(r) ? r.pod.filter((p) => p && (p.zadanie || p.start || p.koniec || p.rzecz || p.proc)) : [];
    body.push([
      { text: String(r.nr), font: "Mono", fontSize: 7.5, color: ink, margin: [3, 7, 3, 7] },
      { text: [dot, { text: "  " + (r.zadanie || "—"), bold: true, color: ink, font: "Roboto" }], fontSize: 8.5, margin: [3, 6, 3, 6] },
      umowa(fmtPL(ef.start) || "—"), umowa(fmtPL(ef.koniec) || "—"), rzeczCell(fmtPL(ef.rzecz) || "—", true),
      { text: ef.proc !== "" ? `${ef.proc}%` : "—", font: "Mono", fontSize: 7, bold: true, color: (ef.proc !== "" && pctN >= 100) ? zielony : ink, alignment: "right", margin: [3, 7, 3, 7] },
      { text: op || "—", font: "Mono", fontSize: 7, bold: !!op, color: op ? czerwony : zielony, alignment: "right", margin: [3, 7, 3, 7] },
    ]);
    for (let j = 0; j < pod.length; j++) {
      const p = pod[j]; const opP = obliczOpoznienie(p, form.dataOpracowania); const ppN = parseInt(p.proc, 10);
      body.push([
        { text: `${r.nr}.${j + 1}`, font: "Mono", fontSize: 6.5, color: szary2, margin: [3, 7, 3, 7] },
        { text: p.zadanie || "—", fontSize: 7.5, color: szary, margin: [14, 6, 3, 6] },
        umowa(fmtPL(p.start) || "—"), umowa(fmtPL(p.koniec) || "—"), rzeczCell(fmtPL(p.rzecz) || "—", false),
        { text: (p.proc !== "" && p.proc != null) ? `${p.proc}%` : "—", font: "Mono", fontSize: 7, color: (p.proc !== "" && ppN >= 100) ? zielony : szary, alignment: "right", margin: [3, 7, 3, 7] },
        { text: opP || "—", font: "Mono", fontSize: 7, bold: !!opP, color: opP ? czerwony : zielony, alignment: "right", margin: [3, 7, 3, 7] },
      ]);
    }
  }
  const konce = [], starty = [];
  for (const w of (form.harmonogram || [])) { const ef = efektywnyWiersz(w); if (ef.start) starty.push(ef.start); const kon = ef.rzecz || ef.koniec; if (kon) konce.push(kon); }
  const dataMin = starty.sort()[0] || ""; const dataMax = konce.sort()[konce.length - 1] || "";
  const opoz = opoznienieInwestycji(form.harmonogram, form.dataOpracowania);
  const maKwoty = harmonogramMaKwoty(form.harmonogram); const sumaKwot = sumaWartosciUmowy(form.harmonogram);
  const sf = (t, o = {}) => ({ text: t, font: o.font || "Mono", fontSize: o.fs || 7.5, bold: o.bold !== false, fillColor: stopka, alignment: o.al || "center", color: o.color, margin: [3, 8, 3, 8] });
  body.push([
    sf("Σ", { fs: 8 }),
    sf(`PODSUMOWANIE INWESTYCJI${maKwoty ? ` · ${Math.round(sumaKwot).toLocaleString("pl-PL")} zł` : ""}`, { font: "Roboto", fs: 8.5, al: "left" }),
    sf(fmtPL(dataMin) || "—", { bold: false, fs: 7 }),
    { ...sf(fmtPL(dataMax) || "—", { bold: false, fs: 7 }), colSpan: 2 }, {},
    sf(""), sf(opoz ? (opoz.dni > 0 ? `${opoz.dni} dni` : "brak") : "—", { color: opoz && opoz.dni > 0 ? czerwony : zielony }),
  ]);
  // Overline sekcji + pojedyncza tabela z headerRows:1 — nagłówek kolumn
  // powtarza się na kolejnych stronach, bez duplikatu-paska w środku tabeli.
  content.push(pdfNaglowekSekcji("Harmonogram budowy"));
  content.push({ table: { headerRows: 1, widths: [24, "*", 52, 52, 56, 28, 46], body }, layout: {
    hLineColor: () => linia, vLineColor: () => linia, hLineWidth: (i) => (i === 1 ? 0 : 0.5), vLineWidth: () => 0,
    paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
  }, margin: [0, 2, 0, 0] });
}

function pdfCashflow(content, form) {
  const { ink, zolty, zoltyBright, zoltyJasny, szary2, linia } = PDF_KOL;
  if (!harmonogramMaKwoty(form.harmonogram)) return;
  const m = macierzCashflow(form.harmonogram);
  if (!m.zadania.length || !m.miesiace.length) return;
  const { miesiace, zadania, sumaMies, sumaNaras, sumaCalosc } = m;
  const nM = miesiace.length;
  const wTys = nM > 10;                       // ten sam próg co w podglądzie HTML (sekcja cashflow)
  // Strona cashflow w POZIOMIE (landscape) — szeroka tabela finansowa (nawet 30+
  // miesięcy przy budowach 2–3 letnich) mieści się z zapasem i czytelnym fontem.
  // Kolumny STAŁE (bez „*"), font wiązany z szerokością kolumny.
  const CW_L = 762;                            // szerokość treści A4 poziomo (842 − 2·40)
  const fixZ = 120, fixN = 44, fixS = 30, fixK = 30;
  const monthW = Math.max(12, Math.min(70, Math.floor((CW_L - fixZ - fixN - fixS - fixK - 20) / nM)));
  const fs = Math.max(5, Math.min(9, (monthW - 1) / 2.35));
  // W trybie „tys. zł" bez separatora tysięcy — spacja łamała liczby w wąskich
  // kolumnach (przy wielu miesiącach). noWrap na komórkach liczbowych/datowych
  // gwarantuje jedną linię (nazwa zadania nadal się zawija).
  const fmtZ = (n) => !n ? "" : (wTys ? String(Math.round(n / 1000)) : Math.round(n).toLocaleString("pl-PL"));
  const fmtMY = (iso) => { if (!iso) return "—"; const p = String(iso).split("-"); return p.length >= 2 ? `${p[1]}.${p[0].slice(2)}` : (fmtPL(iso) || "—"); };
  const tytulCash = `Harmonogram przepływów finansowych — sprzedaż${wTys ? " (tys. zł)" : ""}`;
  const th = (t, al, col) => ({ text: t, font: "Mono", fillColor: ink, color: col || "#FFFFFF", fontSize: fs, alignment: al || "right", noWrap: al !== "left", margin: [1, 6, 1, 6], border: [false, false, false, false] });
  const c = (t, o = {}) => ({ text: t, font: "Mono", fontSize: fs, alignment: o.al || "right", noWrap: o.al !== "left", fillColor: o.fill, color: o.color, bold: o.bold, margin: [1, 5, 1, 5] });
  // Nagłówki miesięcy dwuwierszowo („10" nad „24") — mieszczą się w wąskich kolumnach.
  const thM = (mi) => ({ text: String(mi.etykieta).replace(".", "\n"), font: "Mono", fillColor: ink, color: zoltyBright, fontSize: fs, alignment: "center", lineHeight: 0.95, margin: [1, 4, 1, 4], border: [false, false, false, false] });
  const body = [[th("Zadanie", "left"), th("Netto", "right", zoltyBright), th("Start", "center", zoltyBright), th("Koniec", "center", zoltyBright), ...miesiace.map(thM)]];
  for (const z of zadania) {
    body.push([
      c(z.nazwa, { al: "left", color: "#26251F" }), c(fmtZ(z.kwota), { color: "#26251F" }),
      c(fmtMY(z.start), { al: "center", color: szary2 }), c(fmtMY(z.koniec), { al: "center", color: szary2 }),
      ...miesiace.map((mi) => { const v = z.komorki[mi.klucz]; return c(v ? fmtZ(v) : "–", { fill: v ? zoltyJasny : undefined, color: v ? "#26251F" : szary2 }); }),
    ]);
  }
  body.push([c("RAZEM mies.", { al: "left", bold: true, fill: "#F3F0E8" }), c(fmtZ(sumaCalosc), { bold: true, fill: "#F3F0E8" }), c("", { fill: "#F3F0E8" }), c("", { fill: "#F3F0E8" }), ...miesiace.map((mi) => c(fmtZ(sumaMies[mi.klucz]), { bold: true, fill: "#F3F0E8" }))]);
  body.push([c("Narastająco", { al: "left", bold: true, fill: zolty, color: ink }), c("", { fill: zolty }), c("", { fill: zolty }), c("", { fill: zolty }), ...miesiace.map((mi) => c(fmtZ(sumaNaras[mi.klucz]), { bold: true, fill: zolty, color: ink }))]);
  const widths = [fixZ, fixN, fixS, fixK, ...miesiace.map(() => monthW)];
  // Overline sekcji na osobnej stronie POZIOMEJ (hairline na pełną szerokość landscape).
  content.push({ headlineLevel: 1, stack: overlineStack(tytulCash, null, CW_L), margin: [0, 0, 0, 10], pageBreak: "before", pageOrientation: "landscape" });
  content.push({ table: { headerRows: 1, widths, body }, layout: {
    hLineColor: () => linia, vLineColor: () => linia, hLineWidth: (i) => (i === 1 ? 0 : 0.4), vLineWidth: () => 0.3,
    paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
  }, margin: [0, 2, 0, 0] });
}

// Wysokość obszaru druku A4 po marginesach (~757 pt) i przybliżone wysokości
// nagłówka sekcji oraz wiersza podpisu — używane do pionowego rozmieszczania
// zdjęć na stronie (wyśrodkowanie pojedynczego, wspólna wysokość pary).
const FOTO_USABLE_H = 750;
const FOTO_HEADER_H = 54;
const FOTO_CAPTION_H = 22;

// Podpis pod zdjęciem: mono „FOT. NN" (amber) + opcjonalny opis użytkownika.
function fotoPodpis(nr, opis) {
  const labelText = "FOT. " + String(nr).padStart(2, "0");
  const label = { text: labelText, font: "Mono", fontSize: 8, color: PDF_KOL.zoltyDeep, characterSpacing: 1 };
  // Podpis wyśrodkowany pod zdjęciem (label „FOT. NN" + opcjonalny opis w jednej linii).
  if (!opis) return { ...label, alignment: "center", margin: [0, 4, 0, 6] };
  return {
    text: [
      { text: labelText + "   ", font: "Mono", fontSize: 8, color: PDF_KOL.zoltyDeep, characterSpacing: 1 },
      { text: opis, fontSize: 9.5, bold: true, color: "#26251F" },
    ],
    alignment: "center",
    margin: [0, 4, 0, 6],
  };
}

async function pdfZdjecia(content, form) {
  if (!form.zdjecia || form.zdjecia.length === 0) return;
  // Grupowanie jak w podglądzie: pionowe (lub bez orientacji) 1/str., poziome 2/str.
  const strony = []; let bufor = [];
  for (const z of form.zdjecia) {
    const poziome = z.pion === false;
    if (!poziome) { if (bufor.length) { strony.push(bufor); bufor = []; } strony.push([z]); }
    else { bufor.push(z); if (bufor.length === 2) { strony.push(bufor); bufor = []; } }
  }
  if (bufor.length) strony.push(bufor);

  let pierwszaGrupa = true;
  let fotoNr = 0;
  for (const grupa of strony) {
    // Wczytujemy obrazy z wymiarami (a = proporcja szer./wys.).
    const zdj = [];
    for (const z of grupa) {
      const im = await przygotujObraz(z.dataUrl || z.url);
      if (im) zdj.push({ z, im, a: im.w / im.h });
    }
    if (zdj.length === 0) continue;

    const naglowekTu = pierwszaGrupa;
    const podpisy = zdj.length; // każde zdjęcie ma teraz podpis „FOT. NN"
    const dostepna = FOTO_USABLE_H - (naglowekTu ? FOTO_HEADER_H : 0) - podpisy * FOTO_CAPTION_H;

    const elems = [];
    if (zdj.length >= 2) {
      // Dwa poziome zdjęcia na stronie — WSPÓLNA SZEROKOŚĆ, wyśrodkowane.
      // Ta sama szerokość = wyrównane krawędzie i jednakowy „rozmiar" na oko
      // (dla zdjęć o zbliżonych proporcjach wychodzą wręcz identyczne).
      // Szerokość dobrana tak, by suma wysokości (Σ szer/proporcja) zmieściła
      // się w dostępnej przestrzeni; nigdy nie przekracza szerokości strony.
      const sumaOdwrProp = zdj.reduce((s, x) => s + 1 / x.a, 0);
      const W = Math.max(120, Math.min(PDF_SZER, Math.floor((dostepna - 24) / sumaOdwrProp)));
      zdj.forEach((x, i) => {
        elems.push({ image: x.im.dataUrl, width: W, alignment: "center", margin: [0, i === 0 ? 6 : 10, 0, 2] });
        elems.push(fotoPodpis(++fotoNr, x.z.opis));
      });
    } else {
      // Pojedyncze zdjęcie — wyśrodkowane w pionie na stronie.
      const x = zdj[0];
      const maxH = Math.min(dostepna, 640);
      const skala = Math.min(PDF_SZER / x.im.w, maxH / x.im.h);
      const renderH = x.im.h * skala;
      const wolne = Math.max(0, dostepna - renderH - (x.z.opis ? FOTO_CAPTION_H : 0));
      const gora = Math.min(Math.floor(wolne / 2), 240); // wyśrodkowanie, z limitem bezpieczeństwa
      elems.push({ image: x.im.dataUrl, fit: [PDF_SZER, Math.floor(maxH)], alignment: "center", margin: [0, 6 + gora, 0, 2] });
      elems.push(fotoPodpis(++fotoNr, x.z.opis));
    }

    if (naglowekTu) {
      const nag = pdfNaglowekSekcji("Dokumentacja fotograficzna");
      nag.pageBreak = "before";
      nag.pageOrientation = "portrait"; // powrót do pionu po poziomym cashflow
      content.push(nag);
      pierwszaGrupa = false;
    } else {
      elems[0].pageBreak = "before";
    }
    content.push(...elems);
  }
}

// Buduje definicję dokumentu pdfmake z formularza raportu (bez pobierania).
async function budujDocDefinition(form) {
  const { ink, ink2, zolty, zoltyBright, zoltyDeep, szary, szary2, czerwony, zielony } = PDF_KOL;
  const content = [];

  // ——— OKŁADKA (wariant „magazynowy": grafika inwestycji pełnoklatkowa u góry,
  //     pod nią wielki numer, projekt i tytuł; kluczowe daty przypięte do dołu) ———
  const PW = 595.28, PH = 841.89;
  // Grafika inwestycji → pełna szerokość strony; wysokość z proporcji (maks 58% strony).
  // Trzymana w domknięciu — rysowana w `background` (bleeduje do krawędzi).
  let coverImg = null, coverH = 0;
  if (form.grafikaInwestycji && (form.grafikaInwestycji.dataUrl || form.grafikaInwestycji.url)) {
    const g = await przygotujObraz(form.grafikaInwestycji.dataUrl || form.grafikaInwestycji.url);
    if (g && g.w && g.h) { coverImg = g.dataUrl; coverH = Math.min(PH * 0.58, PW * g.h / g.w); }
  }

  // Treść okładki (flow) zaczyna się tuż pod grafiką (margines uwzględnia margines strony 40).
  const coverGora = coverImg ? Math.max(18, coverH - 40 + 8) : 62;
  content.push({ text: [{ text: "/ ", color: zolty }, { text: `OKRES ${fmtPL(form.okresOd) || "…"} — ${fmtPL(form.okresDo) || "…"}`, color: zoltyDeep }], font: "Mono", fontSize: 9, characterSpacing: 1.2, margin: [0, coverGora, 0, 0] });
  content.push({ text: [{ text: "/", color: zolty }, { text: String(form.numer).padStart(3, "0"), color: "#FFFFFF" }], font: "RobotoBlack", fontSize: 96, lineHeight: 0.85, margin: [-3, 4, 0, 0] });
  content.push({ text: form.projekt || "", color: "#FFFFFF", font: "RobotoBlack", fontSize: 34, margin: [0, 2, 0, 0] });
  if (form.adres) content.push({ text: String(form.adres).toUpperCase(), color: szary2, font: "Mono", fontSize: 8.5, characterSpacing: 1, margin: [0, 9, 0, 0] });
  if (form.tytulZadania) content.push({ text: `„${form.tytulZadania}”`, color: "#B9B4AA", italics: true, fontSize: 9.5, lineHeight: 1.4, margin: [0, 12, 70, 0] });

  // Kluczowe daty + stopka — przypięte do dołu strony (absolutePosition).
  content.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: PW - 80, y2: 0, lineWidth: 1, lineColor: "#3A3A36" }], absolutePosition: { x: 40, y: 724 } });
  const datyOkl = [
    ["Rozpoczęcie", fmtPL(form.rozpoczecie) || "—"],
    ["Zakończenie robót", fmtPL(form.zakonczenieRobot) || "—"],
    ["Pozwolenie na użytkowanie", form.pnuNieDotyczy ? "Nie dotyczy" : (fmtPL(form.pnu) || "—")],
  ];
  datyOkl.forEach(([l, v], i) => {
    content.push({ stack: [
      { text: String(l).toUpperCase(), font: "Mono", fontSize: 7.5, characterSpacing: 0.8, color: szary2 },
      { text: v, font: "RobotoBlack", fontSize: 14, color: "#FFFFFF", margin: [0, 6, 0, 0] },
    ], width: 170, absolutePosition: { x: 40 + i * 172, y: 740 } });
  });
  content.push({ text: `OPRACOWAŁ · ${(form.opracowal || "—").toUpperCase()}`, font: "Mono", fontSize: 8, characterSpacing: 0.6, color: szary2, absolutePosition: { x: 40, y: 802 } });
  content.push({ text: `DATA · ${fmtPL(form.dataOpracowania) || "—"}`, font: "Mono", fontSize: 8, characterSpacing: 0.6, color: szary2, alignment: "right", width: PW - 80, absolutePosition: { x: 40, y: 802 } });

  // Strona tytułowa kończy się na kluczowych datach — reszta od nowej strony
  const nagInfo = pdfNaglowekSekcji("Informacje ogólne");
  nagInfo.pageBreak = "before";
  content.push(nagInfo);
  content.push(htmlBlok(form.infoOgolne));
  if (maTresc(form.opoznienia)) {
    content.push({ table: { widths: [3, "*"], body: [[
      { text: "", fillColor: zolty, border: [false, false, false, false] },
      { stack: [
        { text: "⚠ OPÓŹNIENIA I DZIAŁANIA NAPRAWCZE", font: "Mono", fontSize: 8.5, characterSpacing: 1, color: zoltyDeep, margin: [0, 0, 0, 5] },
        htmlBlok(form.opoznienia),
      ], fillColor: "#FFF8EC", margin: [12, 10, 12, 10], border: [false, false, false, false] },
    ]] }, layout: "noBorders", margin: [0, 12, 0, 0] });
  }
  pdfSekcjaTekst(content, "Wykonawcy prac", form.wykonawcy);
  pdfSekcjaTekst(content, "Przetargi", form.przetargi);
  pdfSekcjaTekst(content, "Sprawy ogólne budowy", form.sprawyBudowy);
  pdfSekcjaTekst(content, "Sprawy dotyczące Inwestora", form.sprawyInwestora);
  pdfSekcjaTekst(content, "Teren placu budowy", form.placBudowy);

  content.push(pdfNaglowekSekcji("Podsumowanie"));
  content.push({ table: { widths: [4, "*"], body: [[{ text: "", fillColor: zolty, border: [false, false, false, false] }, { text: form.podsumowanie || "—", font: "RobotoBlack", fontSize: 14, lineHeight: 1.3, color: ink, margin: [16, 2, 0, 2], border: [false, false, false, false] }]] }, layout: "noBorders" });

  await pdfHarmonogram(content, form);
  pdfCashflow(content, form);
  await pdfZdjecia(content, form);

  const marginesGora = 40;
  // Min. wolne miejsce POD początkiem nagłówka (belka ~28 pt + kilka wierszy),
  // by nagłówek nie został sam/ucięty na dole strony.
  const MIN_MIEJSCE_NAGL = 80;
  return {
    pageSize: "A4",
    pageMargins: [40, marginesGora, 40, 40],
    defaultStyle: { font: "Roboto", fontSize: 10, color: ink, lineHeight: 1.25 },
    // Strona 1 (okładka „magazynowa"): ciepła czerń + grafika inwestycji
    // pełnoklatkowa u góry, z gradientami (górny — pod pasek, dolny — wtopienie w czerń).
    background: (page) => {
      if (page !== 1) return null;
      const bg = [{ canvas: [{ type: "rect", x: 0, y: 0, w: PW, h: PH, color: ink }] }];
      if (coverImg) {
        bg.push({ image: coverImg, width: PW, absolutePosition: { x: 0, y: 0 } });
        // Górny gradient — czytelność paska nad jasnym niebem grafiki.
        const topFade = [], TN = 16, TH = 96;
        for (let i = 0; i <= TN; i++) topFade.push({ type: "rect", x: 0, y: i * (TH / TN), w: PW, h: TH / TN + 0.8, color: ink, fillOpacity: 0.5 * (1 - i / TN) });
        bg.push({ canvas: topFade, absolutePosition: { x: 0, y: 0 } });
        // Dolny gradient — wtopienie dołu grafiki w czerń strony.
        const botFade = [], BN = 22, BH = 110;
        for (let i = 0; i <= BN; i++) botFade.push({ type: "rect", x: 0, y: coverH - BH + i * (BH / BN), w: PW, h: BH / BN + 0.8, color: ink, fillOpacity: i / BN });
        bg.push({ canvas: botFade, absolutePosition: { x: 0, y: 0 } });
      }
      // Pasek górny nad grafiką: overline + plakietka numeru.
      bg.push({ text: [{ text: "/ ", color: zoltyBright }, { text: "RAPORT Z BUDOWY · ABYARD", color: "#FFFFFF" }], font: "Mono", fontSize: 9, characterSpacing: 1.4, absolutePosition: { x: 40, y: 41 } });
      bg.push({ table: { body: [[{ text: `NR ${String(form.numer).padStart(3, "0")}`, font: "Mono", fontSize: 9, bold: true, color: "#161512", fillColor: zolty, margin: [9, 4, 9, 4], border: [false, false, false, false] }]] }, layout: "noBorders", absolutePosition: { x: 497, y: 34 } });
      return bg;
    },
    content,
    // Nagłówek sekcji (headlineLevel:1) nie może zostać sam na dole strony ani
    // rozłamać się (samo tło belki na jednej stronie, tekst na drugiej).
    // Warunek foll.length===0 zawodzi w pdfmake 0.2.10 (kolejny węzeł bywa liczony
    // jako „na stronie", choć przechodzi dalej), więc wykrywamy sierotę po
    // pozycji: ile miejsca zostaje pod początkiem nagłówka do dołu obszaru druku.
    // Jeśli za mało — pageBreakBefore przenosi nagłówek na następną stronę, do
    // jego treści. Odpowiednik CSS break-after: avoid z podglądu.
    pageBreakBefore: (cur) => {
      if (cur.headlineLevel !== 1 || !cur.startPosition) return false;
      const pozostaje = (marginesGora + cur.startPosition.pageInnerHeight) - cur.startPosition.top;
      return pozostaje < MIN_MIEJSCE_NAGL;
    },
    footer: (cur, total) => cur === 1 ? null : ({ text: `${cur} / ${total}`, alignment: "center", font: "Mono", fontSize: 7.5, color: szary2, margin: [0, 8, 0, 0] }),
  };
}

// Leniwe wczytanie biblioteki pdfmake z osobnego pliku dist/pdfmake-lib.js.
// Ładowane dopiero przy pierwszym eksporcie — nie obciąża startu aplikacji.
// Zwraca instancję pdfMake (z podpiętym vfs fontów) spod window.__pdfmakeLib.
let _pdfmakePromise = null;
function zaladujPdfmake() {
  if (typeof window !== "undefined" && window.__pdfmakeLib) return Promise.resolve(window.__pdfmakeLib);
  if (_pdfmakePromise) return _pdfmakePromise;
  _pdfmakePromise = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "pdfmake-lib.js"; // serwowany z katalogu dist/ obok index.html
    s.async = true;
    s.onload = () => window.__pdfmakeLib ? res(window.__pdfmakeLib) : rej(new Error("pdfmake-lib.js wczytany, ale biblioteka niedostępna"));
    s.onerror = () => { _pdfmakePromise = null; rej(new Error("Nie udało się wczytać modułu PDF (pdfmake-lib.js)")); };
    document.head.appendChild(s);
  });
  return _pdfmakePromise;
}

// Buduje i pobiera plik PDF raportu. form: stan formularza (jak w PodgladPDF).
async function pobierzPDF(form, nazwaPliku) {
  const [dd, pdfMake] = await Promise.all([budujDocDefinition(form), zaladujPdfmake()]);
  pdfMake.createPdf(dd).download(`${nazwaPliku}.pdf`);
}

function PodgladPDF({ form, onBack, nazwaPliku, raportId, publiczny, jestAdmin }) {
  const [pokazLinki, setPokazLinki] = useState(false);
  const [pobieranie, setPobieranie] = useState(false);
  async function pobierzPlikPDF() {
    if (pobieranie) return;
    setPobieranie(true);
    try {
      await pobierzPDF(form, nazwaPliku);
    } catch (e) {
      console.error(e);
      alert("Nie udało się wygenerować pliku PDF: " + (e?.message || e) + "\n\nSprawdź połączenie i spróbuj ponownie.");
    } finally {
      setPobieranie(false);
    }
  }
  return (
    <div style={{ background: "#2A2926", minHeight: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <style>{printCSS}</style>
      <div className="noprint" style={{ position: "sticky", top: 0, background: C.czarny, padding: "12px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 10, flexWrap: "wrap", gap: 10 }}>
        <span style={{ color: C.bialy, fontSize: 14 }}>Podgląd raportu — <strong>{nazwaPliku}.pdf</strong></span>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {onBack && <button style={btnGhostDark} onClick={onBack}>← Wróć do edycji</button>}
          {!publiczny && (raportId ? (
            <button style={btnGhostDark} onClick={() => setPokazLinki((v) => !v)}>
              {pokazLinki ? "Zamknij linki" : "🔗 Linki do raportu"}
            </button>
          ) : (
            <button style={{ ...btnGhostDark, opacity: 0.45, cursor: "not-allowed" }} disabled
              title="Najpierw zapisz raport w bazie — link musi wskazywać zapisany raport">
              🔗 Linki do raportu
            </button>
          ))}
          <button style={{ ...btnPrimary, opacity: pobieranie ? 0.6 : 1, cursor: pobieranie ? "wait" : "pointer" }} disabled={pobieranie}
            onClick={pobierzPlikPDF} title="Pobierz gotowy plik PDF raportu">
            {pobieranie ? "Generowanie…" : "⬇ Pobierz PDF"}
          </button>
        </div>
      </div>

      {pokazLinki && raportId && !publiczny && <PanelLinkow raportId={raportId} jestAdmin={jestAdmin} />}

      <div className="pdf-page" style={{ background: CR.card, maxWidth: 794, margin: "20px auto", boxShadow: "0 4px 30px rgba(0,0,0,0.3)", color: CR.ink, fontFamily: "'Roboto', 'Segoe UI', system-ui, sans-serif", overflow: "hidden" }}>
        {/* ——— OKŁADKA — wariant „magazynowy" (jak strona 1 PDF) ——— */}
        <div className="pdf-cover" style={{ background: CR.ink, color: "#fff", padding: 0, position: "relative" }}>
          {/* Grafika inwestycji — pełnoklatkowa u góry, z gradientami (górny pod pasek, dolny wtopienie) */}
          {form.grafikaInwestycji && (
            <div style={{ position: "relative" }}>
              <img className="cover-foto" src={form.grafikaInwestycji.dataUrl} alt="" style={{ display: "block", width: "100%", maxHeight: "150mm", objectFit: "cover" }} />
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 96, background: "linear-gradient(180deg, rgba(15,15,14,0.55) 0%, rgba(15,15,14,0) 100%)" }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 110, background: `linear-gradient(180deg, rgba(15,15,14,0) 0%, ${CR.ink} 100%)` }} />
            </div>
          )}
          {/* Pasek górny nad grafiką (lub na czerni, gdy brak grafiki) */}
          <div className="cover-bar" style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "26px 40px" }}>
            <span style={{ fontFamily: CR.mono, fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#fff" }}><span style={{ color: CR.goldBright }}>/ </span>Raport z budowy · Abyard</span>
            <span style={{ fontFamily: CR.mono, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: "#161512", background: CR.gold, padding: "4px 10px", borderRadius: 3 }}>NR {String(form.numer).padStart(3, "0")}</span>
          </div>
          {/* Treść okładki */}
          <div className="cover-body" style={{ padding: form.grafikaInwestycji ? "6px 40px 34px" : "88px 40px 34px" }}>
            <div style={{ fontFamily: CR.mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: CR.goldDeep }}><span style={{ color: CR.gold }}>/ </span>Okres {fmtPL(form.okresOd) || "…"} — {fmtPL(form.okresDo) || "…"}</div>
            <div className="cover-num" style={{ fontWeight: 900, fontSize: 100, lineHeight: 0.85, marginTop: 6, letterSpacing: "-0.03em" }}><span style={{ color: CR.gold }}>/</span>{String(form.numer).padStart(3, "0")}</div>
            <h2 className="cover-proj" style={{ fontWeight: 900, fontSize: 38, margin: "4px 0 0", lineHeight: 1.03, letterSpacing: "-0.02em" }}>{form.projekt}</h2>
            {form.adres && <p style={{ fontFamily: CR.mono, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: CR.muted, margin: "10px 0 0" }}>{form.adres}</p>}
            {form.tytulZadania && <p style={{ color: "#B9B4AA", fontStyle: "italic", fontSize: 12, margin: "12px 0 0", maxWidth: 620, lineHeight: 1.42 }}>„{form.tytulZadania}”</p>}
            <div style={{ height: 1, background: "rgba(255,255,255,0.14)", margin: "36px 0 0" }} />
            <div className="cover-daty" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 20 }}>
              {[["Rozpoczęcie", fmtPL(form.rozpoczecie) || "—"], ["Zakończenie robót", fmtPL(form.zakonczenieRobot) || "—"], ["Pozwolenie na użytkowanie", form.pnuNieDotyczy ? "Nie dotyczy" : (fmtPL(form.pnu) || "—")]].map(([l, v], i) => (
                <div key={i}>
                  <div style={{ fontFamily: CR.mono, fontSize: 8.5, letterSpacing: "0.12em", color: CR.muted2, textTransform: "uppercase" }}>{l}</div>
                  <div style={{ fontWeight: 900, fontSize: 16, marginTop: 6 }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 24, fontFamily: CR.mono, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: CR.muted }}>
              <span>Opracował · {form.opracowal || "—"}</span>
              <span>Data · {fmtPL(form.dataOpracowania) || "—"}</span>
            </div>
          </div>
        </div>

        {/* Twardy podział strony po okładce (druk) */}
        <div className="lamanie-strony" style={{ breakBefore: "page", pageBreakBefore: "always" }} />

        {/* ——— TREŚĆ (biała) ——— */}
        <div className="pdf-content" style={{ padding: "10px 56px 56px" }}>

        <BlokPDF tytul="Informacje ogólne">
          <Tekst v={form.infoOgolne} />
          {maTresc(form.opoznienia) && (
            <div style={{ marginTop: 14, background: CR.callout, borderLeft: `3px solid ${CR.gold}`, padding: "12px 16px", breakInside: "avoid", pageBreakInside: "avoid" }}>
              <div style={{ fontFamily: CR.mono, fontSize: 10.5, letterSpacing: "0.08em", color: CR.goldDeep, marginBottom: 6 }}>⚠ OPÓŹNIENIA I DZIAŁANIA NAPRAWCZE</div>
              <Tekst v={form.opoznienia} />
            </div>
          )}
        </BlokPDF>

        {maTresc(form.wykonawcy) && <BlokPDF tytul="Wykonawcy prac"><Tekst v={form.wykonawcy} /></BlokPDF>}
        {maTresc(form.przetargi) && <BlokPDF tytul="Przetargi"><Tekst v={form.przetargi} /></BlokPDF>}
        {maTresc(form.sprawyBudowy) && <BlokPDF tytul="Sprawy ogólne budowy"><Tekst v={form.sprawyBudowy} /></BlokPDF>}
        {maTresc(form.sprawyInwestora) && <BlokPDF tytul="Sprawy dotyczące Inwestora"><Tekst v={form.sprawyInwestora} /></BlokPDF>}
        {maTresc(form.placBudowy) && <BlokPDF tytul="Teren placu budowy"><Tekst v={form.placBudowy} /></BlokPDF>}

        <BlokPDF tytul="Podsumowanie">
          <div style={{ borderLeft: `4px solid ${CR.gold}`, paddingLeft: 16, fontWeight: 900, fontSize: 18, lineHeight: 1.3, color: CR.ink }}>{form.podsumowanie}</div>
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
          const hth = (al) => ({ background: CR.ink, color: "#fff", fontFamily: CR.mono, fontSize: 8.5, fontWeight: 400, letterSpacing: "0.04em", textTransform: "uppercase", padding: "9px 6px", textAlign: al, whiteSpace: "nowrap" });
          const htd = { padding: "9px 6px", borderBottom: `1px solid ${CR.line}`, textAlign: "center", fontSize: 10, fontFamily: CR.mono, color: CR.muted2 };
          const htdRz = { ...htd, background: CR.band, fontWeight: 700, color: CR.ink };
          return (
            <BlokPDF tytul="Harmonogram budowy">
              <div className="tabela-scroll-own" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={hth("left")}>#</th>
                    <th style={hth("left")}>Zadanie</th>
                    <th style={hth("center")}>Start</th>
                    <th style={hth("center")}>Koniec um.</th>
                    <th style={{ ...hth("center"), color: CR.goldBright }}>Progn./rzecz.</th>
                    <th style={hth("right")}>%</th>
                    <th style={hth("right")}>Opóźn.</th>
                  </tr>
                </thead>
                <tbody>
                  {wiersze.map((r) => {
                    const ef = efektywnyWiersz(r);
                    const op = obliczOpoznienie(ef, form.dataOpracowania);
                    const pctN = parseInt(ef.proc, 10);
                    const pod = maPodpozycje(r) ? r.pod.filter((p) => p && (p.zadanie || p.start || p.koniec || p.rzecz || p.proc)) : [];
                    return (
                      <React.Fragment key={r.nr}>
                        {/* Pozycja główna (zadanie) — kropka + pogrubienie */}
                        <tr>
                          <td style={{ ...htd, color: CR.ink }}>{r.nr}</td>
                          <td style={{ ...htd, textAlign: "left", fontFamily: "'Roboto', sans-serif", fontWeight: 700, color: CR.ink }}><span style={{ color: CR.gold, marginRight: 7, fontSize: 8 }}>●</span>{r.zadanie}</td>
                          <td style={htd}>{fmtPL(ef.start) || "—"}</td>
                          <td style={htd}>{fmtPL(ef.koniec) || "—"}</td>
                          <td style={htdRz}>{fmtPL(ef.rzecz) || "—"}</td>
                          <td style={{ ...htd, textAlign: "right", fontWeight: 700, color: (ef.proc !== "" && pctN >= 100) ? CR.ok : CR.ink }}>{ef.proc !== "" ? `${ef.proc}%` : "—"}</td>
                          <td style={{ ...htd, textAlign: "right", fontWeight: 700, color: op ? CR.danger : CR.ok }}>{op || "—"}</td>
                        </tr>
                        {/* Podpozycje — cieńsze, wcięte, przygaszone */}
                        {pod.map((p, j) => {
                          const opP = obliczOpoznienie(p, form.dataOpracowania);
                          const ppN = parseInt(p.proc, 10);
                          return (
                            <tr key={`${r.nr}-${j}`}>
                              <td style={{ ...htd, color: CR.muted2, fontSize: 9 }}>{r.nr}.{j + 1}</td>
                              <td style={{ ...htd, textAlign: "left", fontFamily: "'Roboto', sans-serif", paddingLeft: 20, color: CR.muted }}>{p.zadanie || "—"}</td>
                              <td style={htd}>{fmtPL(p.start) || "—"}</td>
                              <td style={htd}>{fmtPL(p.koniec) || "—"}</td>
                              <td style={{ ...htdRz, color: "#6B6552" }}>{fmtPL(p.rzecz) || "—"}</td>
                              <td style={{ ...htd, textAlign: "right", color: (p.proc !== "" && ppN >= 100) ? CR.ok : CR.muted }}>{p.proc !== "" && p.proc != null ? `${p.proc}%` : "—"}</td>
                              <td style={{ ...htd, textAlign: "right", color: opP ? CR.danger : CR.ok }}>{opP || "—"}</td>
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
                  const st = { padding: "10px 6px", background: CR.foot, fontFamily: CR.mono, fontWeight: 700, fontSize: 10, borderTop: `2px solid ${CR.ink}`, textAlign: "center" };
                  return (
                    <tfoot>
                      <tr>
                        <td style={st}>Σ</td>
                        <td style={{ ...st, textAlign: "left", fontFamily: "'Roboto', sans-serif" }}>PODSUMOWANIE INWESTYCJI{maKwoty ? ` · ${Math.round(sumaKwot).toLocaleString("pl-PL")} zł` : ""}</td>
                        <td style={{ ...st, fontWeight: 400 }}>{fmtPL(dataMin) || "—"}</td>
                        <td style={{ ...st, fontWeight: 400 }} colSpan={2}>{fmtPL(dataMax) || "—"}</td>
                        <td style={st}></td>
                        <td style={{ ...st, textAlign: "right", color: opoz && opoz.dni > 0 ? CR.danger : CR.ok }}>{opoz ? (opoz.dni > 0 ? `${opoz.dni} dni` : "brak") : "—"}</td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
              </div>
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
          const wTys = nM > 10;                       // próg ujednolicony z eksportem PDF (pdfCashflow)
          const fs = nM > 20 ? 6 : nM > 16 ? 6.5 : nM > 12 ? 7.5 : nM > 8 ? 8.5 : 9.5;
          const pad = nM > 16 ? "4px 2px" : nM > 12 ? "5px 3px" : "6px 5px";
          const fmtZ = (n) => {
            if (!n) return "";
            if (wTys) return String(Math.round(n / 1000)); // w tysiącach, bez separatora (nie łamie w wąskich kolumnach)
            return Math.round(n).toLocaleString("pl-PL");
          };
          const fmtMY = (iso) => { if (!iso) return "—"; const p = String(iso).split("-"); return p.length >= 2 ? `${p[1]}.${p[0].slice(2)}` : (fmtPL(iso) || "—"); };
          const thO = { padding: pad, fontFamily: CR.mono, fontSize: fs, whiteSpace: "nowrap", background: CR.ink, color: "#fff" };
          const thM = { padding: pad, fontFamily: CR.mono, fontSize: fs, whiteSpace: "nowrap", background: CR.ink, color: CR.goldBright, textAlign: "center", lineHeight: 1.05 };
          const td = { padding: pad, borderBottom: `1px solid ${CR.line}`, borderRight: `1px solid ${CR.line}`, fontFamily: CR.mono, fontSize: fs, whiteSpace: "nowrap" };
          const tdZ = { ...td, whiteSpace: "normal", minWidth: 120, maxWidth: 170 };
          return (
            <div className="strona-cashflow">
            <BlokPDF tytul={`Harmonogram przepływów finansowych — sprzedaż${wTys ? " (kwoty w tys. zł)" : ""}`}>
              <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <table style={{ borderCollapse: "collapse", width: "auto" }}>
                <thead>
                  <tr>
                    <th style={{ ...thO, textAlign: "left" }}>Zadanie</th>
                    <th style={{ ...thO, textAlign: "right", color: CR.goldBright }}>Netto</th>
                    <th style={{ ...thO, textAlign: "center", color: CR.goldBright }}>Start</th>
                    <th style={{ ...thO, textAlign: "center", color: CR.goldBright }}>Koniec</th>
                    {miesiace.map((m) => { const [mm, yy] = String(m.etykieta).split("."); return <th key={m.klucz} style={thM}>{mm}<br />{yy}</th>; })}
                  </tr>
                </thead>
                <tbody>
                  {zadania.map((z, i) => (
                    <tr key={i}>
                      <td style={{ ...tdZ, textAlign: "left", color: "#26251F" }}>{z.nazwa}</td>
                      <td style={{ ...td, textAlign: "right", color: "#26251F" }}>{fmtZ(z.kwota)}</td>
                      <td style={{ ...td, textAlign: "center", color: CR.muted2 }}>{fmtMY(z.start)}</td>
                      <td style={{ ...td, textAlign: "center", color: CR.muted2 }}>{fmtMY(z.koniec)}</td>
                      {miesiace.map((m) => {
                        const v = z.komorki[m.klucz];
                        return <td key={m.klucz} style={{ ...td, textAlign: "right", background: v ? CR.band : "transparent", color: v ? "#26251F" : CR.muted2 }}>{v ? fmtZ(v) : "–"}</td>;
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
                    <td style={{ ...td, textAlign: "left", fontWeight: 800, background: CR.gold, color: CR.ink }}>Narastająco</td>
                    <td colSpan={3} style={{ ...td, background: CR.gold }}></td>
                    {miesiace.map((m) => <td key={m.klucz} style={{ ...td, textAlign: "right", fontWeight: 700, background: CR.gold, color: CR.ink }}>{fmtZ(sumaNaras[m.klucz])}</td>)}
                  </tr>
                </tfoot>
              </table>
              </div>
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

          let fotoNr = 0;
          const naglowek = <div style={{ marginBottom: 4, width: "100%" }}><Overline tytul="Dokumentacja fotograficzna" /></div>;

          // Strona fotograficzna: kontener flex w pionie wypełniający wysokość druku.
          // pierwszaZNaglowkiem = trochę niższy, bo dzieli miejsce z nagłówkiem sekcji.
          const stronaFoto = (zdj, key, zNaglowkiem) => (
            <div key={key} className={`foto-strona foto-n${zdj.length}${zNaglowkiem ? "" : " foto-strona-break"}`}
              style={{ display: "flex", flexDirection: "column", gap: 12, justifyContent: "center", alignItems: "center", height: 900, marginBottom: 8 }}>
              {zNaglowkiem && naglowek}
              {zdj.map((z, k) => {
                const nr = ++fotoNr;
                return (
                <figure key={k} className="foto-fig" style={{ margin: 0, flex: "1 1 0", minHeight: 0, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <img src={z.dataUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain", borderRadius: 4, display: "block" }} />
                  <figcaption style={{ marginTop: 6, textAlign: "center", flexShrink: 0, alignSelf: "center" }}>
                    <span style={{ fontFamily: CR.mono, fontSize: 9.5, color: CR.goldDeep, letterSpacing: "0.08em" }}>FOT. {String(nr).padStart(2, "0")}</span>
                    {z.opis && <span style={{ fontWeight: 700, color: "#26251F", marginLeft: 8, fontSize: 12.5 }}>{z.opis}</span>}
                  </figcaption>
                </figure>
                );
              })}
            </div>
          );

          return (
            <div style={{ marginTop: 20 }} className="foto-sekcja">
              {strony.map((zdj, idx) => stronaFoto(zdj, `s${idx}`, idx === 0))}
            </div>
          );
        })()}
        </div>{/* /pdf-content */}
      </div>
    </div>
  );
}

/* ---------- Komponenty pomocnicze ---------------------------------------- */
function Sekcja({ tytul, children }) {
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 16 }}>
        <div style={{ fontFamily: C.mono, fontSize: 12, letterSpacing: "0.13em", textTransform: "uppercase", color: C.zoltyDeep, whiteSpace: "nowrap" }}>
          <span style={{ color: C.zolty, fontWeight: 700 }}>/ </span>{tytul}
        </div>
        <div style={{ flex: 1, height: 1, background: C.linia, marginBottom: 4 }} />
      </div>
      {children}
    </section>
  );
}
function Pole({ label, children }) {
  return (<div style={{ marginBottom: 12 }}><label style={lbl}>{label}</label>{children}</div>);
}
function BlokPDF({ tytul, idx, children }) {
  return (
    <div className="blokpdf" style={{ marginTop: 26 }}>
      <Overline tytul={tytul} idx={idx} />
      <div style={{ padding: "2px 0" }}>{children}</div>
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
const secTitle = { display: "inline-block", fontFamily: C.mono, fontWeight: 400, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.13em", color: C.zoltyDeep, marginBottom: 14 };
const lbl = { display: "block", fontFamily: C.mono, fontSize: 9.5, fontWeight: 400, textTransform: "uppercase", letterSpacing: "0.12em", color: C.szary, marginBottom: 5 };
const inp = { width: "100%", padding: "9px 11px", border: `1px solid #C9C2B2`, borderRadius: 5, fontSize: 14, boxSizing: "border-box", background: "#FCFBF8", fontFamily: "inherit" };
const ta = { ...inp, minHeight: 84, resize: "vertical" };
const taBig = { ...inp, minHeight: 120, resize: "vertical" };
const grid3 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 };
const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 };
const btnPrimary = { background: C.zolty, color: C.czarny, border: "none", padding: "11px 22px", borderRadius: 6, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const btnGhost = { background: "transparent", color: C.czarny, border: `1.5px solid ${C.czarny}`, padding: "10px 18px", borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const btnGhostDark = { background: "transparent", color: C.bialy, border: `1.5px solid ${C.bialy}`, padding: "8px 16px", borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
const miniBtn = { background: C.bialy, border: `1px solid ${C.linia}`, borderRadius: 4, padding: "5px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
// Plakietka wstrzymanej inwestycji — spójna w koordynacji i „Kto co prowadzi".
const odznakaWstrzymana = { fontSize: 10.5, fontWeight: 700, color: "#B9791A", background: "#FBF0DC", padding: "1px 6px", borderRadius: 4, marginLeft: 6, verticalAlign: "middle" };
const pPDF = { margin: "2px 0", fontSize: 12.5 };
const thHarm = { background: C.czarny, color: "#FFFFFF", fontFamily: C.mono, fontSize: 8.5, fontWeight: 400, letterSpacing: "0.05em", textTransform: "uppercase", padding: "8px 6px", textAlign: "center" };
const tdHarm = { padding: "3px 6px", border: `1px solid ${C.linia}`, textAlign: "center" };
const cellInp = { border: "none", background: "transparent", fontSize: 13, fontFamily: "inherit", padding: "4px 2px", width: "100%", boxSizing: "border-box" };
const thHarmPdf = { background: C.czarny, color: C.zolty, fontSize: 9.5, fontWeight: 700, padding: "5px 4px", textAlign: "center", border: `1px solid ${C.grafit}` };
const tdHarmPdf = { padding: "4px", border: `1px solid ${C.linia}`, textAlign: "center", fontSize: 10.5 };
const thArch = { color: C.zolty, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, padding: "12px 14px", textAlign: "center" };
// Nagłówek tabeli admina — mono, dolna kreska w kolorze atramentu (jak .atbl th w mockupie).
const thAdm = { fontFamily: C.mono, fontSize: 9.5, fontWeight: 400, letterSpacing: "0.1em", textTransform: "uppercase", color: C.szary, textAlign: "left", padding: "10px 12px", borderBottom: `2px solid ${C.czarny}` };
const tdArch = { padding: "12px 14px", color: C.czarny, verticalAlign: "middle" };

const globalCSS = `
  * { box-sizing: border-box; }
  select:focus, input:focus, textarea:focus { outline: 2px solid ${C.zolty}; outline-offset: 0; border-color: ${C.zolty}; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  @media screen and (max-width: 640px) {
    footer > div { flex-direction: column; align-items: stretch !important; }
    footer button { width: 100%; }
    /* Dolny pasek akcji formularza układa się w kolumnę (przyciski pełnej szerokości),
       więc jest znacznie wyższy niż na desktopie. Rezerwujemy więcej miejsca na dole
       formularza, aby ostatnia karta nie chowała się pod przyklejonym paskiem. */
    .ekran-formularz { padding-bottom: 260px !important; }
    /* Szerokie tabele na telefonie: własne poziome przewijanie zamiast rozpychania strony.
       Tylko ekran (screen) i wąski — laptop oraz druk PDF nietknięte.
       display:block daje przewijanie; width:max-content wymusza, by tabela nie ściskała
       kolumn poniżej ich naturalnej szerokości (dzięki temu pojawia się pasek, a nie obcięcie). */
    table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; width: max-content; max-width: 100%; }
    /* Tabele, które MAJĄ już własny kontener przewijania (np. harmonogram) — nie nakładaj
       drugiego mechanizmu, bo zagnieżdżone przewijania blokują dojazd do końca. */
    .tabela-scroll-own { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tabela-scroll-own table { display: table; width: 100%; }
    /* Wiersz raportu w archiwum: na telefonie przyciski akcji dostają pełny wiersz
       i zawijają się od lewej, żeby „Usuń" nie wychodził poza kartę. */
    .arow-act { width: 100%; justify-content: flex-start !important; }
  }
`;
const printCSS = `
  /* Granica między stronami fotograficznymi w podglądzie na ekranie (nie w druku) */
  @media screen {
    .foto-strona-break { border-top: 2px dashed #ccc; padding-top: 18px; margin-top: 10px; }
  }
  /* Podgląd raportu na telefonie — bez tego szeroki harmonogram (i cashflow)
     rozpychał stronę i był obcinany przy prawej krawędzi ekranu.
     1) Zmniejszamy ogromny (56px) padding kartki, żeby treść miała więcej miejsca.
     2) Szerokie tabele dostają WŁASNE poziome przewijanie zamiast obcięcia —
        display:block + width:max-content zachowuje naturalne szerokości kolumn
        (daty się nie łamią), a max-width:100% + overflow-x:auto daje pasek.
     Dotyczy tylko ekranu telefonu — druk PDF (@media print) nietknięty. */
  @media screen and (max-width: 640px) {
    /* Okładka „magazynowa": grafika bleeduje (padding 0), padding jest na .cover-body. */
    .pdf-cover { padding: 0 !important; }
    .pdf-cover .cover-body { padding: 4px 18px 26px !important; }
    .pdf-cover .cover-bar { padding: 18px 18px !important; }
    .pdf-content { padding: 6px 18px 30px !important; }
    /* Okładka: skalujemy wielkie napisy, żeby nie rozpychały iPhone'a. */
    .pdf-cover .cover-num { font-size: 64px !important; }
    .pdf-cover .cover-proj { font-size: 26px !important; }
    .pdf-cover .cover-daty { gap: 10px !important; row-gap: 14px !important; }
    .pdf-page table {
      display: block;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      width: max-content;
      max-width: 100%;
    }
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
    .cover-foto { max-height: 150mm !important; width: 100% !important; object-fit: cover !important; }
  }
`;




