/* ============================================================================
   MINIMALNY GENERATOR .XLSX (bez zależności zewnętrznych)
   ----------------------------------------------------------------------------
   Buduje poprawny plik OOXML SpreadsheetML (.xlsx) — ZIP (metoda "store", bez
   kompresji) + zestaw części XML. Powstał, aby eksport harmonogramu i cashflow
   „dla inwestora" nie wymagał ciężkiej biblioteki (SheetJS/exceljs ~1 MB) i był
   spójny wizualnie z marką Abyard (żółty/czerń), a plik dało się edytować i
   liczyć w Excelu/Google Sheets.

   Kod jest czysto obliczeniowy (Uint8Array, TextEncoder) — działa tak samo w
   przeglądarce i w Node (dzięki temu mamy test w scripts/test-xlsx.mjs).
   Pobranie pliku (Blob/URL) jest wydzielone i uruchamiane tylko w przeglądarce.

   API:
     zbudujXlsx(arkusze) -> Uint8Array           // gotowy bajtowy .xlsx
     pobierzXlsx(arkusze, nazwa)                  // wywołuje pobranie w przeglądarce

   Model danych arkusza:
     {
       nazwa: "Harmonogram",
       kolumny: [{ szer: 6 }, { szer: 42 }, ...],     // szerokości kolumn (znaki)
       zamrozenie: { wiersze: 1, kolumny: 4 },        // opcjonalne „freeze panes"
       wiersze: [
         [ komorka, komorka, ... ],                   // wiersz = tablica komórek
       ],
     }

   Komórka:
     { v: wartość, t: 's'|'n'|'d', s: styl }
       t='s' tekst | t='n' liczba | t='d' data (v = "YYYY-MM-DD")
       s = indeks stylu (patrz STYLE poniżej); pominięty => 0 (domyślny)
     Pusta komórka: null/undefined (bez ramki) albo { s } (styl bez wartości).
   ========================================================================== */

// Wygodne stałe indeksów stylów zdefiniowanych w styles.xml (patrz STYLES_XML).
export const STYLE = {
  DOMYSLNY: 0,
  NAGL_CIEMNY: 1,   // czarne tło, żółty pogrubiony tekst, wyśrodkowany (nagłówek)
  NAGL_MIES: 2,     // ciemnoszare tło, biały pogrubiony tekst (nagłówki miesięcy)
  TEKST: 3,         // zwykły tekst z ramką, do lewej
  TEKST_POGR: 4,    // pogrubiony tekst z ramką, do lewej
  LICZBA_ZL: 5,     // liczba „# ##0 zł", do prawej
  LICZBA: 6,        // liczba „# ##0", do prawej
  LICZBA_ZOLTA: 7,  // liczba na jasnożółtym tle (komórka cashflow z kwotą)
  DATA: 8,          // data dd.mm.yyyy, wyśrodkowana
  PROCENT: 9,       // liczba „0%", wyśrodkowana
  TEKST_SZARY: 10,  // wyszarzony, wyśrodkowany („—", puste daty)
  STOPKA_TEKST: 11, // pogrubiony tekst, szare tło (wiersz „RAZEM")
  STOPKA_ZL: 12,    // pogrubiona liczba zł, szare tło
  STOPKA_LICZBA: 13,// pogrubiona liczba, szare tło
  NARAST_TEKST: 14, // pogrubiony tekst, żółte tło (wiersz „Narastająco")
  NARAST_LICZBA: 15,// pogrubiona liczba, żółte tło
  TYTUL: 16,        // duży pogrubiony tytuł (bez ramki)
  PODPIS: 17,       // wyszarzony podpis (bez ramki)
  TEKST_SRODEK: 18, // zwykły tekst z ramką, wyśrodkowany
};

const enc = new TextEncoder();

// ---- XML: eskejpowanie -------------------------------------------------------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

// ---- Adres komórki (1 -> A, 27 -> AA) ---------------------------------------
function kolLitera(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Adres komórki z 1-based (kolumna, wiersz) -> "A1". Do budowania scaleń w kodzie
// mapującym dane (żeby nie powielać logiki liter kolumn).
export function adres(kol, wiersz) {
  return `${kolLitera(kol)}${wiersz}`;
}

// ---- Data ISO -> numer seryjny Excela (dni od 1899-12-30, UTC) --------------
function dataSerial(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

// ---- Nazwa arkusza: limit 31 znaków, bez znaków zabronionych ----------------
function nazwaArkusza(s, i) {
  let n = String(s || `Arkusz${i + 1}`).replace(/[\[\]\:\*\?\/\\]/g, " ").trim().slice(0, 31);
  return n || `Arkusz${i + 1}`;
}

/* ---------------------------------------------------------------------------
   Statyczne części pakietu
--------------------------------------------------------------------------- */
const RELS_ROOT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

// styles.xml — pełna paleta stylów (kolejność xf = indeksy w STYLE powyżej).
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="4">` +
    `<numFmt numFmtId="164" formatCode="#,##0&quot; zł&quot;"/>` +
    `<numFmt numFmtId="165" formatCode="dd\\.mm\\.yyyy"/>` +
    `<numFmt numFmtId="166" formatCode="0&quot;%&quot;"/>` +
    `<numFmt numFmtId="167" formatCode="#,##0"/>` +
  `</numFmts>` +
  `<fonts count="6">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="15"/><name val="Calibri"/></font>` +
    `<font><sz val="11"/><color rgb="FF6E6A62"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFF2A900"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="7">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF0F0F0E"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF2A900"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6DF"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF3F0E8"/></patternFill></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF3A3A3A"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border>` +
      `<left style="thin"><color rgb="FFD9D6CE"/></left>` +
      `<right style="thin"><color rgb="FFD9D6CE"/></right>` +
      `<top style="thin"><color rgb="FFD9D6CE"/></top>` +
      `<bottom style="thin"><color rgb="FFD9D6CE"/></bottom>` +
      `<diagonal/>` +
    `</border>` +
  `</borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="19">` +
    // 0 domyślny
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    // 1 nagłówek ciemny (żółty tekst na czerni)
    `<xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    // 2 nagłówek miesięcy (biały na ciemnoszarym)
    `<xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
    // 3 tekst
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
    // 4 tekst pogrubiony
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
    // 5 liczba zł
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 6 liczba
    `<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 7 liczba na jasnożółtym tle
    `<xf numFmtId="167" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 8 data
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
    // 9 procent
    `<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
    // 10 tekst szary wyśrodkowany
    `<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
    // 11 stopka tekst
    `<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +
    // 12 stopka zł
    `<xf numFmtId="164" fontId="1" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 13 stopka liczba
    `<xf numFmtId="167" fontId="1" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 14 narastająco tekst (żółte tło)
    `<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +
    // 15 narastająco liczba (żółte tło)
    `<xf numFmtId="167" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    // 16 tytuł
    `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +
    // 17 podpis
    `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
    // 18 tekst wyśrodkowany
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/* ---------------------------------------------------------------------------
   Generowanie XML arkusza
--------------------------------------------------------------------------- */
function komorkaXml(kom, ref) {
  if (kom == null) return "";
  const s = kom.s ? ` s="${kom.s}"` : "";
  // komórka tylko ze stylem (np. pusta z ramką)
  if (kom.v == null || kom.v === "") return `<c r="${ref}"${s}/>`;

  if (kom.t === "s") {
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(kom.v)}</t></is></c>`;
  }
  if (kom.t === "d") {
    const ser = dataSerial(kom.v);
    if (ser == null) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${ser}</v></c>`;
  }
  // liczba (domyślnie)
  const n = Number(kom.v);
  if (!isFinite(n)) return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s}><v>${n}</v></c>`;
}

function arkuszXml(ark) {
  const kolumny = ark.kolumny || [];
  const wiersze = ark.wiersze || [];

  const cols = kolumny.length
    ? `<cols>` + kolumny.map((c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.szer || 12}" customWidth="1"/>`
      ).join("") + `</cols>`
    : "";

  const zam = ark.zamrozenie;
  let sheetViews = `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  if (zam && (zam.wiersze || zam.kolumny)) {
    const xs = zam.kolumny || 0, ys = zam.wiersze || 0;
    const topLeft = `${kolLitera(xs + 1)}${ys + 1}`;
    const aktywny = xs && ys ? "bottomRight" : xs ? "topRight" : "bottomLeft";
    sheetViews =
      `<sheetViews><sheetView workbookViewId="0">` +
      `<pane${xs ? ` xSplit="${xs}"` : ""}${ys ? ` ySplit="${ys}"` : ""} topLeftCell="${topLeft}" activePane="${aktywny}" state="frozen"/>` +
      `</sheetView></sheetViews>`;
  }

  const dataXml = wiersze.map((w, ri) => {
    const komorki = (w || []).map((kom, ci) =>
      komorkaXml(kom, `${kolLitera(ci + 1)}${ri + 1}`)
    ).join("");
    return `<row r="${ri + 1}">${komorki}</row>`;
  }).join("");

  const merges = (ark.scalenia && ark.scalenia.length)
    ? `<mergeCells count="${ark.scalenia.length}">` +
      ark.scalenia.map((r) => `<mergeCell ref="${escAttr(r)}"/>`).join("") +
      `</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    sheetViews +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    cols +
    `<sheetData>${dataXml}</sheetData>` +
    merges +
    `</worksheet>`;
}

/* ---------------------------------------------------------------------------
   ZIP (metoda „store", bez kompresji) + CRC32
--------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Pakuje listę { nazwa, dane:Uint8Array } w archiwum ZIP (store) -> Uint8Array.
function zip(pliki) {
  const enc2 = new TextEncoder();
  const lokalne = [];
  const centralne = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const p of pliki) {
    const nazwaBytes = enc2.encode(p.nazwa);
    const crc = crc32(p.dane);
    const rozmiar = p.dane.length;

    // Lokalny nagłówek (flaga 0x0800 = nazwa w UTF-8)
    const lh = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(rozmiar), ...u32(rozmiar),
      ...u16(nazwaBytes.length), ...u16(0),
    ];
    lokalne.push(new Uint8Array(lh), nazwaBytes, p.dane);

    // Nagłówek katalogu centralnego
    const ch = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(rozmiar), ...u32(rozmiar),
      ...u16(nazwaBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ];
    centralne.push(new Uint8Array(ch), nazwaBytes);

    offset += lh.length + nazwaBytes.length + rozmiar;
  }

  const cdStart = offset;
  const cdBytes = centralne.reduce((s, a) => s + a.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(pliki.length), ...u16(pliki.length),
    ...u32(cdBytes), ...u32(cdStart), ...u16(0),
  ]);

  const wszystko = [...lokalne, ...centralne, eocd];
  const total = wszystko.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let poz = 0;
  for (const a of wszystko) { out.set(a, poz); poz += a.length; }
  return out;
}

/* ---------------------------------------------------------------------------
   API publiczne
--------------------------------------------------------------------------- */
// Buduje kompletny plik .xlsx z listy arkuszy -> Uint8Array.
export function zbudujXlsx(arkusze) {
  const listy = (arkusze || []).map((a, i) => ({ ...a, nazwa: nazwaArkusza(a.nazwa, i) }));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    listy.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join("") +
    `</Types>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    listy.map((a, i) => `<sheet name="${escAttr(a.nazwa)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;

  const stylesRid = listy.length + 1;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    listy.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join("") +
    `<Relationship Id="rId${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const pliki = [
    { nazwa: "[Content_Types].xml", dane: enc.encode(contentTypes) },
    { nazwa: "_rels/.rels", dane: enc.encode(RELS_ROOT) },
    { nazwa: "xl/workbook.xml", dane: enc.encode(workbook) },
    { nazwa: "xl/_rels/workbook.xml.rels", dane: enc.encode(workbookRels) },
    { nazwa: "xl/styles.xml", dane: enc.encode(STYLES_XML) },
    ...listy.map((a, i) => ({ nazwa: `xl/worksheets/sheet${i + 1}.xml`, dane: enc.encode(arkuszXml(a)) })),
  ];

  return zip(pliki);
}

// Buduje i pobiera plik .xlsx w przeglądarce.
export function pobierzXlsx(arkusze, nazwaPliku) {
  const bajty = zbudujXlsx(arkusze);
  const blob = new Blob([bajty], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${nazwaPliku}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
