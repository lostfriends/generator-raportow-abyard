// ============================================================================
//  supabase.js  —  warstwa połączenia z bazą Supabase dla Generatora Raportów
// ----------------------------------------------------------------------------
//  Zawiera:
//   - klienta Supabase (createClient)
//   - listaAktywnychProjektow()  -> nazwy budów do datalisty (kontrola admina)
//   - pobierzKolejnyNumer(projekt) -> auto-numeracja z bazy (odpowiednik Flow 1)
//   - pobierzOstatniRaport(projekt) -> dane poprzedniego raportu do wczytania
//   - wgrajZdjecia(pliki, prefix) -> upload do Storage, zwraca [{url, opis}]
//   - wgrajPojedynczyObraz(plik, prefix) -> upload jednego obrazu, zwraca url
//   - zapiszRaport(form, projektId) -> insert do tabeli raporty
//   - mapFormNaWiersz / mapWierszNaForm -> tłumaczenie pól JSX <-> kolumny bazy
//
//  WAŻNE: klucz poniżej to PUBLISHABLE KEY (sb_publishable_...). Jest jawny i
//  bezpiecznie trafia do front-endu — ALE chroni go wyłącznie Row Level Security.
//  W trybie testowym polityki są otwarte (rola anon ma pełny dostęp). Przed
//  wpuszczeniem prawdziwych danych włącz logowanie i zamień polityki test_*.
// ============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://fkhdahzreannrunlsphr.supabase.co";
const SUPABASE_KEY = "sb_publishable_oCBaIHLyv0PTRn48lVQbGQ_SOw8vG7d";

// Nazwa bucketu na zdjęcia — musi być identyczna jak utworzony w panelu Storage.
const BUCKET = "raporty-zdjecia";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ===========================================================================
   AUTH: logowanie, rejestracja, sesja, rola
   =========================================================================== */

// Rejestracja (e-mail + hasło). Z potwierdzeniem e-mail włączonym w Supabase
// użytkownik dostaje link aktywacyjny i nie jest zalogowany od razu.
export async function zarejestruj(email, haslo) {
  const { data, error } = await supabase.auth.signUp({ email, password: haslo });
  if (error) throw error;
  return data;
}

// Logowanie.
export async function zaloguj(email, haslo) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: haslo });
  if (error) throw error;
  return data;
}

// Wylogowanie.
export async function wyloguj() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Reset hasła (wysyła e-mail z linkiem).
export async function resetHasla(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

// Bieżąca sesja (lub null).
export async function biezacaSesja() {
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

// Nasłuch zmian logowania/wylogowania. cb(session) wołane przy każdej zmianie.
export function naZmianeAuth(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data?.subscription?.unsubscribe?.();
}

// Profil bieżącego użytkownika (id, email, rola). null gdy niezalogowany.
export async function mojProfil() {
  const { data: u } = await supabase.auth.getUser();
  if (!u?.user) return null;
  const { data, error } = await supabase
    .from("uzytkownicy")
    .select("id, email, rola, imie_nazwisko")
    .eq("id", u.user.id)
    .maybeSingle();
  if (error) throw error;
  // Gdyby trigger nie zdążył — zwróć minimalny profil PM
  return data || { id: u.user.id, email: u.user.email, rola: "pm" };
}

/* ===========================================================================
   PRZYPISANIA I ROLE (panel admina)
   =========================================================================== */

// Lista wszystkich użytkowników (dla panelu admina).
export async function listaUzytkownikow() {
  const { data, error } = await supabase
    .from("uzytkownicy")
    .select("id, email, rola, imie_nazwisko, pojemnosc, inne_obowiazki")
    .order("imie_nazwisko", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

// Nazwa do wyświetlenia: imię i nazwisko, a gdy brak — e-mail (fallback).
export function nazwaOsoby(u) {
  if (!u) return "";
  return (u.imie_nazwisko && u.imie_nazwisko.trim()) ? u.imie_nazwisko : (u.email || "—");
}

// Słownik zakresów (kod, nazwa, punkty, kolejnosc) — posortowany.
export async function listaZakresow() {
  const { data, error } = await supabase
    .from("zakresy")
    .select("kod, nazwa, punkty, kolejnosc")
    .order("kolejnosc", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Ustaw zakres i/lub termin zakończenia inwestycji (admin).
export async function ustawKoordynacjeProjektu(projektId, pola) {
  const { error } = await supabase.from("projekty").update(pola).eq("id", projektId);
  if (error) throw error;
}

// Ustaw domyślną punktację danego zakresu — GLOBALNIE (słownik zakresów, admin).
// Wpływa na domyślne punkty wszystkich inwestycji tego zakresu (dopóki na
// przypisaniu nie wpisano wartości nadpisującej).
export async function ustawPunktyZakresu(kod, punkty) {
  const { error } = await supabase
    .from("zakresy")
    .update({ punkty: (punkty === "" || punkty == null) ? null : Number(punkty) })
    .eq("kod", kod);
  if (error) throw error;
}

// Ustaw punkty PM za daną inwestycję (na wierszu przypisania).
export async function ustawPunktyPrzypisania(przypisanieId, punkty) {
  const { error } = await supabase
    .from("przypisania")
    .update({ punkty: (punkty === "" || punkty == null) ? null : Number(punkty) })
    .eq("id", przypisanieId);
  if (error) throw error;
}

// Ustaw pojemność / inne obowiązki / imię i nazwisko PM (admin).
export async function ustawDanePM(uzytkownikId, pola) {
  const { error } = await supabase.from("uzytkownicy").update(pola).eq("id", uzytkownikId);
  if (error) throw error;
}

// Lista przypisań (uzytkownik <-> projekt). Zwraca surowe pary.
export async function listaPrzypisan() {
  const { data, error } = await supabase
    .from("przypisania")
    .select("id, uzytkownik, projekt_id, punkty");
  if (error) throw error;
  return data || [];
}

// Przypisz PM-a do budowy.
export async function dodajPrzypisanie(uzytkownik, projektId) {
  const { error } = await supabase
    .from("przypisania")
    .insert({ uzytkownik, projekt_id: projektId });
  if (error) throw error;
}

// Usuń przypisanie.
export async function usunPrzypisanie(id) {
  const { error } = await supabase.from("przypisania").delete().eq("id", id);
  if (error) throw error;
}

// Zmień rolę użytkownika (admin/pm).
export async function ustawRole(uzytkownikId, rola) {
  const { error } = await supabase
    .from("uzytkownicy")
    .update({ rola })
    .eq("id", uzytkownikId);
  if (error) throw error;
}

// Dodaj nową inwestycję (admin).
export async function dodajProjekt(nazwa) {
  const { data, error } = await supabase
    .from("projekty")
    .insert({ nazwa, aktywny: true })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Włącz/wyłącz inwestycję (admin) — wyłączona znika z listy wyboru.
export async function ustawAktywnoscProjektu(projektId, aktywny) {
  const { error } = await supabase
    .from("projekty")
    .update({ aktywny })
    .eq("id", projektId);
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
   PROJEKTY DLA BIEŻĄCEGO UŻYTKOWNIKA (lista wyboru przy tworzeniu raportu)
   - admin: wszystkie aktywne budowy
   - pm: tylko aktywne budowy, do których jest przypisany
--------------------------------------------------------------------------- */
export async function projektyDoWyboru(profil, przypisania) {
  const wszystkie = await listaAktywnychProjektow();
  if (profil?.rola === "admin") return wszystkie;
  const moje = new Set((przypisania || []).map((p) => p.projekt_id));
  return wszystkie.filter((p) => moje.has(p.id));
}

/* ---------------------------------------------------------------------------
   LISTA PROJEKTÓW
   Zwraca tablicę obiektów {id, nazwa} dla aktywnych budów.
   Źródło prawdy dla datalisty — administrator zarządza tym w tabeli projekty.
--------------------------------------------------------------------------- */
export async function listaAktywnychProjektow() {
  const { data, error } = await supabase
    .from("projekty")
    .select("id, nazwa, zakres, termin_zakonczenia, wstrzymana")
    .eq("aktywny", true)
    .order("nazwa", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Lista NIEAKTYWNYCH (zakończonych/zarchiwizowanych) inwestycji.
export async function listaNieaktywnychProjektow() {
  const { data, error } = await supabase
    .from("projekty")
    .select("id, nazwa, zakres, termin_zakonczenia, wstrzymana")
    .eq("aktywny", false)
    .order("nazwa", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Domyślne terminy zakończenia liczone z NAJNOWSZEGO raportu każdej inwestycji:
// najpóźniejsza data z harmonogramu (dowolna kolumna: koniec/rzecz/start),
// a gdy harmonogram pusty — pole zakonczenie_robot. Zwraca mapę { projekt_id: "YYYY-MM-DD" }.
export async function terminyZHarmonogramu() {
  const { data, error } = await supabase
    .from("raporty")
    .select("projekt_id, data_opracowania, zakonczenie_robot, harmonogram")
    .order("data_opracowania", { ascending: false });
  if (error) throw error;
  const mapa = {};
  for (const r of (data || [])) {
    if (mapa[r.projekt_id] !== undefined) continue; // mamy już najnowszy (sortowanie malejące)
    let najp = "";
    const h = Array.isArray(r.harmonogram) ? r.harmonogram : [];
    const zbierz = (w) => {
      for (const key of ["koniec", "rzecz", "start"]) {
        const v = w?.[key];
        if (v && v > najp) najp = v;
      }
      if (Array.isArray(w?.pod)) w.pod.forEach(zbierz);
    };
    h.forEach(zbierz);
    if (!najp && r.zakonczenie_robot) najp = r.zakonczenie_robot;
    mapa[r.projekt_id] = najp || null;
  }
  return mapa;
}

/* ---------------------------------------------------------------------------
   ID PROJEKTU PO NAZWIE
   Potrzebne przy zapisie raportu (raporty.projekt_id) i przy numeracji.
--------------------------------------------------------------------------- */
export async function idProjektuPoNazwie(nazwa) {
  const { data, error } = await supabase
    .from("projekty")
    .select("id")
    .eq("nazwa", nazwa)
    .maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
}

/* ---------------------------------------------------------------------------
   KOLEJNY NUMER RAPORTU  (odpowiednik logiki Flow 1)
   Pobiera najwyższy istniejący numer dla danego projektu i zwraca +1.
   Gdy brak raportów (pierwszy raport budowy) -> zwraca 1.
--------------------------------------------------------------------------- */
export async function pobierzKolejnyNumer(projektId) {
  if (!projektId) return 1;
  const { data, error } = await supabase
    .from("raporty")
    .select("numer")
    .eq("projekt_id", projektId)
    .order("numer", { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return 1;
  return (parseInt(data[0].numer, 10) || 0) + 1;
}

/* ---------------------------------------------------------------------------
   OSTATNI RAPORT PROJEKTU
   Zwraca pełny wiersz ostatniego raportu (do wczytania pól w formularzu),
   albo null gdy to pierwszy raport tej budowy.
--------------------------------------------------------------------------- */
export async function pobierzOstatniRaport(projektId) {
  if (!projektId) return null;
  const { data, error } = await supabase
    .from("raporty")
    .select("*")
    .eq("projekt_id", projektId)
    .order("numer", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
}

/* ---------------------------------------------------------------------------
   ARCHIWUM: LISTA WSZYSTKICH RAPORTÓW (lekka — bez zdjęć/grafik)
   Zwraca raporty z dołączoną nazwą budowy, posortowane: najnowsze na górze.
   Pola ciężkie (zdjecia, harmonogram, grafika) pomijamy — dociągamy dopiero
   przy otwarciu konkretnego raportu (pobierzRaportPoId).
--------------------------------------------------------------------------- */
export async function listaWszystkichRaportow() {
  const { data, error } = await supabase
    .from("raporty")
    .select(
      "id, numer, okres_od, okres_do, data_opracowania, opracowal, podsumowanie, adres, pnu, pnu_nie_dotyczy, zakonczenie_robot, harmonogram, utworzono, utworzony_przez, edycja_do, projekt_id, projekty(nazwa)"
    )
    .order("data_opracowania", { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    nazwaProjektu: r.projekty?.nazwa || "(nieznana budowa)",
  }));
}

/* ---------------------------------------------------------------------------
   ARCHIWUM: PEŁNY RAPORT PO ID (ze zdjęciami, harmonogramem, grafiką)
   Używane przy otwarciu podglądu konkretnego raportu.
--------------------------------------------------------------------------- */
export async function pobierzRaportPoId(id) {
  const { data, error } = await supabase
    .from("raporty")
    .select("*, projekty(nazwa)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------------------
   USUWANIE RAPORTU (tylko admin — pilnuje tego polityka RLS rap_admin_delete)
   Kolejność: najpierw pliki ze Storage (zdjęcia, grafika, harmonogramy),
   potem wiersz z tabeli. Jeśli usunięcie części plików się nie powiedzie,
   raport i tak kasujemy — osierocone pliki zgłaszamy w zwrotce.
--------------------------------------------------------------------------- */
// Publiczny URL -> ścieżka w buckecie (".../object/public/raporty-zdjecia/<ścieżka>")
function sciezkaZUrl(url) {
  if (!url || typeof url !== "string") return null;
  const znacznik = `/object/public/${BUCKET}/`;
  const i = url.indexOf(znacznik);
  if (i === -1) return null;
  // dekoduj %xx (np. %20), bo storage.remove oczekuje surowej ścieżki
  try { return decodeURIComponent(url.slice(i + znacznik.length)); }
  catch { return url.slice(i + znacznik.length); }
}

export async function usunRaport(id) {
  // 1. Pobierz raport z polami plikowymi
  const { data: r, error: e1 } = await supabase
    .from("raporty")
    .select("id, zdjecia, grafika_url, harmonogram_urls")
    .eq("id", id)
    .single();
  if (e1) throw e1;

  // 2. Zbierz wszystkie ścieżki plików
  const urle = [
    ...((r.zdjecia || []).map((z) => z?.url)),
    r.grafika_url,
    ...((r.harmonogram_urls || [])),
  ];
  const sciezki = urle.map(sciezkaZUrl).filter(Boolean);

  // 3. Usuń pliki ze Storage (jeśli są)
  let nieusuniete = 0;
  if (sciezki.length > 0) {
    const { error: e2 } = await supabase.storage.from(BUCKET).remove(sciezki);
    if (e2) {
      console.error("Storage remove:", e2);
      nieusuniete = sciezki.length; // nie przerywamy — raport i tak kasujemy
    }
  }

  // 4. Usuń wiersz raportu
  const { error: e3 } = await supabase.from("raporty").delete().eq("id", id);
  if (e3) throw e3;

  return { plikow: sciezki.length, nieusuniete };
}

/* ---------------------------------------------------------------------------
   ARCHIWUM: PRZEGLĄD ZBIORCZY BUDÓW
   Dla każdej budowy: liczba raportów, numer i data ostatniego, status z
   podsumowania ostatniego raportu. Liczone po stronie aplikacji z listy.
--------------------------------------------------------------------------- */
export function przegladBudow(raporty) {
  const mapa = new Map();
  for (const r of raporty) {
    const klucz = r.nazwaProjektu;
    if (!mapa.has(klucz)) {
      mapa.set(klucz, { nazwa: klucz, liczba: 0, ostatni: null });
    }
    const wpis = mapa.get(klucz);
    wpis.liczba += 1;
    // "ostatni" = raport z najpóźniejszą datą opracowania (a gdy brak daty — z najwyższym numerem)
    if (!wpis.ostatni || nowszy(r, wpis.ostatni)) wpis.ostatni = r;
  }
  return Array.from(mapa.values()).sort((a, b) =>
    a.nazwa.localeCompare(b.nazwa, "pl")
  );
}

// Czy raport a jest "nowszy" niż b — wg daty opracowania, a przy remisie/braku wg numeru
function nowszy(a, b) {
  const da = a.data_opracowania || "";
  const db = b.data_opracowania || "";
  if (da && db && da !== db) return da > db;
  if (da && !db) return true;
  if (!da && db) return false;
  return (a.numer || 0) > (b.numer || 0);
}

/* ---------------------------------------------------------------------------
   UPLOAD POJEDYNCZEGO OBRAZU (grafika inwestycji / obraz harmonogramu)
   plik: File. prefix: folder logiczny w buckecie (np. "OBOZOWA/nr5").
   Zwraca publiczny URL.
--------------------------------------------------------------------------- */
export async function wgrajPojedynczyObraz(plik, prefix = "ogolne") {
  const sciezka = `${prefix}/${Date.now()}_${bezpiecznaNazwa(plik.name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(sciezka, plik, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(sciezka);
  return data.publicUrl;
}

/* ---------------------------------------------------------------------------
   UPLOAD WIELU ZDJĘĆ (dokumentacja fotograficzna)
   pliki: tablica {file, opis}. Zwraca [{url, opis}].
--------------------------------------------------------------------------- */
export async function wgrajZdjecia(pliki, prefix = "zdjecia") {
  const wyniki = [];
  for (const { file, opis, pion } of pliki) {
    const url = await wgrajPojedynczyObraz(file, prefix);
    wyniki.push({ url, opis: opis || "", pion: !!pion });
  }
  return wyniki;
}

/* ---------------------------------------------------------------------------
   KONSERWACJA: kompresja istniejących obrazów w Storage (jednorazowo, z panelu
   admina). Przez pewien czas do bucketa trafiały ORYGINAŁY zdjęć (4000 px, kilka
   MB), bo kompresja dotyczyła tylko podglądu — tu przepakowujemy to, co już leży.
--------------------------------------------------------------------------- */
// Wszystkie ścieżki obrazów referowanych w tabeli raporty (bez duplikatów).
export async function listaObrazowStorage() {
  const { data, error } = await supabase
    .from("raporty")
    .select("zdjecia, grafika_url, harmonogram_urls");
  if (error) throw error;
  const zbior = new Set();
  for (const r of data || []) {
    const urle = [
      ...((r.zdjecia || []).map((z) => z?.url)),
      r.grafika_url,
      ...((r.harmonogram_urls || [])),
    ];
    for (const u of urle) {
      const s = sciezkaZUrl(u);
      if (s) zbior.add(s);
    }
  }
  return [...zbior];
}

// Pobierz obiekt z bucketa jako Blob (do rekompresji w przeglądarce).
export async function pobierzObiektStorage(sciezka) {
  const { data, error } = await supabase.storage.from(BUCKET).download(sciezka);
  if (error) throw error;
  return data; // Blob
}

// Nadpisz TEN SAM obiekt (upsert) — publiczne URL-e w bazie pozostają ważne.
export async function nadpiszObiektStorage(sciezka, plik) {
  const { error } = await supabase.storage.from(BUCKET).upload(sciezka, plik, {
    contentType: "image/jpeg",
    upsert: true,
    cacheControl: "3600",
  });
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
   ZAPIS RAPORTU
   form: stan formularza z aplikacji. projektId: uuid z tabeli projekty.
   Zwraca zapisany wiersz.
   UWAGA: zakłada, że zdjęcia/grafiki są już wgrane i form zawiera URL-e
   (zdjecia: [{url,opis}], grafika_url: string, harmonogram_urls: [url]).
--------------------------------------------------------------------------- */
export async function zapiszRaport(form, projektId) {
  const wiersz = mapFormNaWiersz(form, projektId);
  const { data, error } = await supabase
    .from("raporty")
    .insert(wiersz)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------------------
   AKTUALIZACJA RAPORTU (nadpisanie istniejącego wiersza po ID)
   Używane, gdy poprawiasz raport zapisany w tej samej sesji.
   Numer i projekt nie zmieniają się — nadpisujemy treść.
--------------------------------------------------------------------------- */
export async function aktualizujRaport(id, form, projektId) {
  const wiersz = mapFormNaWiersz(form, projektId);
  const { data, error } = await supabase
    .from("raporty")
    .update(wiersz)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* ---------------------------------------------------------------------------
   ODBLOKOWANIE EDYCJI RAPORTU PRZEZ ADMINA
   Ustawia (lub czyści) termin `edycja_do`. Dopóki jest w przyszłości, raport
   może edytować autor oraz PM przypisani do budowy (pilnuje tego polityka RLS
   rap_update_okno_edycji — patrz supabase/edycja_raportu.sql).
   doKiedy: ISO string (np. now()+24h) albo null (cofnięcie okna).
--------------------------------------------------------------------------- */
export async function ustawOknoEdycji(raportId, doKiedy) {
  const { error } = await supabase
    .from("raporty")
    .update({ edycja_do: doKiedy })
    .eq("id", raportId);
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
   MAPOWANIE: stan formularza (camelCase JSX)  ->  wiersz bazy (snake_case)
--------------------------------------------------------------------------- */
export function mapFormNaWiersz(form, projektId) {
  return {
    projekt_id: projektId,
    numer: parseInt(form.numer, 10) || 1,
    okres_od: pustyNaNull(form.okresOd),
    okres_do: pustyNaNull(form.okresDo),
    data_opracowania: pustyNaNull(form.dataOpracowania),
    adres: form.adres || null,
    tytul_zadania: form.tytulZadania || null,
    rozpoczecie: pustyNaNull(form.rozpoczecie),
    zakonczenie_robot: pustyNaNull(form.zakonczenieRobot),
    pnu: pustyNaNull(form.pnu),
    pnu_nie_dotyczy: !!form.pnuNieDotyczy,
    opracowal: form.opracowal || null,
    info_ogolne: form.infoOgolne || null,
    opoznienia: form.opoznienia || null,
    wykonawcy: form.wykonawcy || null,
    przetargi: form.przetargi || null,
    sprawy_budowy: form.sprawyBudowy || null,
    sprawy_inwestora: form.sprawyInwestora || null,
    plac_budowy: form.placBudowy || null,
    podsumowanie: form.podsumowanie || null,
    harmonogram: form.harmonogram || null,
    grafika_url: form.grafikaInwestycji?.url || form.grafika_url || null,
    harmonogram_urls: form.harmonogram_urls || [],
    zdjecia: form.zdjecia || [],
  };
}

/* ---------------------------------------------------------------------------
   MAPOWANIE: wiersz bazy (snake_case)  ->  stan formularza (camelCase JSX)
   Używane przy wczytaniu poprzedniego raportu.
   Zdjęcia z bazy mają {url,opis}; aplikacja w podglądzie używa pola dataUrl
   do <img src> — dlatego dataUrl ustawiamy = url (publiczny link działa tak samo).
--------------------------------------------------------------------------- */
// Douzupełnia puste prognozy (rzecz) datą umowy (koniec) — dla wierszy głównych
// i podpozycji. Naprawia stare raporty przy wczytaniu; zapisze się dopiero, gdy
// użytkownik zapisze raport. Nie nadpisuje istniejących prognoz.
function douzupelnijPrognozy(harmonogram) {
  if (!Array.isArray(harmonogram)) return harmonogram || null;
  return harmonogram.map((w) => {
    const nowy = { ...w };
    if (nowy.koniec && !nowy.rzecz) nowy.rzecz = nowy.koniec;
    if (Array.isArray(w.pod)) {
      nowy.pod = w.pod.map((p) => {
        const np = { ...p };
        if (np.koniec && !np.rzecz) np.rzecz = np.koniec;
        return np;
      });
    }
    return nowy;
  });
}

export function mapWierszNaForm(w) {
  return {
    projekt: "", // nadpisywane nazwą w aplikacji
    numer: String(w.numer ?? "1"),
    okresOd: w.okres_od || "",
    okresDo: w.okres_do || "",
    dataOpracowania: w.data_opracowania || "",
    adres: w.adres || "",
    tytulZadania: w.tytul_zadania || "",
    rozpoczecie: w.rozpoczecie || "",
    zakonczenieRobot: w.zakonczenie_robot || "",
    pnu: w.pnu || "",
    pnuNieDotyczy: !!w.pnu_nie_dotyczy,
    opracowal: w.opracowal || "",
    infoOgolne: w.info_ogolne || "",
    opoznienia: w.opoznienia || "",
    wykonawcy: w.wykonawcy || "",
    przetargi: w.przetargi || "",
    sprawyBudowy: w.sprawy_budowy || "",
    sprawyInwestora: w.sprawy_inwestora || "",
    placBudowy: w.plac_budowy || "",
    podsumowanie: w.podsumowanie || "",
    grafikaInwestycji: w.grafika_url ? { nazwa: "grafika", dataUrl: w.grafika_url, url: w.grafika_url } : null,
    harmonogram: douzupelnijPrognozy(w.harmonogram),
    harmonogram_urls: w.harmonogram_urls || [],
    harmonogramObrazy: (w.harmonogram_urls || []).map((url) => ({ nazwa: "harmonogram", dataUrl: url, url })),
    zdjecia: (w.zdjecia || []).map((z) => ({ nazwa: "zdjecie", dataUrl: z.url, url: z.url, opis: z.opis || "", pion: z.pion })),
  };
}

/* ---------------------------------------------------------------------------
   Pomocnicze
--------------------------------------------------------------------------- */
function pustyNaNull(v) {
  return v && v.trim() !== "" ? v : null;
}
// Mapa polskich znaków, które NFD nie rozkłada (ł, ż mają osobne kody Unicode).
const MAPA_PL = { "ł": "l", "Ł": "L", "ż": "z", "Ż": "Z", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D" };

// Normalizuje dowolny tekst na bezpieczny klucz Storage (ASCII, bez spacji i polskich znaków).
// Używane zarówno dla nazw plików, jak i dla ścieżek (prefixów) w buckecie.
export function bezpiecznyKlucz(tekst) {
  return (tekst || "plik")
    .replace(/[łŁżŻøØđĐ]/g, (z) => MAPA_PL[z] || z)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function bezpiecznaNazwa(nazwa) {
  // Storage nie lubi spacji i polskich znaków w ścieżce — normalizujemy.
  return bezpiecznyKlucz(nazwa) || "plik";
}

/* ===========================================================================
   UDOSTĘPNIANIE RAPORTÓW LINKIEM (dla inwestora, bez logowania)
   ---------------------------------------------------------------------------
   Tabela `udostepnienia` + funkcja RPC `raport_po_tokenie` (SECURITY DEFINER)
   — SQL do jednorazowego uruchomienia w Supabase: supabase/udostepnienia.sql.
   Link pokazuje ŻYWĄ wersję raportu (po edycji inwestor widzi stan aktualny).
   =========================================================================== */

// Losowy token linku: 32 znaki [A-Za-z0-9] z crypto — praktycznie nieodgadywalny.
function nowyToken() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => abc[b % abc.length]).join("");
}

// Tworzy nowy link do raportu. Zwraca wiersz udostępnienia (z tokenem).
export async function utworzUdostepnienie(raportId) {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("udostepnienia")
    .insert({ raport_id: raportId, token: nowyToken(), utworzyl: u?.user?.id || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Lista linków danego raportu (najnowsze pierwsze).
export async function listaUdostepnien(raportId) {
  const { data, error } = await supabase
    .from("udostepnienia")
    .select("*")
    .eq("raport_id", raportId)
    .order("utworzono", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Unieważnia link (zostaje w historii, ale przestaje działać).
export async function wylaczUdostepnienie(id) {
  const { error } = await supabase
    .from("udostepnienia")
    .update({ wylaczony: true })
    .eq("id", id);
  if (error) throw error;
}

// Publiczne pobranie raportu po tokenie (działa bez logowania — przez RPC).
// Zwraca wiersz raportu + pole projekt_nazwa, albo null gdy link nieaktywny.
export async function raportPoTokenie(token) {
  const { data, error } = await supabase.rpc("raport_po_tokenie", { tok: token });
  if (error) throw error;
  return data;
}
