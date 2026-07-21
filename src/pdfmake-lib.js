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

// vfs_fonts przypisuje tablicę fontów do module.exports.pdfMake.vfs (Roboto —
// obejmuje polskie znaki). Podpinamy ją pod instancję używaną do generowania.
pdfMake.vfs = (vfsFonts && vfsFonts.pdfMake && vfsFonts.pdfMake.vfs) || (vfsFonts && vfsFonts.vfs) || pdfMake.vfs;

if (typeof window !== "undefined") window.__pdfmakeLib = pdfMake;
