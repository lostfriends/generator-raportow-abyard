// ============================================================================
//  pdfmake-lib.js — osobny bundel z biblioteką pdfmake (+ fonty Roboto).
// ----------------------------------------------------------------------------
//  Budowany do OSOBNEGO pliku dist/pdfmake-lib.js (nie wklejany do index.html)
//  i ładowany LENIWIE — dopiero przy pierwszym eksporcie PDF. Dzięki temu
//  główny bundel aplikacji jest lekki, a ciężka biblioteka (~2,3 MB) schodzi
//  z sieci tylko wtedy, gdy użytkownik faktycznie klika „Pobierz PDF".
//
//  Wystawia gotową instancję pod window.__pdfmakeLib (z podpiętym vfs fontów).
// ============================================================================
import pdfMake from "pdfmake/build/pdfmake";
import vfsFonts from "pdfmake/build/vfs_fonts";

// Domyślny vfs_fonts dostarcza Roboto w wagach Regular (400) i Medium (500).
// Medium jest za lekkie — pogrubienia w PDF wyglądały słabo („brak pogrubień"),
// bo pdfmake mapuje `bold` na Roboto-Medium. Dokładamy prawdziwe wagi:
//   • Bold (700)        — dla `bold: true` (mocne pogrubienia w treści i tabelach),
//   • Bold Italic (700) — dla pogrubienia + kursywy,
//   • Black (900)       — osobna rodzina „RobotoBlack" do nagłówków i tytułów,
//                         które w podglądzie HTML mają wagę 800.
// Fonty ładowane są przez esbuild jako base64 (loader ".ttf": "base64"),
// czyli dokładnie w formacie, jakiego oczekuje vfs pdfmake.
import RobotoBold from "./fonts/Roboto-Bold.ttf";
import RobotoBoldItalic from "./fonts/Roboto-BoldItalic.ttf";
import RobotoBlack from "./fonts/Roboto-Black.ttf";

const baseVfs =
  (vfsFonts && vfsFonts.pdfMake && vfsFonts.pdfMake.vfs) ||
  (vfsFonts && vfsFonts.vfs) ||
  pdfMake.vfs ||
  {};

pdfMake.vfs = {
  ...baseVfs,
  "Roboto-Bold.ttf": RobotoBold,
  "Roboto-BoldItalic.ttf": RobotoBoldItalic,
  "Roboto-Black.ttf": RobotoBlack,
};

// Mapowanie rodzin na konkretne pliki. `Roboto` używa teraz Bold (700) zamiast
// Medium; `RobotoBlack` to jednolita, bardzo ciężka rodzina do nagłówków.
pdfMake.fonts = {
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Bold.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-BoldItalic.ttf",
  },
  RobotoBlack: {
    normal: "Roboto-Black.ttf",
    bold: "Roboto-Black.ttf",
    italics: "Roboto-Black.ttf",
    bolditalics: "Roboto-Black.ttf",
  },
};

if (typeof window !== "undefined") window.__pdfmakeLib = pdfMake;
