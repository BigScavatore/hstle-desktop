# Hstle Desktop

App desktop di [Hstle](https://github.com/BigScavatore/hstle): apre il client del tuo server Hstle in una
finestra e permette di condividere lo schermo **con l'audio del computer**, cosa che Firefox non permette.
Ha un selettore proprio (schermi e finestre con anteprima) e l'indirizzo del server si cambia dal menu *Hstle → Cambia server*.

## Scarica

Vai su **[Releases](https://github.com/BigScavatore/hstle-desktop/releases/latest)** e scarica il file per il tuo sistema:

| Sistema | File | Come si avvia |
|---|---|---|
| **Windows 10/11** | `Hstle-…-win-x64.zip` | Estrai lo zip in una cartella e apri `Hstle.exe`. Se compare l'avviso di SmartScreen: *Ulteriori informazioni → Esegui comunque* (l'app non è firmata). |
| **macOS** (Apple Silicon: M1, M2, M3…) | `Hstle-…-mac-arm64.dmg` | Apri il dmg e trascina Hstle in *Applicazioni*. Al primo avvio: tasto destro su Hstle → *Apri* → *Apri*. Se dice che è danneggiata: `xattr -cr /Applications/Hstle.app` da Terminale. |
| **macOS** (Intel) | `Hstle-…-mac-x64.dmg` | Come sopra. |
| **Linux** (64 bit) | `Hstle-…-linux-x64.AppImage` | `chmod +x Hstle-*.AppImage` poi `./Hstle-*.AppImage`. Se non parte per FUSE mancante: `./Hstle-*.AppImage --appimage-extract-and-run`. |
| **Linux** (senza AppImage) | `Hstle-…-linux-x64.tar.gz` | `tar xzf Hstle-*.tar.gz` ed esegui il programma `hstle` nella cartella. |

Non sai quale Mac hai? Menu Apple → *Informazioni su questo Mac*: "Chip Apple M…" è Apple Silicon, "Intel" è Intel.

## Cosa cambia da un sistema all'altro

- **Windows**: tutto, compreso l'audio di sistema e quello di un solo programma (anche con lo schermo intero).
- **Linux, Wayland**: prima scegli l'audio in una piccola finestra di Hstle, poi lo schermo nel portale di sistema (quello di GNOME/KDE). Servono PipeWire e `xdg-desktop-portal` con il backend del tuo desktop.
- **Linux, X11**: selettore di Hstle (schermi e finestre).
- **Linux, audio**: "Tutto l'audio del computer" funziona anche con lo **schermo intero** (provato con PulseAudio; con PipeWire serve `pipewire-pulse`). Include anche le voci della chiamata: meglio con le cuffie. Se l'audio non parte, l'app condivide comunque il video, senza riaprire la scelta.
- **macOS**: "Tutto l'audio del computer" è **sperimentale** (serve la 13 o più recente e il permesso di registrazione dello schermo/audio).

Per condividere un gioco con l'audio, su Windows scegli lo **schermo intero** e, nel menu *Audio*, "Solo l'audio di: *nome del gioco*": così la chiamata non si risente. Usa il pacchetto
[`application-loopback`](https://github.com/WerdoxDev/application-loopback) (due piccoli programmi Windows, a cura del suo autore).

## Audio per programma (electron-native-screenshare)

L'app usa [`electron-native-screenshare`](https://github.com/CilginSinek/electron-native-screenshare) (MIT) per catturare
l'audio di un solo programma, o di tutto tranne Hstle, con le API del sistema (WASAPI su Windows, ScreenCaptureKit su macOS
13+, PipeWire/PulseAudio su Linux). È un componente nativo **opzionale**: se non si installa o non si carica, l'app
funziona lo stesso con `application-loopback` (Windows) e l'audio di sistema.

| Voce del menu Audio | Windows | macOS | Linux |
|---|---|---|---|
| Tutto tranne Hstle (consigliato per i giochi) | sì | sì | no (non possibile: include la chiamata) |
| Solo l'audio di un programma | sì | sì | sì (serve PipeWire) |
| Tutto l'audio del computer | sì | sperimentale | sperimentale |

Nel terminale, all'avvio, l'app stampa `audio nativo non disponibile` se il componente non si è caricato.

## Se su Linux la condivisione non parte

Avvia l'app da un terminale (`./Hstle-*.AppImage` oppure `npm start`) e guarda gli errori che stampa. Scrivi anche:
la distribuzione, se usi X11 o Wayland (`echo $XDG_SESSION_TYPE`) e se hai PipeWire (`pactl info | grep Server`).
Prova a scegliere **Nessun audio** nel selettore: l'audio di sistema è sperimentale.

## Crearla da solo

```bash
npm install
npm start            # prova
npm run dist:win     # dist/Hstle-<versione>-win-x64.zip (da Windows)
npm run dist:mac     # dmg (da un Mac)
npm run dist:linux   # AppImage e tar.gz (da Linux)
```

Se `npm install` non scarica Electron (npm recenti saltano gli script di installazione): `npm install-scripts approve electron` e riesegui `npm install`.

## Pubblicare una versione

La GitHub Action `.github/workflows/build.yml` costruisce Windows, macOS e Linux e carica i file nelle Release.
Aggiorna `version` in `package.json`, poi:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Dopo qualche minuto i file sono in *Releases*. Da *Actions → App desktop → Run workflow* puoi anche solo provare la build.
