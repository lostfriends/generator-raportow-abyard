#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   JEDNORAZOWY SKRYPT: kompresja istniejących zdjęć w Supabase Storage.

   PO CO:
   Przez pewien czas do Storage trafiały ORYGINAŁY zdjęć (np. 4000×3000 px,
   3–4 MB), bo kompresja w generatorze dotyczyła tylko podglądu. Przez to baza
   spuchła, a raporty PDF (osadzające pliki 1:1) ważyły dziesiątki MB. Kod
   generatora już to naprawia dla NOWYCH zdjęć — ten skrypt przepakowuje te,
   które JUŻ leżą w Storage.

   CO ROBI:
   - przechodzi po wierszach tabeli `raporty` i zbiera ścieżki plików
     (zdjecia[].url, grafika_url, harmonogram_urls[]),
   - każdy plik pobiera, skaluje do rozdzielczości druku i koduje JPEG,
   - NADPISUJE ten sam obiekt w buckecie (ta sama ścieżka → publiczne URL-e w
     bazie pozostają ważne, NIE ruszamy wierszy w tabeli),
   - jest idempotentny: pomija pliki już małe / gdy nie ma realnego zysku
     (dzięki czemu można go puścić wielokrotnie bez utraty jakości),
   - domyślnie DRY-RUN (nic nie zapisuje) — realny zapis dopiero z flagą --apply.

   WYMAGANIA:
     npm install sharp            # @supabase/supabase-js jest już w zależnościach
   Klucz service_role (omija RLS, potrzebny do nadpisania cudzych obiektów) —
   podawany przez zmienną środowiskową, NIGDY nie commitujemy go do repo:
     export SUPABASE_SERVICE_ROLE_KEY="...."   # z panelu Supabase → Settings → API

   URUCHOMIENIE:
     node scripts/skompresuj-storage.mjs            # podgląd (dry-run) — pokaże plan i oszczędności
     node scripts/skompresuj-storage.mjs --apply    # faktyczna kompresja i nadpisanie
     node scripts/skompresuj-storage.mjs --apply --tylko=SKOWRONIA   # tylko ścieżki zawierające dany fragment
--------------------------------------------------------------------------- */

import { createClient } from "@supabase/supabase-js";

// sharp jest opcjonalną (dev/maintenance) zależnością — jasny komunikat, jeśli brak.
let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error("Brak modułu 'sharp'. Zainstaluj: npm install sharp");
  process.exit(1);
}

// --- Konfiguracja (zgodna z src/supabase.js) ---
const SUPABASE_URL = process.env.SUPABASE_URL || "https://fkhdahzreannrunlsphr.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "raporty-zdjecia";

if (!SERVICE_KEY) {
  console.error("Brak SUPABASE_SERVICE_ROLE_KEY w środowisku.");
  console.error('Ustaw:  export SUPABASE_SERVICE_ROLE_KEY="..."  (panel Supabase → Settings → API → service_role)');
  process.exit(1);
}

// --- Argumenty ---
const APPLY = process.argv.includes("--apply");
const tylkoArg = process.argv.find((a) => a.startsWith("--tylko="));
const TYLKO = tylkoArg ? tylkoArg.slice("--tylko=".length).toLowerCase() : null;

// Docelowe parametry wg rodzaju pliku (rozpoznawany po segmencie ścieżki).
// Wartości spójne z generatorem: zdjęcia lekko, okładka (hero) łagodniej.
function parametryDla(sciezka) {
  if (sciezka.includes("/grafika/") || sciezka.includes("/grafika")) return { max: 2600, jakosc: 88, typ: "okładka" };
  if (sciezka.includes("/harmonogram")) return { max: 2000, jakosc: 85, typ: "harmonogram" };
  if (sciezka.includes("/zdjecia")) return { max: 1600, jakosc: 80, typ: "zdjęcie" };
  return { max: 1800, jakosc: 82, typ: "inny" };
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Publiczny URL -> ścieżka w buckecie (jak sciezkaZUrl w src/supabase.js).
function sciezkaZUrl(url) {
  if (!url || typeof url !== "string") return null;
  const znacznik = `/object/public/${BUCKET}/`;
  const i = url.indexOf(znacznik);
  if (i === -1) return null;
  try { return decodeURIComponent(url.slice(i + znacznik.length)); }
  catch { return url.slice(i + znacznik.length); }
}

const kb = (b) => (b / 1024).toFixed(0) + " KB";
const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

// 1) Zbierz wszystkie ścieżki plików z tabeli raporty (z paginacją).
async function zbierzSciezki() {
  const zbior = new Set();
  const STRONA = 500;
  for (let od = 0; ; od += STRONA) {
    const { data, error } = await supabase
      .from("raporty")
      .select("id, zdjecia, grafika_url, harmonogram_urls")
      .range(od, od + STRONA - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
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
    if (data.length < STRONA) break;
  }
  return [...zbior];
}

// 2) Przetwórz pojedynczy plik. Zwraca { status, przed, po }.
async function przetworz(sciezka) {
  const { max, jakosc, typ } = parametryDla(sciezka);

  const { data: blob, error: eDl } = await supabase.storage.from(BUCKET).download(sciezka);
  if (eDl || !blob) return { status: "błąd pobierania", przed: 0, po: 0, typ };
  const wejscie = Buffer.from(await blob.arrayBuffer());

  let meta;
  try { meta = await sharp(wejscie).metadata(); }
  catch { return { status: "nie-obraz (pominięto)", przed: wejscie.length, po: wejscie.length, typ }; }

  const najwiekszy = Math.max(meta.width || 0, meta.height || 0);
  const juzMaly = najwiekszy <= max && wejscie.length < 300 * 1024;
  if (juzMaly) return { status: "już mały (pomijam)", przed: wejscie.length, po: wejscie.length, typ };

  // .rotate() bez argumentu = auto-orientacja wg EXIF (inaczej telefonowe zdjęcia
  // po zdjęciu EXIF-a bywają obrócone). fit:inside + withoutEnlargement = nie powiększaj.
  let wyjscie;
  try {
    wyjscie = await sharp(wejscie)
      .rotate()
      .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: jakosc, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    return { status: "błąd kompresji: " + e.message, przed: wejscie.length, po: wejscie.length, typ };
  }

  // Nie nadpisuj, jeśli nie ma realnego zysku (chroni przed degradacją przy powtórce).
  if (wyjscie.length >= wejscie.length * 0.9) {
    return { status: "brak zysku (pomijam)", przed: wejscie.length, po: wejscie.length, typ };
  }

  if (!APPLY) return { status: "DO KOMPRESJI (dry-run)", przed: wejscie.length, po: wyjscie.length, typ };

  const { error: eUp } = await supabase.storage.from(BUCKET).upload(sciezka, wyjscie, {
    contentType: "image/jpeg",
    upsert: true,          // nadpisz TEN SAM obiekt — publiczne URL-e się nie zmieniają
    cacheControl: "3600",
  });
  if (eUp) return { status: "błąd zapisu: " + eUp.message, przed: wejscie.length, po: wyjscie.length, typ };
  return { status: "skompresowano", przed: wejscie.length, po: wyjscie.length, typ };
}

// --- Main ---
console.log(`\n== Kompresja Storage (${BUCKET}) ==`);
console.log(APPLY ? "TRYB: ZAPIS (--apply)" : "TRYB: DRY-RUN (bez zapisu; dodaj --apply, by nadpisać)");
if (TYLKO) console.log(`Filtr: ścieżki zawierające \"${TYLKO}\"`);

let sciezki = await zbierzSciezki();
if (TYLKO) sciezki = sciezki.filter((s) => s.toLowerCase().includes(TYLKO));
console.log(`Znaleziono plików do sprawdzenia: ${sciezki.length}\n`);

let sumPrzed = 0, sumPo = 0, zmienione = 0, pominiete = 0, bledy = 0;
for (let i = 0; i < sciezki.length; i++) {
  const s = sciezki[i];
  const r = await przetworz(s);
  sumPrzed += r.przed;
  sumPo += r.po;
  const zmiana = r.przed && r.po < r.przed ? `  ${kb(r.przed)} → ${kb(r.po)}` : "";
  const flaga = r.status.startsWith("błąd") ? "✗" : (r.status.includes("pomijam") || r.status.includes("pominięto") ? "·" : "✓");
  if (flaga === "✓") zmienione++; else if (flaga === "·") pominiete++; else bledy++;
  console.log(`[${i + 1}/${sciezki.length}] ${flaga} ${r.typ.padEnd(11)} ${r.status}${zmiana}  ${s}`);
}

console.log("\n== Podsumowanie ==");
console.log(`Plików:            ${sciezki.length}`);
console.log(`Do kompresji / skompresowano: ${zmienione}`);
console.log(`Pominięto (już OK):           ${pominiete}`);
console.log(`Błędy:                        ${bledy}`);
console.log(`Rozmiar przed:     ${mb(sumPrzed)}`);
console.log(`Rozmiar po:        ${mb(sumPo)}`);
console.log(`Oszczędność:       ${mb(sumPrzed - sumPo)}  (${sumPrzed ? Math.round((1 - sumPo / sumPrzed) * 100) : 0}%)`);
if (!APPLY) console.log("\n(To był dry-run. Uruchom ponownie z --apply, aby faktycznie nadpisać pliki.)");
