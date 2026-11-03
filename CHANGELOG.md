# Muutokset

## 0.5.0 – 2026-11-01 (ensimmäinen julkinen versio)

- Julkaisumetatiedot: `CITATION.cff`, `.zenodo.json`, tekijät ORCID-tunnisteineen; lisenssin haltijana Seinäjoen ammattikorkeakoulu.
- GitHub Actions: testit ja selainversion julkaisu GitHub Pagesiin.
- Selkeämpi ilmoitus, kun säätiedoista puuttuu tunteja (esim. kesken oleva vuosi). Puuttuvat tunnit näytetään tarkistuslistassa.
- README kirjoitettu käyttöohjeeksi: ennakkovaatimukset, vaiheet, vienti laskuriin, ongelmatilanteet, tietosuoja, viittaaminen ja tekijöiden panos.
- Ulkoasu SEAMKin brändikäsikirjan mukaan: lila #542583 pääväri ja ensisijaiset toiminnot, keltainen #FFF023 brändiraita, otsikot Alte DIN 1451 Mittelschrift (varalla Bahnschrift), leipäteksti Arial. Lämpö, valmis ja huomautus Maatalous ja energia -tutkimusryhmän väreillä. Kaikki tekstiparit WCAG AA -kontrastissa, myös tummassa tilassa.
- Sivu vierii vaiheiden mukana ja kartta pysyy näkyvissä niiden vieressä. Painikkeet ja kentät 32–40 px, näkyvä fokus, tilamerkit tekstinä eikä väripisteinä.
- Nimi kirjoitetaan SEAMK; tekijöiden affiliaatioon lisätty Maatalous ja energia -tutkimusryhmä.
- 3D-näkymä: rakennukset kolmiulotteisina ilmakuvan päällä, väri mallinnetun lämmöntarpeen tai sähkön mukaan. Oletuksena MapLibre GL JS 5.24.0 (mukana sovelluksessa), vaihtoehtona CesiumJS 1.146.0 (ladataan jsDelivristä, vain verkossa julkaistussa versiossa). Korkeus arvioidaan kerrosluvusta.

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
