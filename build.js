/* Build aplikacji "Generator raportów z budowy ABYARD".
   Krok 1: esbuild bunduje src/main.jsx (React + Supabase + cały kod) w jeden plik JS.
   Krok 2: owija bundle w kompletny index.html i zapisuje do katalogu dist/.
   Netlify publikuje zawartość dist/ (patrz netlify.toml).

   Uruchomienie lokalne: `npm run build`  ->  utworzy dist/index.html
*/
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const OUT_DIR = "dist";
const BUNDLE_TMP = path.join(OUT_DIR, "bundle.js");

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Krok 1 — kompilacja bundla (identyczne opcje jak w środowisku deweloperskim)
  await esbuild.build({
    entryPoints: ["src/main.jsx"],
    bundle: true,
    minify: true,
    format: "iife",
    loader: { ".jsx": "jsx" },
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: BUNDLE_TMP,
    logLevel: "info",
  });

  // Krok 1b — OSOBNY, samodzielny bundel biblioteki pdfmake (+ fonty Roboto).
  // Zostaje jako osobny plik dist/pdfmake-lib.js (NIE jest wklejany do index.html)
  // i jest ładowany leniwie dopiero przy pierwszym eksporcie PDF. Dzięki temu
  // główny bundel aplikacji jest lekki (~0,5 MB), a ciężka biblioteka schodzi
  // z sieci tylko wtedy, gdy użytkownik faktycznie generuje PDF.
  await esbuild.build({
    entryPoints: ["src/pdfmake-lib.js"],
    bundle: true,
    minify: true,
    format: "iife",
    // Fonty .ttf (Roboto Bold/BoldItalic/Black) wczytywane jako base64 —
    // dokładnie w formacie, jakiego oczekuje vfs pdfmake.
    loader: { ".ttf": "base64" },
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: path.join(OUT_DIR, "pdfmake-lib.js"),
    logLevel: "info",
  });

  // Krok 1c — fonty Roboto do PODGLĄDU (HTML). Kopiujemy TTF do dist/fonts/,
  // żeby podgląd renderował w tej samej czcionce co pobierany PDF (pdfmake).
  // Ładowane leniwie przez przeglądarkę dopiero, gdy podgląd użyje font-family
  // Roboto (nie obciąża ekranów logowania/formularza).
  const FONTS_DIR = path.join(OUT_DIR, "fonts");
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
  for (const f of fs.readdirSync("src/fonts").filter((n) => n.endsWith(".ttf"))) {
    fs.copyFileSync(path.join("src/fonts", f), path.join(FONTS_DIR, f));
  }

  const fontFace = `
<style>
@font-face{font-family:'Roboto';font-weight:400;font-style:normal;font-display:swap;src:url('fonts/Roboto-Regular.ttf') format('truetype');}
@font-face{font-family:'Roboto';font-weight:400;font-style:italic;font-display:swap;src:url('fonts/Roboto-Italic.ttf') format('truetype');}
@font-face{font-family:'Roboto';font-weight:700;font-style:normal;font-display:swap;src:url('fonts/Roboto-Bold.ttf') format('truetype');}
@font-face{font-family:'Roboto';font-weight:700;font-style:italic;font-display:swap;src:url('fonts/Roboto-BoldItalic.ttf') format('truetype');}
@font-face{font-family:'Roboto';font-weight:900;font-style:normal;font-display:swap;src:url('fonts/Roboto-Black.ttf') format('truetype');}
</style>`;

  // Krok 2 — owinięcie bundla w kompletny dokument HTML
  const bundle = fs.readFileSync(BUNDLE_TMP, "utf8");
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Generator raportów z budowy ABYARD</title>${fontFace}
</head>
<body>
<div id="root"></div>
<script>${bundle}</script>
</body>
</html>`;

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);
  // Sprzątanie pliku pośredniego, żeby w dist/ został tylko index.html
  fs.unlinkSync(BUNDLE_TMP);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`Zapisano ${OUT_DIR}/index.html, rozmiar: ${kb} KB`);
}

main().catch((err) => {
  console.error("Build nieudany:", err);
  process.exit(1);
});
