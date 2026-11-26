# MediaControls

A Vencord userplugin that shows a media panel above the Discord account panel and controls whatever is playing on your computer (Spotify, Apple Music, browsers, Media Player, ...). Works on Windows and macOS.

- Cover art, title, artist, album and the source app
- Seek bar (when the app supports seeking), shuffle, previous, play/pause, next, repeat
- Windows: click the app tag or right-click the panel to switch between apps when several are playing

No native modules are needed:

- **Windows** talks to the media flyout (SMTC) through a hidden PowerShell process (`smtcScript.ts`).
- **macOS** talks to the system Now Playing (MediaRemote, the same thing Control Center shows) through a hidden `osascript` JavaScript process (`macScript.ts`). It works on macOS 15.4 and newer, where other apps lost access to MediaRemote, because `osascript` is signed by Apple. macOS only has one "now playing" app at a time, so there is no source switching there: the panel follows whatever Control Center shows.

## Install

Userplugins only work in a Vencord build made from source, not the regular installer.

```sh
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
git clone <this repo> src/userplugins/mediaControls
pnpm install
pnpm build
pnpm inject
```

Then enable **MediaControls** in Vencord's plugin settings. Disable **SpotifyControls**, since both use the same spot.

After editing: `pnpm build`, then reload Discord (Ctrl+R on Windows, Cmd+R on macOS). After a Discord update removes the patch: quit Discord and run `pnpm inject` again.
