# Muutokset

## 0.7.2 – 2026-11-26

- **Taustakartta on oletuksena OpenStreetMap.** MML:n ortokuvan tai taustakartan voi valita oikeasta yläkulmasta MML-avaimella; valinta muistetaan selaimessa, ja 3D-näkymä käyttää ortokuvaa, kun se on valittu.
- Hakukenttä on nimenomaisesti tekstikenttä (`type="text"`, `inputmode="text"`), jotta Android avaa kirjainnäppäimistön.

## 0.7.1 – 2026-11-26

- **Hakukenttä avaa tavallisen näppäimistön.** Kenttä oli merkitty numerokentäksi, joten puhelin avasi vain numeronäppäimet eikä osoitetta voinut kirjoittaa. Kenttä hyväksyy osoitteen tai kiinteistötunnuksen.
- **Osoitehaku myös Python-palvelinversiossa** (`/api/geocode`, MML:n osoitehaku).
- **Kiinteistön valinta kartalta korjattu:** klikkaus jo piirretyn rakennuksen päällä valitsee kiinteistön eikä vaihda rakennuksen valintaa; valinta palauttaa 3D-näkymästä kartalle ja vierittää kartan näkyviin puhelimella; haun aikana näkyy ilmoitus.

## 0.7.0 – 2026-11-24

- **Rakennusten koko ja kattomuoto laserkeilauksesta.** Valituille rakennuksille haetaan MML:n avoin Laserkeilausaineisto 0,5 p (Paikkatiedon tiedostopalvelu, OGC API Processes) ja lasketaan selaimessa: räystään ja harjan korkeus, kattomuoto ja -kaltevuus, tilavuus sekä pohjan ala keilauksen mukaan verrattuna MML:n pohjaan (laajennus, purettu rakennus). Asuin- ja toimistorakennuksille arvio kerrosluvusta ja painike lämmitetyn alan päivittämiseen. 3D-näkymä piirtää mitatut katot.
- LAZ-purku laz-perf-kirjastolla (WebAssembly, Apache-2.0); Python-palvelinversiossa palvelin välittää MML:n pyynnöt (`/api/lidar/...`).
- Testit: synteettinen pistepilvi ja Node-testit kattomuodon tunnistukselle; palvelimen välitys Python-testeissä.

## 0.6.0 – 2026-11-04

Energianeuvojan näkökulmasta tehdyn käyttöliittymäarvion (4.11.2026) korjaukset.

- **Lämmitystapa** lämmitysjärjestelmälle: kattila, kaukolämpö, sähkölämmitys tai lämpöpumppu (SCOP). Lämmityssähkö erotetaan sähkömittarin kulutuksesta, joko alamittarin lukemasta tai sovittamalla mittarin tieto lämmitys-, ilmanvaihto- ja perusosaan. Viennin sähkösarake on muu sähkö, ettei lämmitystä lasketa laskurissa kahteen kertaan. Nykyinen lämmityssähkö raportoidaan erikseen.
- **Pysyvyyskäyrät** lämpö- ja sähköteholle; lämmitysteho viivana ja ylittävät tunnit.
- **kWh/m²** rakennuksittain ja poikkeavan arvon merkintä.
- **Uusi projekti** -painike tyhjentää luonnoksen.
- Korjattu: tarkistuslistan "Kulutustiedot annettu" ennen valintoja; negatiivinen ja nolla-ala; käsin lisätyn rakennuksen oletusala ja nimi; vuoden vaihdon jälkeinen tuntitiedostokortti; ilmoitukset pinoutuvat eivätkä peitä tuloksia; rakennus poistuu laskennasta vain valintaruudusta; *Laske uudelleen* ei enää jää reagoimatta, kun kentän muokkaus päättyy painikkeen klikkaukseen.
- Saavutettavuus: yksikkövalinnan ja painikeryhmien nimet ja tila (axe-core: ei WCAG A/AA -rikkeitä).
- Käsite *lämmityspiiri* on käyttöliittymässä *lämmitysjärjestelmä*.
- Ilme SEAMKin brändikäsikirjan 2025/03 mukaan (seamk-brandi): vain viralliset värit ja niiden vaalennukset. Lämpö piirretään vihreällä lisävärillä tummalla ääriviivalla (aiemmin tiimin ehdotusväri terrakotta), huomautukset mustalla tekstillä keltaisella ja virheet pinkillä. Otsikot tiiviillä groteskilla isoin kirjaimin; korvikefontti Barlow Condensed (SIL OFL) tulee sovelluksen mukana. SEAMK-tunnukselle on paikka, joka täyttyy vain virallisella tiedostolla.

## 0.5.0 – 2026-11-01 (ensimmäinen julkinen versio)

- Julkaisumetatiedot: `CITATION.cff`, `.zenodo.json`, tekijät ORCID-tunnisteineen; lisenssin haltijana Seinäjoen ammattikorkeakoulu.
- GitHub Actions: testit ja selainversion julkaisu GitHub Pagesiin.
- Selkeämpi ilmoitus, kun säätiedoista puuttuu tunteja (esim. kesken oleva vuosi). Puuttuvat tunnit näytetään tarkistuslistassa.
- README kirjoitettu käyttöohjeeksi: ennakkovaatimukset, vaiheet, vienti laskuriin, ongelmatilanteet, tietosuoja, viittaaminen ja tekijöiden panos.
- Ulkoasu SEAMKin brändikäsikirjan mukaan: lila #542583 pääväri ja ensisijaiset toiminnot, keltainen #FFF023 brändiraita, otsikot Alte DIN 1451 Mittelschrift (varalla Bahnschrift), leipäteksti Arial. Lämpö, valmis ja huomautus Maatalous ja energia -tutkimusryhmän väreillä. Kaikki tekstiparit WCAG AA -kontrastissa, myös tummassa tilassa.
- Sivu vierii vaiheiden mukana ja kartta pysyy näkyvissä niiden vieressä. Painikkeet ja kentät 32–40 px, näkyvä fokus, tilamerkit tekstinä eikä väripisteinä.
- Nimi kirjoitetaan SEAMK; tekijöiden affiliaatioon lisätty Maatalous ja energia -tutkimusryhmä.
- 3D-näkymä: rakennukset kolmiulotteisina ilmakuvan päällä, väri mallinnetun lämmöntarpeen tai sähkön mukaan. Oletuksena MapLibre GL JS 5.24.0 (mukana sovelluksessa), vaihtoehtona CesiumJS 1.146.0 (ladataan jsDelivristä, vain verkossa julkaistussa versiossa). Korkeus arvioidaan kerrosluvusta.
- Rakennusta klikkaamalla se tulee mukaan laskentaan tai poistuu siitä myös 3D-näkymässä; ponnahdusikkuna ja työkaluvihje kertovat tilan. Kun valinnat muuttuvat, edellinen tulos jää näkyviin himmennettynä ja *Laske uudelleen* -painikkeen kanssa, joten kartta ei hyppää.

## 0.4.1 – 2026-10-31

- Testitilan tiedot poistettu esimerkeistä ja dokumentaatiosta; testit käyttävät keksittyä kiinteistötunnusta.
- Google Fonts poistettu (järjestelmäfontit). Leafletin lisenssiteksti mukana kokonaisuudessaan.

## 0.4.0 – 2026-10-31

- Optiot: tunnettu kulutus rakennukselle, säästä riippumaton osuus vuosisummalle, kattilan tehon tarkistus.
- Rakennuksen voi ottaa mukaan vain sähköön tai vain lämpöön. Uusi käyttötyyppi: viljankuivuri.
- Broilerihallin asetuslämpö Aviagenin käsikirjan mukaan (30 → 20 °C / 27 vrk); tyhjä halli +8 °C.
- Menetelmä- ja lähdedokumentti, myös sovelluksen sisällä.

## 0.3.0 – 2026-10-31

- Pörssihinnat (Sähkötin) ja CSV-viennit laskurin *Hintahistoria*-välilehdelle.

## 0.2.0 – 2026-10-31

- Selainversio yhtenä HTML-tiedostona; osoitehaku.

## 0.1.0 – 2026-10-31

- Ensimmäinen versio: rakennushaku (MML), kulutustiedot, säätiedot (FMI, Open-Meteo), kalibroitu tuntiprofiili, vienti laskuriin.
