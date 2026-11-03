---
title: "Rakennushaku – menetelmät ja lähteet"
subtitle: "Versio {{VERSION}}, {{DATE}}"
lang: fi
---

# Rakennushaku – menetelmät ja lähteet

**Versio:** {{VERSION}} · **Päivitetty:** {{DATE}}  
**Tekijät:** Miiro Jääskeläinen ja Suvi Karirinne, Seinäjoen ammattikorkeakoulu (SEAMK), Maatalous ja energia -tutkimusryhmä  
**Hanke:** EIP CHP Energiaälykäs eteläpohjalainen maatila (EU:n osarahoittama)  
**Liittyy:** Maatilan hybridienergialaskuri, versio 0.9.3 [18]

Tässä dokumentissa kuvataan, mistä Rakennushaun tiedot tulevat, miten niitä käsitellään ja mitkä mallin arvot perustuvat lähteeseen ja mitkä ovat tekijöiden omia oletuksia. Hakasulkeissa olevat numerot viittaavat lähdeluetteloon (luku 13).

**Merkinnät:**

- **[n]**: arvo tai menetelmä perustuu lähteeseen n.
- **Oma oletus**: tekijöiden valitsema arvo, jota ei ole johdettu lähteestä eikä validoitu mitatulla tilalla. Oletusarvot määräävät ensisijaisesti tuntiprofiilin *muodon*; profiilin *taso* tulee tilan omasta kulutustiedosta (luku 8).

## 1. Tarkoitus ja rajaus

Rakennushaku tuottaa tilan valituille rakennuksille 8 760 tunnin sähkö- ja lämpösarjan Maatilan hybridienergialaskurin *Oma kulutusdata* -välilehdelle [18] sekä halutessa saman vuoden pörssihinnat laskurin *Hintahistoria*-välilehdelle.

Malli on alustavaan vertailuun tarkoitettu tilastollis-fysikaalinen yksinkertaistus. Se ei ole rakennusfysikaalinen simulointi. Se ei mallinna rakenteita, ilmanvaihdon ohjausta, aurinkokuormaa, kosteutta eikä eläinten lämmöntuottoa painon funktiona. Tulokset eivät korvaa mitattua tuntidataa. Kun mitattu tuntisarja on käytettävissä, malli käyttää mitatut tunnit sellaisenaan ja täydentää vain puuttuvat tunnit.

## 2. Tietolähteet

| Aineisto | Käyttö sovelluksessa | Rajapinta | Käyttöehdot | Viite |
|---|---|---|---|---|
| MML Maastotietokanta, rakennukset | Rakennusten sijainti, pohja, kohdeluokka, kerrosluku | OGC API Features, API-avain | Avoin data, CC BY 4.0 | [1], [2] |
| MML kiinteistörekisterikartta, palstat | Kiinteistön rajaus kiinteistötunnuksella tai pisteellä | OGC API Features, API-avain | Avoin data, CC BY 4.0 | [1], [3] |
| MML osoitehaku | Osoite → koordinaatit | Geokoodauspalvelu, API-avain | Avoin data, CC BY 4.0 | [1] |
| MML ortokuva ja taustakartta | Taustakartta | WMTS, API-avain | Avoin data, CC BY 4.0 | [1] |
| Ilmatieteen laitos, havaintoasemat ja tuntilämpötila | Lähimmät asemat, ulkolämpötila (TA_PT1H_AVG) | WFS (avoin data) | CC BY 4.0 | [4], [5] |
| Open-Meteo, historiallinen säädata | Ulkolämpötila tilan kohdalla, FMI-sarjan aukkojen paikkaus | REST/JSON | CC BY 4.0; ilmainen API ei-kaupalliseen käyttöön | [6], [7], [8] |
| Sähkötin (Pakastin Oy), Nord Poolin FI-alueen hinnat | Pörssihinnat €/MWh alv 0 | CSV | Ilmainen API ei-kaupalliseen käyttöön; Nord Pool omistaa datan | [9], [10] |
| Fingrid Datahub | Käyttäjän oma sähkönkulutus (tiedosto) | Käyttäjä lataa itse | Käyttäjän oma tieto | [11] |
| Käyttäjä | Lämmitetty ala, käyttötarkoitus, polttoaineen määrä, tunnetut kulutukset | – | – | – |

Sovellus ei jaa eikä sisällä ulkoista dataa. Kaikki tiedot haetaan käyttäjän omalle koneelle käyttäjän omaan tarkasteluun. Selainversiossa laskenta tehdään selaimessa; rajapinnoille lähtevät vain sijainti, kiinteistötunnus, osoitehakuteksti ja vuosi. Kulutustiedot eivät lähde koneelta.

## 3. Aikakanta

Kaikki sarjat ovat laskurin aikakannassa [18]: 8 760 tuntia kiinteässä EET-ajassa (UTC+2), rivi 1 = 1.1. klo 00–01, rivi 8 760 = 31.12. klo 23–24. Kesäaikaa ei käytetä, ja karkausvuoden 29.2. poistetaan.

Kesäaikaa käyttävä paikallinen aika muunnetaan UTC:ksi EU:n kesäaikasäännöllä: kesäaika alkaa maaliskuun viimeisenä sunnuntaina klo 01.00 UTC ja päättyy lokakuun viimeisenä sunnuntaina klo 01.00 UTC [12]. Syksyn toistuva tunti tunnistetaan siitä, että paikallinen aikaleima ei etene. Varttiarvot summataan energiana tunneiksi. Lämpötilat ja hinnat keskiarvoistetaan.

## 4. Rakennusten tunnistus

- **Haku.** Rakennukset haetaan Maastotietokannan `rakennus`-kokoelmasta kiinteistön ulkorajojen suorakaiteesta, jota on laajennettu 60 m (oma oletus). Ominaisuudet: `mtk_id`, `kohdeluokka`, `kerrosluku`, `alkupvm` ja geometria [2]. Sama haku ja luokitus ovat käytössä dkk-flightmanagerissa [17].
- **Kohdeluokat.** Luokat 4221x asuinrakennus, 4222x liike- tai julkinen, 4223x loma-, 4224x teollinen, 4226x maatalous- tai varastorakennus ja 42270 muu. Ryhmittely noudattaa dkk-flightmanageria, jossa koodit on todettu aineistosta [17]. Luokan viimeinen numero kuvaa kerrosmäärää (1 = 1–2 krs, 2 = 3 krs tai enemmän) [2].
- **Kerrokset ja pinta-ala.** Kerrosluku otetaan aineistosta. Jos se puuttuu, kerroksia on 1, tai 3 luokassa xxxx2 (oma oletus). Pohjan ala lasketaan geometriasta paikallisessa metrisessä tasoprojektiossa. Kiinteistön mittakaavassa virhe on alle 0,5 % (oma arvio). Lämmitetyn alan lähtöarvo on pohjan ala × kerrokset. Käyttäjän pitää korjata se, koska Maastotietokannassa ei ole kerrosalaa eikä lämmitystietoa.
- **Kiinteistöllä vai naapurilla.** Rakennus katsotaan kiinteistölle kuuluvaksi, kun sen pohjan painopiste on kiinteistön sisällä tai enintään 5 m sen rajasta. Toleranssi on oma oletus: Maastotietokannan rakennukset ja kiinteistörajat eivät ole täsmälleen yhteensopivia.
- **Ehdotukset.** Asuinrakennukset ja vähintään 600 m²:n maatalousrakennukset valitaan valmiiksi ehdotuksina (oma oletus). Käyttäjä tarkistaa valinnan.

## 5. Säätiedot

- **Asemat.** Lähimmät Ilmatieteen laitoksen havaintoasemat (verkko 121) haetaan WFS-tallennetulla kyselyllä `fmi::ef::stations` [5]. Etäisyys lasketaan isoympyräetäisyytenä (haversine) [16]. Asemat, joiden toiminta-aika ei kata tarkasteluvuotta, jätetään pois. Korkeusero ja rannikko- tai sisämaasijainti eivät vaikuta valintaan.
- **Tuntilämpötila.** Parametri `TA_PT1H_AVG` (tunnin keskilämpötila) haetaan kyselyllä `fmi::observations::weather::hourly::simple` 28 vuorokauden jaksoissa. Palvelu sallii enintään 744 tuntia kyselyä kohti (todettu palvelun virheilmoituksesta 31.10.2026). Arvo kohdistetaan tuntiin, jonka *lopussa* se on aikaleimattu (oletus, tarkistettava FMI:n dokumentaatiosta).
- **Open-Meteo.** Historiallinen säädata perustuu ECMWF:n ERA5-uudelleenanalyysiin [6], [7]. Hetkelliset tuntiarvot muutetaan tuntikeskiarvoiksi kahden peräkkäisen arvon keskiarvona (oma likiarvo).
- **Aukot.** Enintään 6 tunnin aukot interpoloidaan lineaarisesti (oma oletus). FMI-sarjan pidemmät aukot paikataan Open-Meteon arvoilla tilan kohdalta. Paikattujen tuntien määrä näytetään.
- **Tarkistus.** Testissä 31.10.2026 Seinäjoki Pelmaan (101486) vuoden 2025 sarja oli täydellinen (8 760 h, keskiarvo 6,2 °C). Open-Meteo antoi samaan pisteeseen keskiarvon 6,1 °C.

## 6. Kulutustiedot ja muunnokset

**Tiedostot.** Datahub- ja mittaritiedostot luetaan yleisellä CSV-jäsentimellä. Se tunnistaa erottimen, desimaalipilkun, aikaleimasarakkeen ja arvosarakkeen, aika-askeleen (5–60 min) sekä yksikön (Wh, kWh, MWh). Jäsennin on testattu tuotetuilla Datahub-muotoisilla tiedostoilla, mutta ei vielä aidolla Datahub-latauksella [11].

**Polttoaineen muunnos toimitetuksi lämmöksi.** Toimitettu lämpö = polttoaineen energia × kattilan hyötysuhde. Laskurin *Oma kulutusdata* odottaa lämmöntarvetta, ei polttoaine-energiaa [18].

| Yksikkö | Energiasisältö | Lähde |
|---|---|---|
| i-m³ haketta | 0,8 MWh/i-m³ (muokattava) | Laskurin oletus (Ohjauspaneeli K35) [18]. Hakkeen energiasisältö riippuu kosteudesta ja puulajista; kokopuuhakkeelle ilmoitetaan käyttötilassa (kosteus 40–55 %) lämpöarvo 7–11 GJ/t [13]. Tarkemmat arvot: VTT Technology 258 [14]. |
| MWh polttoainetta | 1 000 kWh/MWh | Määritelmä |
| t pellettiä | 4,7 MWh/t | Yleinen likiarvo; ei tarkistettu lähteestä tässä versiossa. Tarkista [14] tai toimittajan tuoteseloste. |
| l kevyttä polttoöljyä | 10 kWh/l | Yleinen likiarvo; ei tarkistettu lähteestä tässä versiossa. Tarkista [13], [14]. |
| Kattilan hyötysuhde | 0,85 (muokattava) | Laskurin oletus (C26) [18] |

## 7. Rakennusmalli

Jokaiselle rakennukselle lasketaan tunneittain sääosa W ja perusosa B sekä lämmölle että sähkölle:

    lämpö_W,h = A · H · max(0, T_aset,h − ΔT_sis,h − T_ulko,h) / 1000      [kWh]
    lämpö_B,h = A · q_perus / 1000
    sähkö_B,h = A · e_perus · p_h · m_h / 1000
    sähkö_W,h = A · e_ilmanv · max(0, T_ulko,h − 12 °C) · p_h · m_h / 1000

A on lämmitetty ala (m²), H lämpöhäviökerroin ilmanvaihto mukaan lukien (W/m²K) ja ΔT_sis sisäisten lämmönlähteiden (eläimet, ihmiset, laitteet) aiheuttama lämpötilan nousu (K). p_h on vuorokausiprofiili, jonka keskiarvo on 1, ja m_h on käyttöaste (broilerierät, kuivurikausi).

Rakenne on lämmitystarveluvun (astetunnit) ja energiasignatuurin yhdistelmä. Kulutus riippuu lineaarisesti ulkolämpötilasta tasapainolämpötilan T_aset − ΔT_sis alapuolella, ja lisäksi on säästä riippumaton perusosa [15]. Eläinten lämmöntuotto on jatkuva funktio eläinten koosta ja määrästä [19]. Mallissa sitä kuvaa yksinkertaistettu vakio tai lineaarinen kasvu, *ei* CIGR:n yhtälöt.

**Käyttötyyppien oletusparametrit.** Kaikki taulukon luvut ovat **omia oletuksia**, ellei sarakkeessa *Lähde* toisin mainita. Ne on valittu tuottamaan uskottava profiilin muoto, eikä niitä ole validoitu mitatuilla tiloilla. Ilman kulutustietoa niiden tuottama taso on epävarma: testiajossa kahden broilerihallin (yhteensä noin 3 500 m²) ja asuinrakennuksen oletustaso oli noin 850 MWh/v, eikä sitä ole verrattu mitattuun kulutukseen.

{{USE_TYPES_TABLE}}

**Broilerikasvattamon erärytmi.**

- **Asetuslämpö** on 30 °C sisäänotossa ja laskee lineaarisesti 20 °C:een 27 vuorokauden ikään mennessä. Sen jälkeen asetus on 20 °C. Arvot ovat Aviagenin Ross-käsikirjan koko hallin lämmityksen suositukset (taulukko 2.4 ja keskeinen hoitoaikataulu) [20]. Käsikirjan taulukko on painon mukainen; lineaarinen ikäapproksimaatio on oma yksinkertaistus.
- **Lintujen lämmöntuotto** ΔT_sis kasvaa 0 → 15 K erän aikana muodolla (vrk/erä)^1,3 (oma oletus).
- **Oletusrytmi:** 35 vrk:n erä, 12 vrk:n tyhjä jakso, 2 vrk:n esilämmitys 30 °C:ssa ja tyhjänä +8 °C:n jäätymisenesto (omat oletukset, käyttäjä muokkaa rytmiä). Sähkön käyttöaste tyhjänä on 0,15 ja esilämmityksessä 0,4 (oma oletus).
- **Hallien vaiheistus:** jos usealla hallilla on sama sisäänottopäivä, huiput osuvat päällekkäin. Käyttäjän kannattaa antaa halleille todellinen vaiheistus.

**Viljankuivuri.** Prosessilämpö ja sähkö kuluvat vain kaudella 1.8.–15.10. (vuoden päivät 212–287), eivätkä riipu säästä (omat oletukset).

**Vuorokausiprofiilit.** Asuinrakennuksen aamu- ja iltahuiput, navetan lypsyhuiput (noin klo 5–8 ja 16–19) sekä arkipäivän työaika (klo 7–16, viikonloppuna perustaso) ovat omia oletuksia.

**Sähkö vain tai lämpö vain.** Rakennuksen voi ottaa mukaan vain sähköön, esim. konehalli tai kuivuri samasta liittymästä. Muuten liittymän mitattu kulutus kohdistuisi kokonaan lämmitettyjen rakennusten profiilille.

## 8. Kalibrointi tilan kulutustietoon

Kalibrointi tehdään lämmityspiireittäin ja sähkömittareittain, koska kulutustieto tulee laskuilta ja mittareilta, ei rakennuksittain.

| Kulutustieto | Menetelmä | Mitä tieto ratkaisee |
|---|---|---|
| Ei tietoa | Mallin oletus | Ei mitään; tulos ei kuvaa tilaa |
| Vuosisumma | Yksi skaalauskerroin k = E / Σ(W+B) | Vuoden taso. Muoto, sää- ja perusosan suhde sekä huippu tulevat mallista. |
| Vuosisumma + säästä riippumaton osuus s | W skaalataan summaan (1−s)·E ja B summaan s·E | Taso ja käyttäjän antama sää- ja perusosan suhde |
| Kuukausisummat (≥ 3 kk) | Pienimmän neliösumman sovitus E_kk ≈ a·W_kk + b·B_kk, a, b ≥ 0 [21] | Taso sekä sää- ja perusosan suhde |
| Tuntisarja | Mitatut tunnit sellaisenaan; a, b sovitetaan mitattuihin tunteihin ja täydentävät puuttuvat | Kaikki mitatuilta tunneilta |

- **Sopivuus.** Kuukausi- ja tuntisovituksen sopivuus raportoidaan CV(RMSE)-lukuna. Raja-arvot ovat ASHRAE Guideline 14:n kalibrointikriteerit: kuukausitasolla 15 % ja tuntitasolla 30 % [22], [23]. Kriteerit on laadittu rakennusten energiamallien kalibrointiin. Ne ovat tässä suuntaa antavia, koska malli on yksinkertainen ja maatilan kuormat (erät, kuivaus) poikkeavat rakennusten tavallisesta kulutuksesta.
- **Tunnettu kulutus rakennukselle (optio).** Kun rakennukselle annetaan tunnettu vuosikulutus (oma kattila tai alamittari), sen tuntiprofiili skaalataan tähän summaan. Rakennusten tunnettu kulutus vähennetään piirin tai mittarin tiedosta: vuosi- ja kuukausisummista summana, tuntisarjasta tunneittain. Loppu kalibroidaan muille rakennuksille. Negatiiviset erotukset rajataan nollaan ja niistä varoitetaan.
- **Jako rakennuksille.** Piirin tunnittainen kokonaismäärä jaetaan rakennuksille niiden mallinnettujen osuuksien mukaan. Rakennuskohtaiset luvut ovat siksi arvioita, paitsi tunnetun kulutuksen rakennuksille.
- **Kattilan teho (optio).** Kun kattilan teho annetaan, piirin tunnittaista lämpötehoa verrataan siihen ja ylittävät tunnit raportoidaan. Laskuri raportoi vastaavan tilanteen lämmitysvajeena (K13–L13) [18].

## 9. Pörssihinnat

- **Lähde.** Hinnat haetaan Sähkötin-palvelusta, joka välittää Nord Poolin vuorokausimarkkinan FI-alueen hinnat yksikössä €/MWh ilman arvonlisäveroa ja UTC-aikaleimoilla [9].
- **15 minuutin markkina-aikayksikkö.** Eurooppalainen vuorokausimarkkina siirtyi 15 minuutin markkina-aikayksikköön 30.9.2025 [10]. Sähkötin palauttaa siitä alkaenkin tuntiarvoja, jotka ovat tunnin varttihintojen keskiarvoja (todettu 31.10.2026). Mahdolliset varttiarvot keskiarvoistetaan tunneiksi, kuten laskurin ohje edellyttää [18].
- **Tarkistus.** Vuoden 2025 sarjassa on 459 negatiivista tuntia, mikä vastaa laskurin omaa huomautusta [18]. Vuosi 2024 sisältää 8 784 tuntia, joista karkauspäivä poistetaan.
- **Käyttöehdot.** Sähkötin ilmoittaa ilmaisen rajapinnan olevan ei-kaupalliseen käyttöön ja Nord Poolin omistavan hintadatan [9]. Sovellus ei siksi sisällä hintoja, vaan käyttäjä hakee ne omaan tarkasteluunsa. Selaimesta suoraan haettavissa olevista lähteistä vain Sähkötin salli kutsut (CORS); Elering ja Energy-Charts eivät sallineet (todettu 31.10.2026).

## 10. Viennit laskuriin

| Tiedosto | Sarakkeet | Laskurissa |
|---|---|---|
| `oma_kulutusdata_<vuosi>.csv` | Tunti, Kk, Pv, Klo, Sähkö kWh/h, Lämpö kWh/h, Ulkolämpötila °C, (Pörssihinta €/MWh) | E–F → *Oma kulutusdata* E2, D4 = Oma data; H → *Hintahistoria*, vuoden sarake |
| `hintahistoria_2023-2026.csv` | Tunti, Aika (EET), 2023, 2024, 2025, 2026 | C–F → *Hintahistoria* C2 |

CSV-tiedostoissa on puolipiste-erotin, desimaalipilkku ja UTF-8 BOM suomenkielistä Exceliä varten. Laskurin oma aurinkosähkö- ja lämpöpumppulaskenta käyttää vielä laskurin esimerkkivuotta [18]. Ulkolämpötila viedään sarakkeeksi G myöhempää käyttöä varten.

## 11. Toteutus ja testaus

- **Kaksi toteutusta.** Sovellus on Python-palvelin (FastAPI) ja yhden tiedoston selainversio. Selainversion laskentamoottori (`web/engine.js`) antaa samat tulokset kuin Python-malli; `web/check_equivalence.py` vertaa niitä kahdeksassa skenaariossa (ero 0,000 kWh/h).
- **Automaattiset testit.** 37 testiä kattavat aikakannan, kesäajan, tiedostojen jäsennyksen, rajapintavastausten käsittelyn, kalibrointitavat, optiot, vientimuodot ja 3D-näkymän tiedostot (`pytest`). GitHub Actions ajaa testit ja vastaavuustarkistuksen jokaisesta muutoksesta.
- **Live-testit 31.10.2026.** MML (osoitehaku, kiinteistöhaku pisteellä ja tunnuksella, rakennukset, ortokuva), FMI (asemat, vuoden 2025 tuntisarja), Open-Meteo ja Sähkötin (2023–2026) testattiin oikeilla rajapinnoilla.
- **Kartta:** Leaflet 1.9.4 [24].
- **3D-näkymä:** MapLibre GL JS 5.24.0 [25] oletuksena, CesiumJS 1.146.0 [26] valinnaisena. Molemmat testattiin selaimessa (ohjelmistopohjainen WebGL): omalta levyltä avattu tiedosto, HTTP:llä jaettu tiedosto ja Python-palvelin.

### 3D-näkymä

- **Muoto.** Rakennuksen pohja on MML:n Maastotietokannan alue [2]. Pistemäinen kohde esitetään 10 × 10 m neliönä.
- **Korkeus** = kerrosluku × 3,5 m (oma oletus). Maastotietokannassa on kerrosluku muttei korkeutta; kattomuotoja ei mallinneta. Esimerkiksi yksikerroksinen kasvattamo on 3,5 m, vaikka harja on korkeampi.
- **Väri.** Laskennan jälkeen väri on lineaarinen asteikko rakennuksen mallinnetusta vuotuisesta lämmöntarpeesta tai sähkönkulutuksesta (luku 7) nollasta suurimpaan rakennukseen. Ennen laskentaa väri kertoo valinnan: lämpö, vain sähkö, kiinteistön muut rakennukset, naapurit.
- **Taustakuva** on MML:n ortokuva [1] (MML-avaimella) tai OpenStreetMap.
- **Maasto.** Rakennukset seisovat ellipsoidilla eli tasaisella maalla. Cesiumin oma maastomalli (Cesium ion) vaatisi erillisen tunnuksen ja lähettäisi pyyntöjä kolmannelle osapuolelle, joten sitä ei käytetä.
- **Lataus.** MapLibre sisältyy sovellukseen ja käynnistyy vasta, kun 3D-näkymä avataan. Cesium ladataan jsDelivr-palvelusta ensimmäisellä käytöllä. Cesiumin laskentasäikeet ovat ES-moduuleja, joita selain ei käynnistä levyltä avatulla sivulla (file://), joten siellä Cesium-valinta on pois käytöstä. MapLibre 6 olisi samasta syystä toiminut vain verkossa, joten käytössä on version 5 yhtenäinen paketti.

## 12. Kriittinen arvio

**Korjattu versiossa 0.4.0**

| Havainto | Vaikutus | Korjaus |
|---|---|---|
| Lämmittämättömien rakennusten sähkö (kuivuri, konehalli) kohdistui lämmitettyjen rakennusten profiilille | Väärä sähköprofiili mittaritason datalla | Rakennus voidaan ottaa mukaan vain sähköön tai vain lämpöön |
| Tyhjän broilerihallin lämmitys oli nolla | Lämmöntarve aliarvioitui erien välissä talvella | +8 °C jäätymisenesto (oma oletus) |
| Broilerihallin asetuslämpö oli oma oletus 32 → 21 °C / 35 vrk | Profiilin muoto | Aviagenin suositus 30 → 20 °C / 27 vrk [20] |
| Viljankuivuria ei voinut kuvata | Syyskuorma levisi koko vuodelle | Käyttötyyppi *Viljankuivuri* kausimaskilla |
| Vuosisumma ei kerro sää- ja perusosan suhdetta | Kesä–talvi-suhde mallin varassa | Optio *säästä riippumaton osuus* |
| Rakennusten jako yhteisellä kattilalla oli mallin varassa | Rakennuskohtaiset luvut | Optio *tunnettu kulutus* rakennukselle |
| Huipputehoa ei verrattu kattilaan | Liian piikikäs profiili jäi huomaamatta | Optio *kattilan teho* ja varoitus |
| Python- ja selainversiossa oli eri sääntö rakennuksen kuulumiselle kiinteistölle | Eri tulos samalla tilalla | Yhteinen painopistesääntö |

**Avoimet, vakavuusjärjestyksessä**

1. **Oletusparametreja ei ole validoitu** (suuri). H, ΔT_sis, q_perus, sähkön ominaiskulutukset ja profiilit ovat omia oletuksia. Ilman kulutustietoa tulos on vain suuntaa antava. Suositus: kalibroi oletukset 2–3 pilottitilan mitatulla tuntilämmöllä ja -sähköllä, ja johda eläinten lämmöntuotto CIGR:n yhtälöistä [19].
2. **Laskurin oma sää- ja PV-vuosi** (suuri). Laskurin lämpöpumpun COP ja aurinkosähkö käyttävät laskurin esimerkkivuotta [18], vaikka kulutus mallinnetaan tarkasteluvuoden säällä. Suositus: lisää laskuriin ulkolämpötilan ja PV-tuoton sarakkeet *Oma kulutusdata* -välilehdelle.
3. **Aitoa Datahub-tiedostoa ei ole testattu** (keskisuuri). Jäsennin on testattu tuotetuilla tiedostoilla. Suositus: testaa yhdellä oikealla latauksella.
4. **Polttoaineen määrän epävarmuus** (keskisuuri). Ostot eivät ole sama kuin poltto (varasto), ja hakkeen energiasisältö vaihtelee kosteuden mukaan. Pelletin ja öljyn energiasisällöt ovat tarkistamattomia likiarvoja.
5. **FMI:n tuntiarvon aikaleiman tulkinta** (pieni). Tunnin loppuun kohdistus on oletus. Väärä tulkinta siirtää lämpötilaa tunnilla.
6. **Aseman valinta** (pieni). Valinta tehdään pelkän etäisyyden perusteella, eikä korkeutta tai rannikkovaikutusta oteta huomioon.
7. **Mittausdatan laatu** (pieni). Tuntisarjasta ei tunnisteta katkoja, nollia eikä piikkejä.
8. **CSV-muoto** (pieni). Puolipiste ja desimaalipilkku sopivat suomenkieliseen Exceliin. Muulla kieliasetuksella tiedosto pitää tuoda Tiedot → Tekstistä/CSV:stä -toiminnolla.
9. **Kesken oleva vuosi** (pieni). Kuluvan vuoden säädata ei ole täydellinen, joten mallia ei voi ajaa ennen vuoden loppua. Hinnat voi silti hakea.
10. **API-avain ja käyttöehdot julkisessa palvelussa** (pieni). Selainversiossa jokainen käyttäjä tarvitsee oman MML-avaimen. Jos SEAMK tarjoaa sovellusta palveluna, Open-Meteon ja Sähkötinin ei-kaupallisen käytön ehdot on tarkistettava.
11. **3D-näkymän korkeudet ja maasto** (pieni). Korkeudet ovat arvioita eikä maastoa ole. Näkymä havainnollistaa kulutuksen jakautumista, mutta sitä ei pidä käyttää esimerkiksi aurinkopaneelien varjostuksen arviointiin. Suositus: MML:n laserkeilausaineistosta voisi johtaa todelliset korkeudet ja kattomuodot.

## 13. Lähdeluettelo

Verkkosivujen sisältö ja rajapintojen toiminta on tarkistettu 31.10.2026, ellei toisin mainita.

**[1] Maanmittauslaitos. Avoimien aineistojen lisenssi (CC BY 4.0) ja rajapintapalvelut.**  
https://www.maanmittauslaitos.fi/en/opendata-licence-cc40 · API-avaimen ohje: https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje  
Käyttö: MML-aineistojen käyttöehdot ja API-avain. Lähdemaininta: "Sisältää Maanmittauslaitoksen Maastotietokannan ja kiinteistörekisterikartan aineistoa".

**[2] Maanmittauslaitos. Technical description – Topographic Database (OGC API Features).**  
https://maanmittauslaitos.fi/en/node/13248 · Rajapinta: https://avoin-paikkatieto.maanmittauslaitos.fi/maastotiedot/features/v1/  
Käyttö: rakennusten haku; CRS84 oletuskoordinaatistona; `kohdeluokka`-ominaisuus (esim. 42211 asuinrakennus 1–2 krs).

**[3] Maanmittauslaitos. Kiinteistötietojen avoin kyselypalvelu (OGC API Features), kokoelma PalstanSijaintitiedot.**  
https://avoin-paikkatieto.maanmittauslaitos.fi/kiinteisto-avoin/simple-features/v3/  
Käyttö: kiinteistön palstat kiinteistötunnuksella ja pisteellä.

**[4] Ilmatieteen laitos. Avoimen datan lisenssi (CC BY 4.0).**  
https://en.ilmatieteenlaitos.fi/open-data-licence  
Käyttö: havaintoasemien ja tuntilämpötilojen käyttöehdot.

**[5] Ilmatieteen laitos. Avoimen datan WFS-palvelu.**  
https://opendata.fmi.fi/wfs  
Käyttö: tallennetut kyselyt `fmi::ef::stations` (verkko 121) ja `fmi::observations::weather::hourly::simple` (parametri TA_PT1H_AVG); enintään 744 tuntia kyselyä kohti.

**[6] Hersbach, H., Bell, B., Berrisford, P., et al. (2020). The ERA5 global reanalysis. Quarterly Journal of the Royal Meteorological Society, 146(730), 1999–2049.**  
https://doi.org/10.1002/qj.3803  
Käyttö: Open-Meteon historiallisen säädatan taustalla oleva uudelleenanalyysi.

**[7] Zippenfenig, P. (2023). Open-Meteo.com Weather API. Zenodo.**  
https://doi.org/10.5281/zenodo.7970649 · https://open-meteo.com/en/docs/historical-weather-api  
Käyttö: ulkolämpötila tilan kohdalla ja FMI-sarjan aukkojen paikkaus.

**[8] Open-Meteo. Licence and terms.**  
https://open-meteo.com/en/licence  
Käyttö: data CC BY 4.0; ilmainen API ei-kaupalliseen käyttöön. (Sivua ei voitu avata tarkistuksessa; ehdot on tarkistettava ennen julkista palvelua.)

**[9] Pakastin Oy. Sähkötin – API.**  
https://sahkotin.fi/api · Hintasarja: https://sahkotin.fi/prices.csv  
Käyttö: FI-alueen pörssihinnat €/MWh alv 0. Palvelu ilmoittaa ilmaisen API:n olevan ei-kaupalliseen käyttöön ja Nord Poolin omistavan hintadatan (kuvaus laskurin ohjeen mukaan [18]).

**[10] Nord Pool. Transition to 15-minute Market Time Unit (MTU).**  
https://www.nordpoolgroup.com/en/trading/transition-to-15-minute-market-time-unit-mtu/  
Käyttö: eurooppalaisen vuorokausimarkkinan 15 minuutin markkina-aikayksikön käyttöönotto 30.9.2025.

**[11] Fingrid Datahub Oy. Datahubin asiakasportaali.**  
https://oma.datahub.fi/  
Käyttö: käyttäjän oman sähkönkulutuksen tuntidata.

**[12] Euroopan parlamentin ja neuvoston direktiivi 2000/84/EY kesäaikasäännöksistä.**  
https://eur-lex.europa.eu/legal-content/FI/TXT/?uri=CELEX:32000L0084  
Käyttö: kesäajan alkamis- ja päättymissääntö paikallisen ajan muunnoksessa.

**[13] Tilastokeskus (2024). Polttoaineluokitus 2024 ja polttoainenimikkeiden määritelmät, 2.2.2024.**  
https://www2.stat.fi/media/uploads/tup/khkinv/polttoaineluokitus_2024__maaritelmat.pdf  
Käyttö: kokopuu- tai rankahakkeen tyypilliset ominaisuudet käyttötilassa (kosteus 40–55 %, lämpöarvo 7–11 GJ/t).

**[14] Alakangas, E., Hurskainen, M., Laatikainen-Luntama, J. & Korhonen, J. (2016). Suomessa käytettävien polttoaineiden ominaisuuksia. VTT Technology 258. Espoo: VTT.**  
ISBN 978-951-38-8419-2 · https://sarjaweb.vtt.fi/pdf/technology/2016/T258.pdf  
Käyttö: polttoaineiden energiasisältöjen taustalähde. Lukuja ei ole poimittu tähän versioon.

**[15] Fels, M. F. (1986). PRISM: An introduction. Energy and Buildings, 9(1–2), 5–18.**  
https://doi.org/10.1016/0378-7788(86)90003-4  
Käyttö: lämmitystarveluku- ja energiasignatuurimallin periaate (kulutus = perusosa + kerroin × lämmitystarve tasapainolämpötilan alapuolella).

**[16] Sinnott, R. W. (1984). Virtues of the Haversine. Sky and Telescope, 68(2), 159.**  
Käyttö: isoympyräetäisyys säähavaintoasemille.

**[17] Seinäjoen ammattikorkeakoulu. dkk-flightmanager (versio 1.11.1).**  
https://github.com/SeAMKedu/dkk-flightmanager  
Käyttö: MML-rakennushaun rajapinta, kohdeluokkien ryhmittely ja kiinteistötunnuksen käsittely.

**[18] Karirinne, S. & Jääskeläinen, M. (2026). Maatilan hybridienergialaskuri, versio 0.9.3, ja Excel-mallin käyttöohje. Seinäjoen ammattikorkeakoulu, EIP CHP Energiaälykäs eteläpohjalainen maatila. CC BY 4.0.**  
Käyttö: aikakanta, *Oma kulutusdata*- ja *Hintahistoria*-välilehtien rakenne, hakkeen energiatiheys (K35), kattilan hyötysuhde (C26), pörssihintojen käsittely.

**[19] CIGR (2002). Climatization of animal houses: Heat and moisture production at animal and house levels. Pedersen, S. & Sällvik, K. (toim.). CIGR Section II, 4th Report of Working Group. Research Centre Bygholm, Danish Institute of Agricultural Sciences, Horsens.**  
Raportin olemassaolo ja aihe vahvistettu lähteestä: Aarnink, A. (2018). Heat and moisture production in growing-finishing pigs and broilers. *Agricultural Engineering International: CIGR Journal*, Special Issue, Article 4781, https://cigrjournal.org/index.php/Ejounral/article/view/4781  
Käyttö: taustalähde eläinten lämmöntuotolle; mallin kertoimia ei ole johdettu tästä lähteestä (ks. luku 12).

**[20] Aviagen (2025). Ross Broiler Management Handbook.**  
https://aviagen.com/assets/Tech_Center/Ross_Broiler/Aviagen-ROSS-Broiler-Handbook-EN.pdf  
Käyttö: broilerihallin asetuslämpö: koko hallin lämmityksessä 30 °C sisäänotossa (Key Management Timetable), 20 °C painon noin 1,5 kg jälkeen (taulukko 2.4) ja 27 vuorokauden iän jälkeen 20 °C.

**[21] Lawson, C. L. & Hanson, R. J. (1974). Solving Least Squares Problems. Englewood Cliffs: Prentice-Hall.**  
Käyttö: ei-negatiivisten kertoimien pienimmän neliösumman sovitus (tässä kahden muuttujan tapaus).

**[22] ASHRAE (2014). Guideline 14-2014: Measurement of Energy, Demand, and Water Savings. Atlanta: ASHRAE.**  
Käyttö: kalibroinnin CV(RMSE)-kriteerit (kuukausi 15 %, tunti 30 %).

**[23] Goldwasser, D., Ball, B., Farthing, A., Frank, S. & Im, P. (2018). Advances in Calibration of Building Energy Models to Time Series Data. NREL/CP-5500-70865. 2018 ASHRAE Building Performance Analysis Conference and SimBuild.**  
https://www.nrel.gov/docs/fy19osti/70865.pdf  
Käyttö: Guideline 14:n tuntitason kriteerien vahvistus (CV(RMSE) < 30 %, NMBE < 10 %).

**[24] Agafonkin, V. ym. Leaflet 1.9.4. BSD-2-Clause.**  
https://leafletjs.com/  
Käyttö: kartan esitys (sisältyy sovellukseen).

**[25] MapLibre-yhteisö. MapLibre GL JS 5.24.0. BSD-3-Clause.**  
https://maplibre.org/  
Käyttö: 3D-näkymä, oletus (sisältyy sovellukseen).

**[26] Cesium GS. CesiumJS 1.146.0. Apache-2.0.**  
https://cesium.com/platform/cesiumjs/  
Käyttö: 3D-näkymä, valinnainen (ladataan jsDelivr-palvelusta käytön aikana).

## 14. Tekoälyn käyttö

Sovelluksen koodin, testien ja tämän dokumentin laatimisessa on käytetty tekoälyä tekijöiden työvälineenä. Lähteet on haettu ja niiden keskeiset tiedot tarkistettu verkosta 31.10.2026. Lähteet, joiden sisältöä ei voitu tarkistaa, on merkitty erikseen. Tekoälyn käyttö ei itsessään varmista laskennan oikeellisuutta: tarkistukset, lähtötiedot ja mallin rajaukset ratkaisevat tulosten käyttökelpoisuuden.
