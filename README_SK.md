# StreamPlay

[English](README.md) | **Slovenčina**

Zrkadlenie obrazovky a zvuku z Windows PC na Chromecast alebo Android TV cez domácu Wi-Fi. Na TV sa nič neinštaluje a obraz so zvukom ostávajú zosynchronizované.

## Požiadavky

- Windows 10 alebo 11 (64-bitový).
- TV alebo zariadenie s **vstavaným Chromecastom (Google Cast)**. Má ho väčšina Android TV a Google TV, a tiež Chromecast kľúče. Ak sa TV zobrazí v ponuke *Prenášať…* v Chrome, bude fungovať aj tu.
- PC a TV musia byť v rovnakej sieti (nie v hosťovskej sieti a bez „izolácie klientov“ na routeri).

StreamPlay som vyvíjal a testoval na Windows 10 s grafikou NVIDIA a jednej Android TV (TCL). Iné TV alebo grafiky by mali fungovať, ale správanie sa môže líšiť.

## Spustenie

Stiahni si jeden zo súborov zo sekcie **[Releases](../../releases/latest)**:

| Súbor | Čo to je |
|---|---|
| **[StreamPlay-Setup.exe](../../releases/latest/download/StreamPlay-Setup.exe)** | Inštalátor. Pridá zástupcu v ponuke Štart a na ploche a pravidlo firewallu, takže sa ťa Windows pri prvom spustení nič nepýta. Raz si vypýta potvrdenie správcu. |
| **[StreamPlay-Portable.exe](../../releases/latest/download/StreamPlay-Portable.exe)** | Prenosná verzia. Nič sa neinštaluje, stačí dvakrát kliknúť. |

Potom:

1. Spusti StreamPlay. TV sa v zozname objaví do pár sekúnd.
2. Klikni na TV. Za približne 4 až 8 sekúnd sa na nej objaví obraz aj zvuk.
3. Keď skončíš, klikni na **Zastaviť zrkadlenie**.

**Windows SmartScreen:** súbory nie sú digitálne podpísané, preto Windows môže ukázať „Neznámy vydavateľ“. Klikni na *Ďalšie informácie* → *Spustiť aj tak*.

**Firewall (prenosná verzia):** pri prvom použití sa Windows môže opýtať na prístup k sieti. Povoľ ho. Ak sa TV nevie pripojiť, StreamPlay ukáže žltý rámček s tlačidlom **Povoliť vo firewalle** (Windows si raz vypýta potvrdenie správcu). Potrebné je to najmä vtedy, keď Windows považuje tvoju domácu sieť za *Verejnú*.

## Použitie

- **Kvalita:** predvolená je *1080p, vysoká (8 Mb/s)*. *1080p, štandardná (5 Mb/s)* šetrí sieť.
- **Obrazovka:** ak máš viac monitorov, vyber, ktorý sa má zrkadliť.
- **Oneskorenie:** TV zobrazí obraz asi 5 až 8 sekúnd po PC, čo je obmedzenie spôsobu, akým Chromecast prehráva prúd. Obraz a zvuk sú medzi sebou zosynchronizované. Hodí sa na videá a prezentácie, nie na hry.
- **Zvuk:** zvuk systému sa zachytáva bez ohľadu na hlasitosť PC, takže reproduktory PC môžeš stlmiť a počúvať len na TV. Pruh pod stavom ukazuje, či sa zvuk zachytáva („ticho“ znamená, že v PC nič nehrá).
- Zrkadlenie sa zastaví samo, ak TV zastaví prehrávanie alebo sa preruší spojenie.

## Ako to funguje

1. Aplikácia zachytí vybranú obrazovku a zvuk systému cez Chromium (Electron).
2. Pribalený **FFmpeg** to zakóduje do H.264 + AAC (podľa možnosti cez grafickú kartu NVIDIA, AMD alebo Intel, inak procesorom) a nasekáva na 1-sekundové HLS segmenty.
3. Malý webový server na PC odovzdáva segmenty TV a aplikácia cez protokol Google Cast povie TV, aby ten prúd prehrala vo svojom vstavanom prehrávači.

## Bezpečnosť a súkromie

- Server s prúdom počúva len na adrese PC v tvojej lokálnej sieti, vyžaduje náhodný tajný kľúč v adrese (nový pre každé zrkadlenie) a odpovedá len na IP adresu vybranej TV. Ostatné zariadenia v sieti tvoju obrazovku nepozrú.
- Prúd ide ako obyčajné (nešifrované) HTTP v lokálnej sieti, preto StreamPlay používaj len doma alebo v sieti, ktorej dôveruješ. Spojenie Cast s TV používa TLS, ale rovnako ako pri každom Cast odosielateľovi sa certifikát TV nedá overiť.
- StreamPlay samo internet nepoužíva. Všetky súčasti sú pribalené, nič sa nesťahuje ani neodosiela.
- Okno je izolované od systému (izolácia kontextu, sandbox, žiadny externý obsah) a zachytenie obrazovky je povolené len pre vlastnú stránku aplikácie.
- Používané porty: TCP 8765 (prichádzajúci, TV si sťahuje prúd), TCP 8009 (odchádzajúci, ovláda TV) a UDP 5353 (multicast, hľadá TV).
- Záznam z posledných spustení sa ukladá do `%APPDATA%\StreamPlay` (`last-run.log` a priečinok `logs`). Obsahuje IP adresy tvojich zariadení, ale nie obsah obrazovky.

## Riešenie problémov

- **TV sa v zozname nezobrazuje:** skontroluj, či je zapnutá, v rovnakej sieti a či má zapnutý vstavaný Chromecast. Klikni na **Hľadať znova**.
- **„Windows pravdepodobne blokuje spojenie z TV“:** klikni na **Povoliť vo firewalle**, alebo v PowerShelli spusti ako správca:
  ```
  netsh advfirewall firewall add rule name=StreamPlay8765 dir=in action=allow protocol=TCP localport=8765 remoteip=localsubnet profile=any
  ```
- **Na TV nejde zvuk:** pozri pruh zvuku v aplikácii. Ak hlási „ticho“, v PC nič nehrá. Ak ukazuje úroveň, skontroluj hlasitosť a nastavenie výstupu zvuku na TV.
- **Obraz sekáva:** prepni na *1080p, štandardná (5 Mb/s)*, PC pripoj káblom a skontroluj kvalitu Wi-Fi signálu na TV.
- **Viac sieťových adaptérov (VPN, Hyper-V):** vypni tie, ktoré nepotrebuješ, alebo dočasne vypni VPN.

## Zostavenie zo zdrojového kódu

Potrebuješ [Node.js](https://nodejs.org/) (aktuálne LTS).

```
npm install
npm start
```

Ak npm preskočí inštalačné skripty, môže chýbať binárka FFmpeg. V takom prípade spusti `node node_modules/ffmpeg-static/install.js`.

Inštalátor a prenosný .exe súbor zostavíš do priečinka `release` príkazom:

```
npm run release
```

Oba súbory nahraj do nového vydania na GitHube presne pod týmito názvami (`StreamPlay-Setup.exe`, `StreamPlay-Portable.exe`), aby odkazy na stiahnutie vyššie vždy smerovali na najnovšiu verziu.

## Licencie

Vlastný kód StreamPlay je pod licenciou **MIT** (pozri [LICENSE](LICENSE)).

Hotové `.exe` súbory obsahujú aj softvér tretích strán:

- **FFmpeg** (statická zostava pre Windows 6.1.1 z gyan.dev) pod licenciou **GNU GPL v3**. Znenie licencie, informácie o zostave a odkaz na zdrojový kód sú v [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) a v priečinku [licenses](licenses). StreamPlay spúšťa FFmpeg ako samostatný program. `ffmpeg.exe` v inštalačnom priečinku môžeš nahradiť vlastnou zostavou.
- **Electron** a **Chromium** (MIT a ďalšie open-source licencie). Texty sa inštalujú vedľa programu (`LICENSE.electron.txt`, `LICENSES.chromium.html`).
- Balíčky npm (MIT, ISC, BSD, Apache-2.0), zoznam je v [licenses/npm-packages.txt](licenses/npm-packages.txt).

V okne programu je dole aj odkaz **Licencie a zdrojový kód** (otvorí `THIRD-PARTY-NOTICES.txt`).

„Chromecast“, „Google Cast“ a „Android TV“ sú ochranné známky spoločnosti Google LLC. StreamPlay je nezávislý projekt a nie je spojený so spoločnosťou Google.
