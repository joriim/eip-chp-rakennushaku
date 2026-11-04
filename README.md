# Rakennushaku

Rakennushaku muodostaa maatilan rakennuksille tunnittaisen sähkö- ja lämpöprofiilin **Maatilan hybridienergialaskuriin**. Profiili perustuu avoimeen paikkatietoon, tilan omaan kulutustietoon ja saman vuoden säähavaintoihin.

**Versio 0.6.0 · prototyyppi** · EIP CHP Energiaälykäs eteläpohjalainen maatila · SEAMK, Maatalous ja energia -tutkimusryhmä

- **Käytä selaimessa:** https://seamkedu.github.io/Rakennushaku/ (GitHub Pages; vaatii Pages-julkaisun, ks. *Kehitys*), tai avaa tiedosto [`web/rakennushaku.html`](web/rakennushaku.html) omalla koneella.
- **Menetelmät, oletukset ja lähteet:** [docs/MENETELMAT_JA_LAHTEET.md](docs/MENETELMAT_JA_LAHTEET.md)
- **Muutokset:** [CHANGELOG.md](CHANGELOG.md)

> **Prototyyppi.** Mallin oletusparametrit ovat tekijöiden omia oletuksia, eikä niitä ole validoitu mitatuilla tiloilla. Tulos kuvaa tilaa vain, kun sille annetaan tilan oma kulutustieto. Rajoitukset on lueteltu menetelmädokumentin luvussa 12.

## Mitä sovellus tekee

1. Hakee tilan rakennukset Maanmittauslaitoksen Maastotietokannasta kiinteistötunnuksella, osoitteella tai kartalta.
2. Käyttäjä valitsee rakennukset, joiden lämpö ja sähkö lasketaan, ja tarkistaa niiden käyttötarkoituksen ja pinta-alan.
3. Malli laskee rakennuksille tunnittaisen lämmön- ja sähkönkulutuksen ulkolämpötilan mukaan ja kalibroi tason tilan omaan vuosi-, kuukausi- tai tuntitietoon.
4. Tulokset, ulkolämpötila ja halutessa pörssihinnat viedään CSV-tiedostona laskurin *Oma kulutusdata*- ja *Hintahistoria*-välilehdille.

Kaikki laskenta tehdään käyttäjän selaimessa. Kulutustiedot eivät lähde koneelta.

## Käyttöohje

### Ennen aloitusta

- **MML:n API-avain.** Kiinteistö- ja rakennushaku tarvitsee Maanmittauslaitoksen ilmaisen API-avaimen: https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje. Liitä avain sovelluksen yläpalkkiin. Avain tallennetaan vain kyseiseen selaimeen. Ilman avainta rakennukset voi lisätä kartalle käsin.
- **Kulutustiedot samalta vuodelta.** Hyvä tarkasteluvuosi on viimeisin päättynyt vuosi. Tarvitset jonkin näistä:
  - sähkö: vuosikulutus laskulta tai Datahubin tuntidata (https://oma.datahub.fi/ → kulutustiedot → lataa CSV)
  - lämpö: vuoden hakkeen, pelletin tai öljyn käyttö, kuukausikulutukset tai lämpömittarin tuntidata
- **Laskuri.** Maatilan hybridienergialaskuri (versio 0.9.3 tai uudempi).

### Vaiheet

1. **Tila.** Kirjoita kiinteistötunnus (muodossa KKK-RRR-YYYY-XXXX) tai osoite ja paina *Hae*. Vaihtoehtoisesti valitse kiinteistö kartalta tai hae rakennukset pisteen ympäriltä (250 m).
2. **Rakennukset laskentaan.** Asuinrakennus ja vähintään 600 m²:n maatalousrakennukset on valittu ehdotuksina. Tarkista jokaisesta rakennuksesta:
   - **Käyttö**, esim. broilerikasvattamo, lihasikala, navetta, asuinrakennus tai viljankuivuri.
   - **Lämmitetty ala.** Lähtöarvo on pohjan ala × kerrokset, koska MML:n aineistossa ei ole kerrosalaa.
   - **Mukana:** *lämpö ja sähkö*, *vain lämpö* tai *vain sähkö*. Ota esimerkiksi kuivuri tai konehalli mukaan vain sähköön, jos se on samassa liittymässä.
   - **Broilerikasvattamon erärytmi.** Anna halleille eri sisäänottopäivät, jos ne ovat eri vaiheessa.
   - **Tunnettu kulutus** (valinnainen), jos rakennuksella on oma kattila tai alamittari.
3. **Nykyinen kulutus.** Anna kulutus lämmitysjärjestelmittäin (kattila tai lämpöpumppu ja sen rakennukset) ja sähkömittareittain, koska tieto tulee laskuilta ja mittareilta:
   - *Lämmitystapa*: kattila (hake, pelletti, öljy), kaukolämpö, sähkölämmitys tai lämpöpumppu (SCOP, oletus 3,0). Sähkölämmityksen ja lämpöpumpun lämmityssähkö erotetaan valitun sähkömittarin kulutuksesta, joten anna mittarille liittymän koko kulutus. Jos lämmityssähköä ei mitata erikseen, jätä lämmitysjärjestelmälle *Ei tietoa*: osuus erotetaan mittarin tiedoista (kuukausitiedoilla luotettavasti, pelkällä vuosisummalla mallin oletusten varassa).
   - *Vuosi*: määrä ja yksikkö. Polttoaine muunnetaan lämmöksi hyötysuhteella (oletus 0,85). Valinnaisesti voi antaa säästä riippumattoman osuuden (käyttövesi, pesut).
   - *Kuukaudet*: vähintään kolme kuukautta.
   - *Tuntitiedosto*: Datahubin tai mittarin CSV. Vartit summataan tunneiksi ja kesäaika käsitellään.
   - *Kattilan teho* (valinnainen): sovellus varoittaa, jos mallin huipputeho ylittää sen.
4. **Säätiedot.** Valitse lähin Ilmatieteen laitoksen asema, Open-Meteon arvio tilan kohdalla tai oma lämpötilatiedosto.
5. **Sähkön pörssihinta** (valinnainen). Hae tarkasteluvuoden hinnat tai kaikki laskurin vuodet 2023–2026.
6. **Energiaprofiili.** Paina *Laske tuntiprofiili*. Tarkista:
   - **pysyvyyskäyrä**: kuinka monta tuntia vuodessa teho ylittää tietyn tason; annettu lämmitysteho näkyy viivana,
   - **kWh/m²** rakennuksittain: poikkeava arvo kertoo yleensä väärästä alasta tai käyttötyypistä,
   - kalibroinnin sopivuus ja varoitukset.

   Lataa sen jälkeen CSV tai kopioi sarakkeet. Jos muutat valintoja, edellinen tulos jää himmennettynä näkyviin, kunnes painat *Laske uudelleen*. **Uusi projekti** tyhjentää kaiken seuraavaa asiakasta varten (tallenna ensin, jos tarvitset nykyistä).

**3D-näkymä.** Kartan yläpuolelta *3D* näyttää rakennukset kolmiulotteisina ilmakuvan päällä. Korkeus on arvio (kerrokset × 3,5 m). Laskennan jälkeen väri kertoo rakennuksen mallinnetun vuotuisen lämmöntarpeen tai sähkönkulutuksen; ennen sitä väri näyttää valitut rakennukset. Rakennusta klikkaamalla näkyvät sen luvut.
- *MapLibre GL* on oletus ja toimii myös omalta koneelta avattuna.
- *Cesium* on vaihtoehto, joka näyttää maapallon ja vapaamman kameran. Se ladataan ensimmäisellä käytöllä jsDelivr-palvelusta (noin 5 Mt) ja toimii vain verkossa julkaistussa versiossa tai Python-palvelimella, ei omalta levyltä avattuna.
- 3D vaatii selaimen WebGL-tuen. Vanhoilla koneilla kartta voi olla hidas; työvaiheet tehdään 2D-kartalla.

### Vienti laskuriin

| Tiedosto | Sarakkeet | Minne laskurissa |
|---|---|---|
| `oma_kulutusdata_<vuosi>.csv` | A Tunti, B Kk, C Pv, D Klo, E Sähkö kWh/h (ilman lämmityssähköä), F Lämpö kWh/h, G Ulkolämpötila °C, H Pörssihinta €/MWh (jos haettu) | E–F → *Oma kulutusdata* E2 ja Ohjauspaneelin D4 = *Oma data*; H → *Hintahistoria*-välilehden vuoden sarake, K22 = *Pörssihinta*, K49 = vuosi |
| `hintahistoria_2023-2026.csv` | A Tunti, B Aika (EET), C–F vuodet 2023–2026 | C–F → *Hintahistoria* C2 |

Liitä aina valinnalla **Liitä määräten → Arvot**. Rivi 2 on 1.1. klo 00–01 ja rivi 8 761 on 31.12. klo 23–24 (kiinteä EET, ei kesäaikaa, karkauspäivä poistettu).

### Ongelmatilanteet

| Ilmoitus tai oire | Syy ja ratkaisu |
|---|---|
| "rajapinta hylkäsi pyynnön (401/403)" | MML-avain puuttuu tai on virheellinen. Tarkista avain yläpalkista. |
| Taustakartta on tyhjä ilman MML-avainta | OpenStreetMapin karttatiilet voivat estyä, kun tiedosto avataan omalta koneelta. Lisää MML-avain (ortokuva) tai käytä julkaistua sivua. |
| "Ulkolämpötilasarjasta puuttuu … tuntia" | Vuosi on kesken tai asemalta puuttuu dataa. Valitse päättynyt vuosi, toinen asema tai Open-Meteo. |
| "Kulutustieto puuttuu … (tulos on mallin oletus)" | Piirille tai mittarille ei ole annettu kulutusta. Tulos ei silloin kuvaa tilaa. |
| Huipputeho ylittää kattilan tehon | Profiili on liian piikikäs (esim. broilerierät samaan aikaan) tai kattilan teho on väärä. |
| "3D-näkymä ei käynnistynyt" | Selain tai näytönohjain ei tue WebGL:ää, tai Cesiumia ei saatu ladattua (verkkoyhteys, palomuuri). Käytä MapLibre GL:ää tai 2D-karttaa. |
| Cesium-vaihtoehto on harmaa | Tiedosto on avattu omalta levyltä. Cesium toimii julkaistulla sivulla tai Python-palvelimella. |
| CSV avautuu yhteen sarakkeeseen | Excelin kieliasetus ei ole suomi. Tuo tiedosto: Tiedot → Tekstistä/CSV:stä, erotin puolipiste. |

### Tietosuoja

Sovellus ei tallenna eikä lähetä kulutustietoja minnekään. Rajapinnoille lähtevät vain sijainti, kiinteistötunnus, osoitehakuteksti ja vuosi. Keskeneräinen työ, 3D-näkymän valinnat ja MML-avain säilyvät vain käyttäjän selaimessa. Jos 3D-näkymässä valitaan Cesium, selain lataa kirjaston jsDelivr-palvelusta (cdn.jsdelivr.net), joka näkee käyttäjän IP-osoitteen; tilan tietoja sinne ei lähetetä. Projektin voi tallentaa JSON-tiedostoksi omalle koneelle.

## Python-versio

Sama sovellus paikallisena palvelimena (FastAPI). Rajapintakutsut tehdään palvelimelta, ja MML-avain pysyy palvelimella. Osoitehaku on vain selainversiossa.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e .
cp .env.example .env               # lisää MML_API_KEY
rakennushaku                       # avaa http://127.0.0.1:8765/
```

## Kehitys

```bash
pip install -e .[test]
pytest                             # automaattiset testit
python web/check_equivalence.py    # selain- ja Python-moottori antavat samat tulokset (vaatii Node.js)
python web/build.py                # rakentaa web/rakennushaku.html
python docs/build_docs.py          # päivittää menetelmädokumentin (HTML vaatii pandocin)
```

- **Rakenne:** `src/rakennushaku/` sisältää Python-mallin, rajapinnat ja käyttöliittymän (`static/`). `web/engine.js` on mallin selainversio, ja `web/build.py` kokoaa yhden tiedoston sovelluksen. `docs/` sisältää menetelmät ja lähteet, `tests/` testit.
- **Rinnakkaiset toteutukset:** mallin muutokset tehdään sekä tiedostoon `src/rakennushaku/model.py` että `web/engine.js`, ja tarkistetaan komennolla `check_equivalence.py`.
- **Automaatio:** GitHub Actions ajaa testit jokaisesta muutoksesta ja julkaisee selainversion GitHub Pagesiin. Pages otetaan käyttöön kerran: *Settings → Pages → Source: GitHub Actions*.

## Viittaaminen

Viittaa ohjelmistoon tiedoston [CITATION.cff](CITATION.cff) tiedoilla. Zenodo-julkaisun jälkeen pysyvä DOI lisätään tähän.

Jääskeläinen, M. & Karirinne, S. (2026). *Rakennushaku: tilan rakennukset ja tunnittainen energiaprofiili Maatilan hybridienergialaskuriin* (versio 0.6.0) [Tietokoneohjelma]. Seinäjoen ammattikorkeakoulu. https://github.com/SeAMKedu/Rakennushaku

## Tekijät ja tekijöiden panos

- **Miiro Jääskeläinen** (ORCID [0000-0002-0683-8352](https://orcid.org/0000-0002-0683-8352)), Seinäjoen ammattikorkeakoulu. Hankkeen projektipäällikkö. Määritteli sovelluksen tarpeen, käyttötapauksen ja vaatimukset (rakennusten tunnistus, kulutustietojen sovitus, säätiedot, pörssihinnat, viennit laskuriin, kalibrointioptiot ja dokumentointi). Ohjasi kehitystä, arvioi välitulokset ja testasi sovelluksen oikeilla rajapinnoilla.
- **Suvi Karirinne** (ORCID [0000-0003-1000-557X](https://orcid.org/0000-0003-1000-557X)), Seinäjoen ammattikorkeakoulu. Maatilan hybridienergialaskurin tekijä. Laskurin tietorakenteet, aikakanta ja oletukset ovat Rakennushaun vientien ja muunnosten perusta.

Koodi, testit ja dokumentaatio on tuotettu tekoälyavusteisesti (Claude, Anthropic) tekijöiden ohjauksessa. Tekoälyn käyttö ei itsessään varmista laskennan oikeellisuutta. Menetelmädokumentti erottelee lähteeseen perustuvat arvot omista oletuksista.

## Hanke ja rahoitus

Laadittu EIP CHP Energiaälykäs eteläpohjalainen maatila -hankkeessa. Hankkeen toteuttavat Seinäjoen ammattikorkeakoulu, Suomen metsäkeskus ja Veljekset Ala-Talkkari Oy. Hanke on Euroopan unionin osarahoittama.

## Lisenssit ja tietolähteet

- **Koodi:** MIT ([LICENSE](LICENSE)), © Seinäjoen ammattikorkeakoulu. Mukana: Leaflet 1.9.4 (BSD-2-Clause) ja MapLibre GL JS 5.24.0 (BSD-3-Clause). Valinnaisena verkosta ladattava CesiumJS 1.146.0 (Apache-2.0).
- **Data** haetaan käyttäjälle rajapinnoista eikä sisälly repoon:
  - Maanmittauslaitos (CC BY 4.0)
  - Ilmatieteen laitos (CC BY 4.0)
  - Open-Meteo (CC BY 4.0; ilmainen rajapinta ei-kaupalliseen käyttöön)
  - Sähkötin / Nord Pool (ilmainen rajapinta ei-kaupalliseen käyttöön; Nord Pool omistaa hintadatan)

  Lähteet ja viitteet: [docs/MENETELMAT_JA_LAHTEET.md](docs/MENETELMAT_JA_LAHTEET.md).
