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

  // Krok 2 — owinięcie bundla w kompletny dokument HTML
  const bundle = fs.readFileSync(BUNDLE_TMP, "utf8");
  const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Generator raportów z budowy ABYARD</title>
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
