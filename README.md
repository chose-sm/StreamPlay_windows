# StreamPlay

**English** | [Slovenčina](README_SK.md)

Mirror your Windows PC screen and system audio to a Chromecast or Android TV over your home Wi-Fi. Nothing needs to be installed on the TV, and picture and sound stay in sync.

## Requirements

- Windows 10 or 11 (64-bit).
- A TV or dongle with **Chromecast built-in (Google Cast)**. Most Android TVs and Google TVs have it, and so do Chromecast dongles. If the TV shows up in Chrome's *Cast…* menu, it works here too.
- The PC and the TV must be on the same network (not a guest network, and no "client isolation" on the router).

StreamPlay was developed and tested on Windows 10 with an NVIDIA graphics card and one Android TV (TCL). Other TVs or graphics cards should work, but behaviour can differ.

## Getting started

Download one of the files from **[Releases](../../releases/latest)**:

| File | What it is |
|---|---|
| **[StreamPlay-Setup.exe](../../releases/latest/download/StreamPlay-Setup.exe)** | Installer. Adds a Start menu and desktop shortcut and a firewall rule, so Windows doesn't ask anything on first run. Needs administrator confirmation once. |
| **[StreamPlay-Portable.exe](../../releases/latest/download/StreamPlay-Portable.exe)** | Portable version. Nothing is installed; just double-click it. |

Then:

1. Start StreamPlay. Your TV appears in the list within a few seconds.
2. Click the TV. After about 4 to 8 seconds the screen and sound appear on the TV.
3. Click **Stop mirroring** when you are done.

**Windows SmartScreen:** the files are not digitally signed, so Windows may show "Unknown publisher". Click *More info* → *Run anyway*.

**Firewall (portable version):** on first use Windows may ask for network access. Allow it. If the TV can't connect, StreamPlay shows a yellow box with an **Allow in firewall** button (Windows asks for administrator confirmation once). This is needed especially when Windows treats your home network as *Public*.

## Usage

- **Quality:** *1080p, high (8 Mb/s)* is the default. *1080p, standard (5 Mb/s)* uses less bandwidth.
- **Screen:** if you have more than one monitor, choose which one to mirror.
- **Delay:** the TV shows the picture about 5 to 8 seconds after the PC, which is a limitation of how Chromecast plays streams. Picture and sound are in sync with each other. It is great for videos and presentations, but not for games.
- **Sound:** the system sound is captured regardless of the PC volume, so you can mute the PC speakers and listen on the TV only. The bar under the status shows whether sound is being captured ("silence" means nothing is playing on the PC).
- Mirroring stops automatically if the TV stops playback or the connection is lost.

## How it works

1. The app captures the selected screen and the system audio with Chromium (Electron).
2. A bundled **FFmpeg** encodes it to H.264 + AAC, using the graphics card (NVIDIA, AMD or Intel) when available and the CPU otherwise, and cuts it into 1-second HLS segments.
3. A small web server on your PC serves the segments to the TV, and the app tells the TV (via the Google Cast protocol) to play that stream in its built-in media player.

## Security and privacy

- The stream server listens only on the PC's address in your local network, requires a random secret in the URL (new for every session), and answers only the IP address of the selected TV. Other devices on the network cannot watch your screen.
- The stream is plain (unencrypted) HTTP inside your local network, so use StreamPlay only at home or on a network you trust. The Cast connection to the TV uses TLS, but, as with all Cast senders, the TV's certificate cannot be verified.
- StreamPlay does not use the internet by itself. All of its parts are bundled; nothing is downloaded or uploaded.
- The window is isolated from the system (context isolation, sandbox, no external content), and screen capture is allowed only for the app's own page.
- Ports used: TCP 8765 (incoming, the TV downloads the stream), TCP 8009 (outgoing, controls the TV) and UDP 5353 (multicast, finds the TV).
- A log of the last runs is kept in `%APPDATA%\StreamPlay` (`last-run.log` and the `logs` folder). It contains IP addresses of your devices, but no screen content.

## Troubleshooting

- **The TV is not listed:** make sure it is on and on the same network, and that Chromecast built-in is enabled. Click **Search again**.
- **"Windows probably blocks the connection from the TV":** click **Allow in firewall**, or run this in PowerShell as administrator:
  ```
  netsh advfirewall firewall add rule name=StreamPlay8765 dir=in action=allow protocol=TCP localport=8765 remoteip=localsubnet profile=any
  ```
- **No sound on the TV:** check the sound bar in the app. If it says "silence", nothing is playing on the PC. If it shows a level, check the volume and sound output settings of the TV.
- **Picture stutters:** switch to *1080p, standard (5 Mb/s)*, use a wired connection for the PC, and make sure the TV has a good Wi-Fi signal.
- **Several network adapters (VPN, Hyper-V):** disable the ones you don't need, or temporarily switch off the VPN.

## Building from source

You need [Node.js](https://nodejs.org/) (current LTS).

```
npm install
npm start
```

If npm skips install scripts, the FFmpeg binary may be missing. In that case run `node node_modules/ffmpeg-static/install.js`.

To build the installer and the portable executable into the `release` folder:

```
npm run release
```

Upload both files to a new GitHub release under exactly these names (`StreamPlay-Setup.exe`, `StreamPlay-Portable.exe`), so the download links above keep pointing to the latest version.

## Licenses

StreamPlay's own code is licensed under the **MIT License** (see [LICENSE](LICENSE)).

The released `.exe` files also contain third-party software:

- **FFmpeg** (static Windows build 6.1.1 from gyan.dev), licensed under the **GNU GPL v3**. The license text, build information and a link to the source code are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and the [licenses](licenses) folder. StreamPlay runs FFmpeg as a separate program. You can replace `ffmpeg.exe` in the installation folder with your own build.
- **Electron** and **Chromium** (MIT and other open-source licenses). The texts are installed next to the program (`LICENSE.electron.txt`, `LICENSES.chromium.html`).
- npm packages (MIT, ISC, BSD, Apache-2.0), listed in [licenses/npm-packages.txt](licenses/npm-packages.txt).

The program window also has a **Licenses and source code** link at the bottom (it opens `THIRD-PARTY-NOTICES.txt`).

"Chromecast", "Google Cast" and "Android TV" are trademarks of Google LLC. StreamPlay is an independent project and is not affiliated with Google.
