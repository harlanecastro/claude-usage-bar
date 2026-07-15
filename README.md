# Claude Usage Bar

Your Claude weekly usage, read at a glance — injected into the **Windows taskbar**
and the **macOS menu bar**. When you have blown through the weekly limit, it tells
you when it resets.

- **Windows** — two lines, inside the taskbar itself (not floating over it).
- **macOS** — the same information on one line, because the menu bar is shorter.
- **i18n** — English, Português (Brasil), Español; follows the OS by default.
- **Colour thresholds** — you decide where the meter turns yellow and red.
- **Optional monthly meter** — shows the extra usage you bought this month.

Left click opens `claude.ai/new#settings/usage`. Right click opens the menu.

## Status

| Area | State |
| --- | --- |
| Windows taskbar injection + rendering | verified on Windows 11 build 26200 |
| Widget layout, transparency, positioning | verified |
| i18n + locale auto-detection | verified |
| Click / context menu handling | **unverified — see Known issues** |
| Live usage data | **unverified** (needs a real sign-in) |
| macOS | **unverified** — written, never run; no Mac available yet |

## Running

```bash
npm install
npm start
```

Build installers:

```bash
npm run dist:win     # NSIS + portable
npm run dist:mac     # dmg + zip, arm64 + x64, macOS 12+
```

The macOS build must be produced **on a Mac** — electron-builder cannot cross-compile
a signed `.app` from Windows. Clone the repo there and run `npm run dist:mac`.

## How it gets the data

There is no Anthropic API key and no token counting here, and no pricing table.
You sign in to claude.ai in a normal browser window; the app keeps the `sessionKey`
cookie it leaves behind (encrypted in the OS keychain via `safeStorage`) and polls
`claude.ai/api/organizations/{id}/usage` every 5 minutes. The percentages come back
already computed by the server, so the widget cannot drift from what claude.ai
itself shows.

Requests go through a hidden `BrowserWindow` rather than `fetch`: Cloudflare blocks
Node-shaped requests from Electron on header fingerprint alone.

## How it gets into the Windows taskbar

This is the part worth understanding before changing anything.

The widget is **not** an always-on-top window sitting over the taskbar. It is
`SetParent`'d into explorer.exe's `Shell_TrayWnd` and becomes a real child of it —
the same technique [TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor)
uses. That is why nothing can cover it and why it slides away with auto-hide.

Windows has no supported API for this. Deskbands were the official route and were
removed in Windows 11. `SetParent` is what is left.

### Findings from `spike/`

Verified against a live Windows 11 26200 taskbar. Each of these cost an iteration:

- **Never call `app.disableHardwareAcceleration()`.** With the GPU off, Chromium
  stops painting once reparented. The window is there, `IsWindowVisible` is true,
  and nothing draws.
- **Keep `WS_EX_LAYERED`.** Stripping it forces the window opaque, and the widget
  becomes a grey rectangle pasted over the taskbar acrylic. With it, the acrylic
  shows through and the widget looks native.
- **Electron's `setContentSize` must not be used on Windows after attaching.** It
  re-applies the bounds Electron cached before the reparent, dragging the window
  out of the taskbar and up over the wallpaper. `SetWindowPos` owns the geometry.
- **Position from live measurements, not assumptions.** The free span runs from the
  right edge of `ReBarWindow32` to the left edge of `TrayNotifyWnd`. Both move —
  the icon band grows as apps open and Win11 centres it unless you left-align.
- **`focusable: false` is required** so the widget does not steal focus, but a
  `WS_EX_NOACTIVATE` window cannot host a popup menu: the menu dismisses itself the
  frame it appears, silently and with no error.

`spike/whats-under-cursor.js` asks Windows which HWND is under the cursor. It
confirmed the OS hit-tests the widget correctly:

```
(1305,1050) -> Chrome_RenderWidgetHostHWND <- Chrome_WidgetWin_1 <- Shell_TrayWnd
(923,1055)  -> Shell_TrayWnd
```

## Known issues

- **Right click also opens the taskbar's own menu.** Unhandled `WM_CONTEXTMENU`
  bubbles up to the parent window, and our parent is `Shell_TrayWnd`. Needs the
  message swallowed before it reaches explorer.
- **Click handling is unverified end to end.** The OS routes the cursor to the
  widget, but that the renderer reacts has not been observed.
- **Reparenting attaches our input queue to explorer's.** If this renderer hangs,
  it can take the shell's responsiveness with it. This is inherent to the
  technique and is why TrafficMonitor carries the same reputation.
- **Antivirus may block the reparent.** Reported against TrafficMonitor too.

## Layout

```
src/
  main/
    index.js          lifecycle, polling, view model, menu
    win32-taskbar.js  SetParent injection + slot measurement (koffi/Win32)
    widget.js         hosts the one renderer: real window on Win, Tray image on Mac
    auth.js           login window, sessionKey, keychain
    usage.js          claude.ai usage endpoints
    fetch-via-window.js
    i18n.js           translation + duration formatting
    config.js         electron-store settings
  renderer/
    widget/           the strip. A dumb painter — every string arrives translated
    settings/         language, thresholds, monthly toggle, account
  shared/locales/     en, pt-BR, es
spike/                throwaway probes kept as documentation
```

Strings are translated and formatted in the **main** process and handed to the
renderer ready to paint, so the Windows strip and the macOS menu bar image can
never word things differently.

## macOS

Same renderer, different delivery: the window is never shown, it renders offscreen,
gets captured with `capturePage()`, and the bitmap becomes the `NSStatusItem` image
via `Tray`. Left click and right click are wired to the tray's own events. Written
against the Electron API but never executed — expect to shake bugs out on first run.

## License

MIT
