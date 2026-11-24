# Rakennushaku: korjaussuunnitelma avoimiin kysymyksiin 1–9

SEAMK, Maatalous ja energia -tutkimusryhmä · EIP CHP Energiaälykäs eteläpohjalainen maatila · 24.11.2026 · koskee versiota 0.7.0

Numerointi viittaa menetelmäkuvauksen (`docs/MENETELMAT_JA_LAHTEET.md`) luvun 12 avoimiin kysymyksiin. Työmäärä: S alle päivä, M 1–3 päivää, L yli viikko tai riippuu ulkoisesta datasta. Kaikki laskentamuutokset tehdään sekä `model.py`:hin että `web/engine.js`:ään, ja `check_equivalence.py` laajennetaan kattamaan ne.

## Yhteenveto ja järjestys

| # | Kysymys | Korjaus lyhyesti | Työ | Riippuu |
|---|---|---|---|---|
| 5 | FMI:n aikaleima | Todennetaan 10 min havainnoista, lukitaan testillä | S | Yksi yhteys FMI:hin |
| 8 | CSV-muoto | Vientimuodon valinta + .xlsx-vienti | S–M | – |
| 7 | Mittausdatan laatu | Katkojen, nollajaksojen, piikkien ja jumiutuneen mittarin tunnistus; merkityt tunnit pois sovituksesta | M | – |
| 9 | Kesken oleva vuosi | Puuttuvat tunnit täytetään tyypillisellä säällä, tulos merkitään osittaiseksi | M | – |
| 6 | Aseman valinta | Ehdokasasemien vertailu tilan pisteen ERA5-sarjaan (astetunnit, harha, korrelaatio) | M | – |
| 4 | Polttoaineen määrä | Varastonmuutos, hakkeen kosteuslaskenta, lähteistetyt lämpöarvot, epävarmuusväli | M | Lähdetarkistus |
| 3 | Aito Datahub-tiedosto | Anonymisoitu oikea lataus testiaineistoksi | S + odotus | Tiedosto tilalta |
| 2 | Laskurin sää- ja PV-vuosi | Vientiin PV-tuotto/kWp; laskuriin sarakkeet G–H ja kaavamuutokset | M–L | Laskurin repo, sarakepäätös |
| 1 | Oletusparametrit | Pilottitilojen mittaukset, parametrien sovitus, ristiinvalidointi, CIGR-eläinlämpö | L | 2–3 tilan tuntidata |

Ehdotettu järjestys: ensin kohdat, jotka eivät tarvitse ulkoista dataa (5, 8, 7, 9, 6, 4), samalla käynnistetään datapyynnöt kohtiin 3 ja 1. Kohta 1 hyötyy kohdista 7 (datan siivous) ja 3 (oikean tiedoston luku). Tavoiteversiot: 0.8.0 = kohdat 4–9, 0.9.0 = kohdat 2–3, 1.0.0 = kohta 1.

---

## 1. Oletusparametrien validointi (suuri, L)

**Ongelma.** H, ΔT_sis, q_perus, e_perus, e_ilmanv ja vuorokausiprofiilit ovat omia oletuksia. Ilman kulutustietoa tulos on vain suuntaa antava.

**Korjaus.**

1. **Pilottiaineisto.** 2–3 tilaa: broileri, sika ja mahdollisuuksien mukaan navetta. Kultakin vähintään yksi kokonainen vuosi:
   - sähkö tunneittain Datahubista (myös kohta 3)
   - lämpö: lämpömäärämittari tai kattilan oma loki; jos sellaista ei ole, hakkeen syöttöruuvin käyntiaika tai kuukausittaiset kuormat
   - rakennusten alat ja käyttö, broilereilla erien sisäänotto- ja poistopäivät sekä eläinmäärät.
2. **Lähtötaso.** Ajetaan nykyiset oletukset ilman kalibrointia ja raportoidaan tilakohtaisesti vuosiharha, CV(RMSE) kuukausi- ja tuntitasolla sekä huipputehon virhe. Tämä kertoo, kuinka paljon oletukset nyt heittävät.
3. **Eläinten lämmöntuotto CIGR:n mukaan [19].** ΔT_sis-vakio korvataan eläinten kokonaislämmöntuotolla Φ_tot(m) (W/eläin, painon funktio), lämpötilakorjauksella ja tuntuvan lämmön osuudella. Syötteet: eläinmäärä ja painokäyrä (broilerille erän ikä → paino). Lämmitystarve = max(0, H·A·(T_aset − T_ulko) − Φ_tuntuva·n). Uusi funktio `animal_heat()` molempiin moottoreihin.
4. **Parametrien sovitus.** Käyttötyypeittäin sovitetaan H, q_perus ja e_perus kaikkien pilottien yhteisellä pienimmällä neliösummalla. Kerroin pidetään yhteisenä, jos tiloja on vähän. Tilakohtaiset erot raportoidaan, mutta niitä ei sovelleta oletuksiin.
5. **Ristiinvalidointi.** Jätetään yksi tila kerrallaan pois ja ennustetaan se muilla parametreilla. Tämä virhe kirjataan menetelmäkuvaukseen oletusten epävarmuudeksi, ja käyttöliittymä näyttää sen kalibroimattomassa tuloksessa (esim. "oletustaso ±40 %").
6. **Dokumentointi.** Parametritaulukon Lähde-sarakkeeseen merkitään "sovitettu, n tilaa, vuosi". Tilat anonymisoidaan.

**Hyväksyminen.** Oletusten vuosiharha ristiinvalidoinnissa on raportoitu. Kalibroidulla mallilla kuukausitason CV(RMSE) on alle 15 % kaikilla pilottitiloilla.

**Tarvitaan sinulta.** Mitkä tilat ja kuka pyytää datan (Datahub-valtuutus, kattilaloki). Tietosuoja: tilat nimetään vain koodilla.

## 2. Laskurin oma sää- ja PV-vuosi (suuri, M–L)

**Ongelma.** Laskurin lämpöpumpun COP ja aurinkosähkö käyttävät laskurin esimerkkivuotta, vaikka kulutus mallinnetaan tarkasteluvuoden säällä. Kylmän jakson kulutushuippu ja COP:n notko eivät osu samoille tunneille.

**Korjaus Rakennushaussa.**

1. **PV-tuotto/kWp.** Open-Meteon arkistosta haetaan tunneittain säteily (`shortwave_radiation`, `diffuse_radiation` tai `global_tilted_irradiance`) samalla pyynnöllä kuin lämpötila. Säteily muunnetaan paneelin tasolle valitulla kallistuksella ja atsimuutilla (oletus 30°, etelä). Tuotto lasketaan PVWatts-tyyppisellä mallilla: lämpötilakerroin −0,4 %/K, kennolämpötila säteilystä ja ulkolämmöstä, järjestelmähäviöt 14 %. Tulos on kWh/kWp tunnissa.
2. **Tarkistus.** Vuosisummaa verrataan PVGIS:n arvoon samalle pisteelle (Etelä-Pohjanmaalla noin 850–950 kWh/kWp; luku tarkistetaan PVGIS:stä, ei tästä). Ero yli 10 % näkyy varoituksena.
3. **Vienti.** `oma_kulutusdata`-CSV:hen lisätään sarake "PV-tuotto (kWh/kWp)". Nykyinen hintasarake siirtyy sarakkeeseen I, tai sarakejärjestys sovitaan laskurin kanssa (päätös alla).

**Korjaus laskurissa** (repo joriim/EIP-CHP-Maatilan-hybridienergialaskuri, sekä Excel- että selainversio):

1. *Oma kulutusdata* -välilehdelle sarakkeet G = ulkolämpötila ja H = PV kWh/kWp.
2. Kun D4 = Oma data, lämpöpumpun COP-kaava lukee lämpötilan sarakkeesta G ja aurinkosähkö sarakkeesta H × asennettu kWp. Muuten käytetään esimerkkivuotta kuten nyt.
3. Jos sarakkeet ovat tyhjiä, laskuri palaa esimerkkivuoteen ja näyttää huomautuksen.
4. Testi: sama Oma data -tiedosto antaa saman tuloksen Excelissä ja selainversiossa.

**Hyväksyminen.** Testitilan talven huipputunnilla COP lasketaan saman tunnin ulkolämpötilasta. PV:n vuosisumma on enintään 10 % PVGIS:n arvosta.

**Tarvitaan sinulta.** Saako laskurin repoa muuttaa tässä yhteydessä, ja sarakejärjestys: (a) G lämpötila, H PV, I hinta, vai (b) hinta pysyy sarakkeessa H ja PV menee sarakkeeseen I.

## 3. Aito Datahub-tiedosto (keskisuuri, S + odotus)

**Ongelma.** Jäsennin on testattu vain tuotetuilla tiedostoilla.

**Korjaus.**

1. Pyydetään yksi oikea lataus Oma Datahubista: sähkö, vähintään vuosi, mieluiten sekä tunti- että 15 min jaksolta.
2. Anonymisoidaan skriptillä `tests/data/anonymize_datahub.py`: käyttöpaikan ja mittarin tunnisteet sekä osoite korvataan, ja arvot skaalataan satunnaisella kertoimella 0,7–1,3. Rakenne (otsikot, erotin, aikaleimamuoto, laatu- ja tilasarakkeet) säilyy ennallaan.
3. Lisätään testiksi `tests/data/datahub_real_anon.csv` ja testi, joka tarkistaa vuosisumman, aika-askeleen ja kesäajan siirtymät.
4. Jos tiedostossa on laatusarake (esim. arvioitu ja mitattu), jäsennin lukee sen ja välittää arvioidut tunnit kohdan 7 laatutarkistukselle.

**Hyväksyminen.** Oikea tiedosto luetaan ilman käsin muokkausta, ja vuosisumma täsmää Datahubin ilmoittamaan.

**Tarvitaan sinulta.** Yksi lataus. Oma kotitalouden tiedosto käy, koska formaatti on sama.

## 4. Polttoaineen määrän epävarmuus (keskisuuri, M)

**Ongelma.** Ostot eivät ole sama asia kuin poltettu määrä (varasto), hakkeen energiasisältö riippuu kosteudesta, ja pelletin ja öljyn arvot ovat tarkistamattomia.

**Korjaus.**

1. **Varastonmuutos.** Polttoainesyötteeseen tulevat kentät alkuvarasto ja loppuvarasto (valinnaiset): poltettu = ostot + alku − loppu. Jos varastoja ei anneta, näytetään huomautus, että ostot oletetaan poltoksi.
2. **Usean vuoden keskiarvo.** Vaihtoehtona annetaan 2–3 vuoden ostot, ja niiden keskiarvo skaalataan tarkasteluvuoden astetunneilla: E_vuosi = keskiarvo × S_vuosi / S_keskiarvo. Tämä tasoittaa varaston vaihtelun.
3. **Hakkeen kosteus.** Valinnainen syöte kosteus w (%) ja puulaji tai jae. Energiasisältö lasketaan kaavalla q_net,ar = q_net,d·(1 − w) − 2,443·w (MJ/kg) ja i-m³:n kuivatiheydellä. Kuiva-aineen lämpöarvot ja tiheydet otetaan VTT Technology 258:sta [14]. Ilman kosteutta käytetään laskurin oletusta 0,8 MWh/i-m³.
4. **Lähdetarkistus.** Pelletin (t) ja kevyen polttoöljyn (l) arvot tarkistetaan lähteistä [13], [14] ja Tilastokeskuksen polttoaineluokituksesta. Taulukon "ei tarkistettu" -merkinnät poistetaan, ja lähde lisätään lähdeluetteloon.
5. **Epävarmuusväli.** Tuloskortissa näytetään lämmön vaihteluväli kosteuden (±5 %-yksikköä) ja hyötysuhteen (±0,05) mukaan. Pysyvyyskäyrään ei tehdä muutosta.

**Hyväksyminen.** Testi: 400 i-m³, kosteus 45 % → lämpö lasketaan lähteen kaavalla ja täsmää käsin laskettuun. Varastonmuutos vähentää tai lisää oikein.

## 5. FMI:n tuntiarvon aikaleima (pieni, S)

**Ongelma.** `TA_PT1H_AVG` kohdistetaan oletuksena edeltävälle tunnille (arvo = tunnin loppuhetkeen päättyvän tunnin keskiarvo). Tätä ei ole todennettu.

**Korjaus.**

1. Todennus: samalta asemalta ja vuorokaudelta haetaan sekä tuntikeskiarvo että 10 min havainnot (`fmi::observations::weather::simple`, `t2m`). Lasketaan 10 min arvojen keskiarvot väleille [t − 1 h, t) ja [t, t + 1 h) ja katsotaan, kumpi vastaa tuntiarvoa. Tehdään 3 asemalle ja päivälle, jolla lämpötila muuttuu nopeasti (esim. kylmän rintaman ohitus).
2. Tulos kirjataan menetelmäkuvaukseen ("todennettu pvm, asemat") ja tarvittaessa korjataan `fmi_temperature()` sekä `engine.js`.
3. Pysyvä testi: tallennetaan pieni XML-otos kummastakin kyselystä `tests/data/`-hakemistoon, ja testi tarkistaa kohdistuksen.

**Hyväksyminen.** Keskiarvon ero valitulle välille on alle 0,1 °C ja selvästi pienempi kuin toiselle välille.

**Huom.** Kehitysympäristöstä ei ehkä ole yhteyttä FMI:hin. Tämä voidaan ajaa selaimessa omalla koneellasi tai linkitetyn koneen kautta.

## 6. Aseman valinta (pieni, M)

**Ongelma.** Asema valitaan pelkän etäisyyden perusteella. Rannikko, korkeus ja jokilaakson kylmänpesä jäävät huomiotta.

**Korjaus.**

1. Ehdokkaat ovat 3–4 lähintä toiminnassa olevaa asemaa alle 60 km:n päässä.
2. Kullekin lasketaan tarkasteluvuodelta vertailu Open-Meteon ERA5-sarjaan tilan pisteessä:
   - lämmitysastetunnit (raja 17 °C) ja ero ERA5:een prosentteina
   - keskimääräinen harha (°C)
   - tuntikorrelaatio
   - puuttuvien tuntien osuus.
3. Asemalistassa näytetään nämä luvut. Oletuksena valitaan asema, jonka astetuntiero on pienin, ellei se ole yli 1,5 kertaa lähintä kauempana. Käyttäjä voi vaihtaa valinnan.
4. Varoitus näkyy, jos valitun aseman astetunnit poikkeavat ERA5:stä yli 8 % (oma raja, perustellaan menetelmäkuvauksessa). ERA5:n oma harha tunnetaan, joten se on vertailukohta eikä totuus.
5. Asemien korkeus luetaan FMI:n asemametatiedosta, jos se on saatavilla, ja näytetään listassa.

**Hyväksyminen.** Testiaineistolla rannikkoaseman ja sisämaan aseman ero näkyy, ja valinta perustellaan käyttäjälle yhdellä rivillä.

## 7. Mittausdatan laatu (pieni, M)

**Ongelma.** Tuntisarjasta ei tunnisteta katkoja, nollia, piikkejä eikä jumiutunutta mittaria. Virheelliset tunnit vääristävät kalibrointia.

**Korjaus.** Uusi funktio `quality_flags(series, kind)` molempiin moottoreihin. Se tunnistaa:

| Tarkistus | Sääntö (omat oletukset, muokattavissa) |
|---|---|
| Katko | puuttuva tunti; yli 6 h jaksot raportoidaan erikseen |
| Nollajakso | ≥ 6 peräkkäistä nollatuntia, kun malli odottaa kulutusta (talvi, lämpö) |
| Jumiutunut mittari | ≥ 12 peräkkäistä täsmälleen samaa nollasta poikkeavaa arvoa |
| Piikki | arvo > mediaani + 8 · MAD 7 vrk:n liukuvassa ikkunassa ja > 2 × naapuritunnit |
| Negatiivinen | arvo < 0 |
| Kesäaika | kaksoistunti tai puuttuva tunti siirtymäyönä (jäsennin) |
| Datahubin laatukoodi | arvioitu tai puuttuva, jos tiedostossa on laatusarake (kohta 3) |

- Merkityt tunnit näytetään tuloksessa ("12 piikkiä, 1 nollajakso 18 h, 3.2.") ja kuvaajassa punaisena.
- Valinta: merkityt tunnit jätetään pois sovituksesta (oletus) ja korvataan mallin arvolla, tai käytetään sellaisenaan.
- CV(RMSE) lasketaan vain hyväksytyistä tunneista.

**Hyväksyminen.** Testisarja, johon on istutettu katko, nollajakso, piikki ja jumiutunut jakso: kaikki tunnistetaan, eikä puhtaasta sarjasta tule vääriä hälytyksiä. Python ja JS antavat samat liput.

## 8. CSV-muoto (pieni, S–M)

**Ongelma.** Puolipiste ja desimaalipilkku avautuvat suoraan vain suomenkielisessä Excelissä.

**Korjaus.**

1. Vientiin muotovalinta: "Suomi (; ja ,)" (oletus) tai "Kansainvälinen (, ja .)". Valinta muistetaan selaimessa.
2. Lisätään **.xlsx-vienti**, joka avautuu oikein kaikilla kieliasetuksilla. Kirjoitin on oma ja pieni: zip ilman pakkausta, yksi taulukko, numerot numeroina. Selainversioon ei tule raskasta kirjastoa, ja Python-versio käyttää vakiokirjaston `zipfile`-moduulia.
3. Sarakkeet ja otsikot ovat samat kuin CSV:ssä, joten laskuriin liittäminen ei muutu.

**Hyväksyminen.** .xlsx avautuu Excelissä (fi ja en), LibreOfficessa ja openpyxl:llä, ja arvot ovat numeroita. Testi lukee tiedoston openpyxl:llä.

## 9. Kesken oleva vuosi (pieni, M)

**Ongelma.** Kuluvan vuoden säädata ei ole täydellinen, joten mallia ei voi ajaa ennen vuoden loppua.

**Korjaus.**

1. Puuttuvat tunnit (tähän päivään asti haetun jälkeen) täytetään tyypillisellä säällä: saman aseman tai ERA5-pisteen edellisten 10 vuoden samojen kalenterituntien keskiarvo. Vaihtoehto on edellisen vuoden sää samoilta tunneilta. Käyttäjä valitsee, ja oletus on keskiarvo.
2. Tulos merkitään osittaiseksi: "säästä mitattu 1.1.–23.11., loppu tyypillinen". Merkintä näkyy tuloksessa, tarkistuslistassa ja viennin tiedostonimessä (`_osittainen`).
3. Kulutustieto: kalibroinnissa käytetään vain tunteja ja kuukausia, joilta on sekä mitattu sää että kulutus.
4. Hinnat: puuttuvat tunnit jätetään tyhjiksi kuten nyt, koska laskuri täyttää ne itse.

**Hyväksyminen.** Testi, jossa vuodesta puuttuu kaksi kuukautta: malli ajaa, täytetyt tunnit ovat oikeat, ja merkintä näkyy viennissä.

---

## Yhteiset muutokset

- Menetelmäkuvauksen luku 12: korjatut kohdat siirretään taulukkoon "Korjattu versiossa 0.8.0", jäljelle jäävät pidetään avoimina.
- CHANGELOG, versio ja CITATION päivitetään julkaisun yhteydessä (Zenodo-DOI uudelle versiolle).
- Käyttöliittymän tekstit SEAMKin äänensävyllä. Uudet tilat (laatuliput, osittainen vuosi, asemavertailu) noudattavat brändin värejä: pinkki = virhe, keltainen-50 = varoitus.
- Testit: arviolta +20 Python-testiä ja +6 JS-testiä, ja vastaavuustarkistukseen 4 uutta skenaariota (CIGR-lämpö, laatuliput, osittainen vuosi, varastonmuutos).
