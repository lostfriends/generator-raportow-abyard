# Standardowe Procedury Operacyjne

**Zakres:** Procedura Opracowywania Raportów Zdjęciowych z budów  
**Numer procedury:** 03 | **Opracował:** Dominik Dziedzic | **Data opracowania:** 27.07.2026  
**Ilość stron:** 5 | **Zatwierdził:** Krzysztof Darul | **Rewizja:** 2.0

---

> Wersja tekstowa dokumentu `Procedura-03_Raporty_zdjeciowe_z_budowy_rev2.docx` (do przeglądu i porównywania zmian w repozytorium). Obowiązującą wersją procedury jest plik .docx na papierze firmowym Abyard.

## Cel procedury

Celem niniejszej procedury jest zapewnienie regularnego, rzetelnego i jednolitego raportowania postępu prac budowlanych na projektach realizowanych przez Abyard. Raporty z budowy umożliwiają monitorowanie postępu prac, identyfikację potencjalnych zagrożeń harmonogramowych oraz zapewnienie transparentnej komunikacji między uczestnikami realizacji projektu.

Od rewizji 2.0 raporty opracowywane są wyłącznie w firmowej aplikacji **Generator Raportów**, która narzuca jednolitą strukturę raportu, automatyzuje numerację i obliczenia harmonogramowe, pilnuje kompletności danych oraz prowadzi archiwum raportów.

## Zakres stosowania

Procedura raportowania dotyczy wszystkich projektów budowlanych realizowanych przez Abyard. Zobowiązuje ona kierowników budowy oraz kierowników projektów do sporządzania cyklicznych raportów zdjęciowych w Generatorze Raportów, przekazywania ich określonym odbiorcom oraz archiwizowania zgodnie z przyjętymi zasadami.

Raport sporządzony poza aplikacją (w edytorze tekstu, arkuszu, prezentacji) nie spełnia wymagań niniejszej procedury i nie jest uznawany za raport z budowy.

## Definicje

- **Raport z budowy** – dokument okresowy, przedstawiający postęp realizacji inwestycji w formie zdjęciowej i opisowej, zawierający ocenę stanu zaawansowania robót; opracowywany w Generatorze Raportów i generowany z niego w formacie PDF.
- **Generator Raportów (Generator, aplikacja)** – firmowa aplikacja internetowa Abyard, dostępna pod adresem https://generator-raportow-abyard.netlify.app, w której raporty są opracowywane, zapisywane, archiwizowane i udostępniane odbiorcom.
- **Baza raportów** – firmowa baza danych aplikacji, w której przechowywane są wszystkie raporty wraz z dokumentacją fotograficzną; podstawowe miejsce zapisu raportu.
- **Kierownik Budowy (KB)** – osoba odpowiedzialna za opracowanie raportu na podstawie harmonogramu budowy i zebrania danych od uczestników realizacji inwestycji.
- **Kierownik Projektu (KP)** – w przypadku małych projektów, na których kierownik budowy jest zewnętrzny, odpowiedzialność za sporządzenie raportu przejmuje kierownik projektu.
- **Administrator aplikacji** – osoba wyznaczona przez Kierownika Kontraktów, prowadząca konta i uprawnienia użytkowników, przypisania inwestycji do kierowników oraz nadzór nad kompletnością raportowania.
- **Harmonogram Budowy** – podstawowy dokument odniesienia, na podstawie którego oceniane jest zaawansowanie robót; w Generatorze odwzorowany jako stała lista 15 pozycji ZZK (Zbiorczego Zestawienia Kosztów) z możliwością dodania podpozycji.
- **Cashflow** – rozkład wartości umownych poszczególnych pozycji harmonogramu na miesiące realizacji, prezentowany w raporcie jako zestawienie miesięczne i narastające (krzywa S).
- **Dzień raportowy** – piątek wypadający w dwutygodniowym cyklu raportowania, w którym raport ma być opracowany, zapisany i przekazany odbiorcom.
- **Link do raportu** – adres wygenerowany w aplikacji, pod którym odbiorca ogląda raport bez logowania i może zapisać go jako PDF.
- **Serwer Abyard** – miejsce przechowywania i archiwizacji raportów i innych dokumentów dla poszczególnych projektów.

## Odpowiedzialność

- **Kierownik Budowy (KB)** – zobowiązany do sporządzenia raportu w Generatorze w wyznaczonym terminie, zebrania danych od uczestników realizacji, utrzymania aktualności harmonogramu i cashflow oraz przedstawienia podsumowania o stanie zaawansowania budowy.
- **Kierownik Projektu (KP)** – odpowiedzialny za przygotowanie raportu w przypadku projektów małej skali, a także za nadzorowanie poprawności raportowania.
- **Administrator aplikacji** – odpowiedzialny za konta i role użytkowników, przypisanie inwestycji do kierowników, ustalenie zakresu i punktacji obciążenia, odblokowywanie edycji raportów, unieważnianie linków oraz kontrolę terminowości raportowania.
- **Dział Administracyjny (DA)** – odpowiedzialny za archiwizację raportów na serwerze spółki.
- **Zarząd Spółki / Dyrektor Zarządzający / Kierownik Kontraktów** – odbiorcy raportów odpowiedzialni za analizę i podejmowanie decyzji na podstawie raportowanych danych.

## Przebieg procedury

### 1. Częstotliwość sporządzania raportów

- Raportowanie odbywa się w cyklu dwutygodniowym. Dniem raportowym jest **co drugi piątek**, zgodnie z cyklem 14-dniowym liczonym od piątku **10.07.2026 r.** (kolejne dni raportowe: 24.07.2026, 07.08.2026, 21.08.2026 itd.).
- W dniu raportowym, o godz. 8:00, aplikacja wysyła automatyczne przypomnienia e-mail z firmowej skrzynki Abyard: do każdego kierownika – z listą przypisanych mu inwestycji, a do administratorów – zbiorcze zestawienie wszystkich przypisań pogrupowane po kierownikach. Przypomnienie nie wymaga odpowiedzi; jego brak nie zwalnia z obowiązku sporządzenia raportu.
- Raport należy opracować, zapisać w bazie i przekazać odbiorcom **najpóźniej w dniu raportowym**. Jeżeli dzień raportowy przypada na dzień wolny od pracy, obowiązuje poprzedzający dzień roboczy.
- Okres raportowania obejmuje przedział od dnia zakończenia poprzedniego raportu do dnia opracowania raportu bieżącego. Generator ustala ten okres oraz kolejny numer raportu automatycznie.
- Inwestycje **wstrzymane** pozostają w cyklu raportowania — w przypomnieniu ich nazwa otrzymuje dopisek „– wstrzymana”. Raport dla takiej inwestycji sporządza się w zakresie, w jakim jest to zasadne, z odnotowaniem przyczyny i przewidywanego terminu wznowienia prac.
- Pierwszy raport inwestycji wymaga szczególnej staranności i dodatkowego nakładu pracy związanego ze zgromadzeniem danych początkowych — ustanawia on bazę (harmonogram, wartości umowne, kluczowe daty), którą dziedziczą wszystkie kolejne raporty tej budowy.
### 2. Dostęp do aplikacji i przypisanie inwestycji

- Praca w Generatorze wymaga imiennego konta założonego na służbowy adres e-mail. Konta, role (kierownik / administrator) oraz uprawnienia prowadzi administrator aplikacji.
- Administrator przypisuje inwestycje do kierowników w panelu administracyjnym. Przypisanie decyduje o tym, kto otrzymuje przypomnienie w dniu raportowym i kto odpowiada za sporządzenie raportu danej budowy.
- Konta są imienne — nie wolno udostępniać danych logowania innym osobom. Zmiany w obsadzie budów zgłasza się administratorowi niezwłocznie.
### 3. Opracowanie raportu w Generatorze Raportów

Dokument przygotowuje Kierownik Budowy, a w przypadku małych projektów Kierownik Projektu. Sporządzenie raportu odbywa się wyłącznie w Generatorze, zgodnie z układem formularza i poniższymi wytycznymi:

- **Wybór inwestycji** – z listy budów przypisanych użytkownikowi. Aplikacja nadaje kolejny numer raportu, ustala okres raportowania i przenosi dane z poprzedniego raportu tej budowy do aktualizacji.
- **Nagłówek** – numer raportu, okres raportowania (od–do), adres budowy, pełny tytuł zadania oraz grafika inwestycji (wizualizacja / rendering) prezentowana na stronie tytułowej raportu.
- **Kluczowe daty** – rozpoczęcie budowy, zakończenie robót, pozwolenie na użytkowanie (albo zaznaczenie „nie dotyczy”), osoba opracowująca i data opracowania.
- **Informacje ogólne** – rzetelny opis stanu zaawansowania robót w odniesieniu do harmonogramu budowy. W przypadku opóźnienia bezwzględnie należy podać: której pozycji dotyczy, ile wynosi w dniach, do kiedy i w jaki sposób zostanie nadrobione.
- **Sekcje opisowe prowadzone narastająco** – opisujące bieżące ustalenia i stan spraw:
  - **Wykonawcy prac** – zaawansowanie kontraktacji robót, wykonawcy i status prac każdego z nich.
  - **Przetargi** – przetargi rozstrzygnięte oraz aktualnie prowadzone.
  - **Sprawy ogólne budowy** – cash flow, roboty dodatkowe (kalkulacja, wycena, rozliczenie), umowy i aneksy z podwykonawcami, istotne ustalenia z narad budowy, BHP.
  - **Sprawy dotyczące Inwestora** – projekt, zmiany lokatorskie, dokumentacja, wnioski optymalizacyjne, zgody i pozwolenia, zajętości, rozliczenia i wyceny.
  - **Teren placu budowy** – organizacja, ochrona, pozostałe ustalenia.
- **Harmonogram budowy** – 15 stałych pozycji ZZK z możliwością dodania podpozycji. Daty umowne (start i koniec) pozostają niezmienne przez cały okres realizacji; aktualizuje się datę zakończenia prognozowaną (dla pozycji w toku) lub rzeczywistą (dla pozycji ukończonej) oraz procent wykonania. Opóźnienie aplikacja wylicza samodzielnie, a wartości pozycji nadrzędnej wynikają z podpozycji.
- **Cashflow** – wartości umowne pozycji harmonogramu rozkładane na miesiące realizacji, prezentowane jako macierz zadania × miesiące oraz wykres z krzywą S. Uzupełnienie wartości umownych jest **obowiązkowe w pierwszym raporcie inwestycji**; w kolejnych raportach dane są dziedziczone i aktualizowane.
- **Dokumentacja fotograficzna** – aktualne zdjęcia obrazujące postęp prowadzonych prac budowlanych, w dowolnej liczbie, z podpisami i ustaloną kolejnością. Zdjęcia są kompresowane automatycznie, bez utraty czytelności w raporcie.
- **Podsumowanie** – wybór jednej z dwóch dopuszczalnych ocen stanu zaawansowania budowy (punkt 4).
### 4. Podsumowanie raportu

Na podstawie zgromadzonych danych, po analizie całości harmonogramu i oceny opóźnień czynności na ścieżce krytycznej, Kierownik Budowy zobowiązany jest do sformułowania oceny stanu zaawansowania budowy, wybierając jedno z poniższych stwierdzeń:

- „Aktualny stan zaawansowania robót nie powoduje zagrożenia terminu zakończenia budowy.”
- „Aktualny stan zaawansowania budowy powoduje zagrożenie w dotrzymaniu terminu zakończenia budowy.”
Jeżeli z harmonogramu wynika, że opóźnienie przesuwa termin zakończenia całości projektu, aplikacja ustawia ocenę o zagrożeniu terminu automatycznie i blokuje możliwość wyboru wariantu przeciwnego. Podsumowanie jest istotnym wnioskiem raportu, na podstawie którego podejmowane są działania i przedsięwzięcia naprawcze.

### 5. Kontrole kompletności raportu

Aplikacja nie pozwala zapisać raportu, dopóki nie zostaną spełnione poniższe warunki:

- żadna pozycja harmonogramu w toku (poniżej 100%) nie ma przekroczonego terminu zakończenia — należy zaktualizować prognozę albo ustawić 100%,
- pierwszy raport inwestycji ma uzupełnione wartości umowne (cashflow) dla wszystkich pozycji harmonogramu, w których wprowadzono daty,
- wybrana została ocena stanu zaawansowania budowy (podsumowanie).
Wygenerowanie raportu jest możliwe dopiero po jego zapisaniu w bazie — dzięki temu przekazywany PDF jest zawsze zgodny z danymi zapisanymi w aplikacji.

### 6. Zbieranie danych

- Kierownik Budowy odpowiedzialny jest za zebranie niezbędnych informacji od wszystkich uczestników realizacji inwestycji, z odpowiednim wyprzedzeniem przed dniem raportowym.
- Raport powinien uwzględniać: stopień realizacji harmonogramu, stopień kontraktacji projektu, cashflow inwestycji, problemy i zagrożenia w realizacji oraz dokumentację zdjęciową.
### 7. Zakres odbiorców i przekazanie raportu

- Gotowe raporty przekazywane są do: Zarządu spółki, Dyrektora Zarządzającego, Kierownika Kontraktów oraz wszystkich uczestników realizacji projektu.
- Raport przekazuje się jako plik PDF wygenerowany z aplikacji albo jako **link do raportu**. Odbiorca linku ogląda raport bez logowania, zawsze w wersji aktualnej, i może zapisać go jako PDF. Link działa bezterminowo, aplikacja zlicza jego otwarcia, a unieważnić go może administrator.
- Linków do raportów nie przekazuje się osobom spoza kręgu odbiorców wskazanego powyżej.
- Na potrzeby Inwestora aplikacja generuje dodatkowo osobny załącznik XLSX zawierający sam harmonogram i cashflow — bez części opisowej i zdjęciowej raportu.
### 8. Korekta raportu

- Autor może poprawić zapisany raport w ciągu 24 godzin od jego utworzenia.
- Po upływie tego czasu edycję odblokowuje administrator — na kolejne 24 godziny, dla autora raportu oraz kierowników przypisanych do danej budowy. Administrator może edytować raport w każdej chwili.
- Korekta nie tworzy nowego numeru raportu. Jeżeli raport został już udostępniony linkiem, odbiorcy widzą wersję poprawioną automatycznie; przy przekazaniu PDF należy przesłać skorygowany plik.
### 9. Archiwizacja raportów

- Podstawowym archiwum raportów jest baza aplikacji — zakładka **„Archiwum raportów”** zawiera pełną historię raportów wszystkich budów wraz ze zdjęciami, z podglądem, wydrukiem PDF i listą wygenerowanych linków.
- Dodatkowo wygenerowany plik PDF raportu przechowywany jest na serwerze spółki Abyard, w katalogu właściwym dla danego projektu: U:\ABYARD\BUDOWY\XXX\PLAC_BUDOWY\RAPORTY_Z_BUDOWY.
- Odpowiedzialność za poprawne archiwizowanie dokumentów ponosi osoba odpowiedzialna za opracowanie raportu.
### 10. Koordynacja i nadzór nad raportowaniem

- Zakładka **„Kto co prowadzi”** prezentuje aktualny podział inwestycji między kierowników — dostępna jest dla wszystkich użytkowników aplikacji.
- W panelu administracyjnym administrator prowadzi zakres i punktację inwestycji, ocenę obciążenia kierowników (punkty wobec przyjętej pojemności), wstrzymywanie i wznawianie inwestycji oraz ich aktywność w cyklu raportowania.
- Terminowość i kompletność raportowania kontroluje Kierownik Kontraktów na podstawie archiwum raportów oraz zbiorczego zestawienia przypisań otrzymywanego w dniu raportowym.

## Załączniki

- **Załącznik nr 1 – Wzór raportu zdjęciowego z budowy** – wycofany z użytku z dniem wejścia w życie rewizji 2.0. Obowiązującym wzorem raportu jest formularz oraz układ dokumentu PDF wbudowany w Generator Raportów. Załącznik pozostaje w dokumentacji wyłącznie jako materiał referencyjny.

## Historia zmian

| Rewizja | Data | Opis zmiany | Opracował |
|---|---|---|---|
| 1.0 | 04.02.2025 | Wydanie pierwotne procedury. | Dominik Dziedzic |
| 2.0 | 27.07.2026 | Wdrożenie aplikacji Generator Raportów jako jedynego narzędzia opracowania raportów; zmiana cyklu raportowania na co drugi piątek wraz z automatycznymi przypomnieniami; dodanie zasad dostępu i przypisań, harmonogramu ZZK i cashflow, kontroli kompletności, udostępniania linkiem, korekty raportu w oknie 24 h oraz archiwizacji w bazie aplikacji; wycofanie Załącznika nr 1. | Dominik Dziedzic |
