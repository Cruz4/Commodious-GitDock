# Commodious GitDock v1.2

> **Publishing status:** The documentation is public, but the full v1.2 application source and Windows release are not yet on this repository. Upload `Commodious-GitDock-v1.2-Source.zip` at the repository root; the configured GitHub Actions workflow will then attempt to unpack the source and build the Windows release.

**Drop it. Ship it. Sync it.**

GitHub made simple: drag, drop, publish projects, link folders, preview changes, and auto-sync saves from Cursor. By Commodious Works LLC.

A local GitHub project publisher and linked-project manager created by **Jordie Cruz · Commodious Works LLC**.

GitDock lets you drag an entire project, file selection, or ZIP onto GitHub without learning Git. The **Linked Projects + Smart Sync** feature also lets you connect a real Windows project folder one time and keep it up to date with GitHub while working in Cursor or another editor.

## Windows — download a single EXE

1. Download **`Commodious-GitDock-Setup.exe`** from the release.
2. Double-click it. It installs GitDock in `%LOCALAPPDATA%\Commodious Works\GitDock`, creates Start menu and desktop shortcuts, and opens the local application in your browser.
3. If required tools are missing, the same EXE uses Windows Package Manager (`winget`) to install **Node.js LTS, Git, and GitHub CLI**. Windows may ask you to approve installations. If `winget` is unavailable or an install fails, its setup screen gives official download links. **Users do not need to run a separate setup BAT or a launcher BAT.**
4. Click **Connect GitHub** and complete GitHub's browser sign-in once. GitDock itself never asks for your password or personal access token.

The EXE is *not code-signed*; Windows SmartScreen may show an "Unknown publisher" warning. This package is not a Microsoft-signed installer. Users should download only from a trusted project release and review the source before bypassing a warning.

> **Note:** GitDock is a local web app launched by a native Windows EXE. It opens in your browser; it is not a hosted service. Internet access is required to push to GitHub. No third-party server or paid plan is used by GitDock.

## One-time publish (drag and drop)

1. Drop a folder, file(s), or ZIP into the upload area (or choose files/folders).
2. Select **New repository** (private by default) or **Existing repository**.
3. Click **Publish to GitHub**. GitDock creates a Git commit and pushes it for you.

ZIPs are extracted, files are checked for likely secrets and unsafe paths, and unrelated GitHub files are not deleted when updating existing repositories.

## Linked Projects + Smart Sync

The **Linked Projects** section below the uploader is separate from the drag/drop area:

1. Click **Browse…** and select your *actual project folder* on Windows, e.g. `G:\PlotForm 2027\PloForm App 2027`. You can also paste its absolute path. Browsers do not provide absolute paths to web pages when you drag folders, so linking uses a native Windows folder chooser.
2. Choose an **existing** `owner/repository` (from your GitHub repo suggestions or type it) and optionally a **branch**. Leave the branch blank to use the repository default.
3. Click **Link Project**. Nothing uploads yet. GitDock clones the selected GitHub branch to its own private cache and compares the local folder with it. Your project folder is **not** converted into a Git repository or overwritten.
4. Review **Added / Modified / Deleted** file counts, expand **See exactly what changed**, and click **View diff** to inspect text changes. Click **Sync Now** to commit and push.
5. Choose a mode for each project:

| Sync mode | Behavior |
| --- | --- |
| **Review & Sync** (default) | Watches for local edits and lists changed files. Uploads only when you click **Sync Now**. |
| **Auto-Sync on save** (opt-in) | Watches the linked folder and, after roughly 4.5 seconds of no further changes, automatically commits and pushes eligible files. Works with saves from Cursor, VS Code, or any other program. |
| **Off** | No background watching or automatic pushing. Manual **Sync Now** is still available. |

**Auto-Sync requires GitDock's local server to be running.** It does not install a Cursor extension or a Windows system service. Closing your browser tab normally leaves the app server running; restarting Windows requires launching GitDock again using its desktop or Start menu shortcut. A filesystem polling fallback runs every 12 seconds if native recursive watching is unavailable.

- Each project remembers its **folder path, GitHub repository, branch, sync mode, deletion setting, and last successful sync** in local app settings at `%LOCALAPPDATA%\Commodious Works\GitDock\linked-projects.json`.
- Auto-Sync is **never activated automatically upon linking**; you must select it and accept the confirmation.
- GitDock by default **does not delete remote files**. You can separately check **Sync local deletions** to delete only files previously managed by GitDock that have been deleted from the local project; this setting requires a warning confirmation.
- GitDock compares local Git blob hashes to GitHub's checked-out tree, so it detects file contents changing rather than relying on filenames alone. It shows text diffs through Git (some binary or large files cannot be previewed inline).
- Before a sync it fetches the latest remote branch. If the remote has received other commits since your last preview, it stops and requires you to review and click Sync again. Auto-Sync pauses on conflicts, errors, or suspected secrets rather than retrying repeatedly.
- GitDock does **not** make forced pushes; protected branches still follow the repository's protection rules and can reject direct pushes.

## Security & limits

- **Local-only server**: binds to `127.0.0.1` on a random port, validates local HTTP requests and sessions, no telemetry.
- **Official GitHub authentication**: GitHub CLI manages your account connection and tokens.
- **Default exclusions** include `.git`, `node_modules`, `.next`, `dist`, `build`, `.env*`, `.npmrc`, common secret filenames, and common private key files. A content scanner checks uploaded files for known API key patterns before publishing. **It cannot detect every secret**; review files before public release, especially before enabling Auto-Sync.
- Files stay on your computer until you choose Publish, Sync Now, or enable Auto-Sync. Linking or previewing compares files locally and downloads the GitHub branch into GitDock's private cache.
- Per upload / linked project limits: 10,000 files / 2 GiB local staging, regular files under 99 MiB. Git LFS is not supported. Large or Git-ignored files may require manual attention.
- GitDock never deletes or edits the source folder. It creates commits in an isolated Git checkout under the app's data directory and pushes to your chosen branch.
- Any other account or agent editing the branch may create conflicts; review the repository if a push is rejected.

## Development (cross-platform)

Node.js 20+, Git, and GitHub CLI are required. The server has **no npm dependencies**.

```bash
npm test
npm start
```

The web UI runs at `http://127.0.0.1:<random-port>`. Windows `Browse…` uses the built-in PowerShell `Shell.Application` dialog; on macOS/Linux, paste the absolute folder path in Linked Projects. Automatic file detection uses native watching on Windows and a polling fallback elsewhere.

The native EXE source is in `launcher/`. Build an unsigned Windows EXE from Linux/macOS/Windows with Go 1.22+:

```bash
# After copying current app files to launcher/assets/:
cd launcher
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-H=windowsgui -s -w" -o ../installer-dist/Commodious-GitDock-Setup.exe .
```

The EXE embeds the local web app and is self-installing; Go standard library only. The first launch may take time to install missing external tools using `winget`.

**Source project:** Upload this folder as a public GitHub repository using GitDock itself. The released EXE is an executable download, not a GitHub Pages website. Don't upload GitDock's local auth/config/cache folders or your project secrets.

### Uninstall

GitDock is a per-user application; there is currently no Windows Add/Remove Programs entry. Stop the app (or restart Windows), delete `%LOCALAPPDATA%\Commodious Works\GitDock`, and remove the "Commodious GitDock" desktop/Start menu shortcuts. **This does not uninstall Node.js, Git, or GitHub CLI**, which might be used by other software. It does not delete linked project folders or GitHub repositories.

## Branding & legal

GitDock is independently built and not affiliated with GitHub, Inc. Custom CW-inspired brand mark included; substitute your official Commodious Works logo if desired.

MIT License · © 2026 **Commodious Works LLC** · Created by **Jordie Cruz**.
