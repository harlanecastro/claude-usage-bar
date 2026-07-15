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
| Left / right click | verified |
| i18n + locale auto-detection | verified |
| Live usage data | verified |
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

The strip is **not** an always-on-top window sitting over the taskbar, and it is
**not** the Electron window either. It is a plain Win32 window we create and own,
`SetParent`'d into explorer.exe's `Shell_TrayWnd` — the same shape
[TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor) uses. That is why
nothing can cover it and why it slides away with auto-hide.

Windows has no supported API for this. Deskbands were the official route and were
removed in Windows 11. `SetParent` is what is left.

The widget itself is still the HTML renderer in `src/renderer/widget/`. It paints
offscreen, gets captured with `capturePage()`, and the bitmap is pushed into the
native window with `UpdateLayeredWindow` — mirroring the macOS path, which feeds
the same bitmap to `NSStatusItem`.

### Why not just reparent the Electron window

Because it renders and then never receives a single mouse message. A control
experiment settled it: the same window, the same window-procedure subclass and the
same synthetic click worked while the window floated on the desktop, and went
silent once embedded. TrafficMonitor embeds one plain Win32 window; Electron
embeds Chromium, which nests a `Chrome_RenderWidgetHostHWND` inside a
`Chrome_WidgetWin_1` and runs its own input plumbing that does not deliver there.

### Load-bearing details

Read off a running TrafficMonitor sitting in the same taskbar, not guessed:

- **`WS_POPUP`, kept after `SetParent`.** This is the opposite of what the
  `SetParent` documentation advises ("clear WS_POPUP and set WS_CHILD"). A real
  `WS_CHILD` of `Shell_TrayWnd` renders fine but never sees the mouse: hit-testing
  runs through the Win11 XAML taskbar, which eats it.
- **`WS_EX_LAYERED`, or nothing appears at all.** The window paints into its own DC
  perfectly happily — `StretchDIBits` reports every scanline written — but DWM does
  not composite a non-layered reparented popup. The taskbar just stays empty.
- **`UpdateLayeredWindow`, not `WM_PAINT`.** `StretchDIBits` discards alpha, which
  forces an opaque taskbar-coloured background. Per-pixel alpha lets the acrylic
  through.
- **The background is 1/255 alpha, not zero.** Layered windows hit-test per pixel,
  so a genuinely empty background would be click-through everywhere except the
  glyphs.
- **Never call `app.disableHardwareAcceleration()`.** With the GPU off Chromium
  stops painting, and the capture comes back blank.
- **No `requestAnimationFrame` in the renderer.** The window is never shown, a
  hidden window produces no frames, and the callback would never run.
- **Position from live measurements.** The free span runs from the right edge of
  `ReBarWindow32` to the left edge of `TrayNotifyWnd`. Both move: the icon band
  grows as apps open, and Win11 centres it unless the taskbar is left-aligned.

### A warning about measuring this

`mouse_event` / `SendInput` do **not** deliver clicks over the taskbar. Verified by
injecting a right-click into TrafficMonitor's own window, which works with a real
mouse and did nothing when synthesised. Any "the click never arrives" conclusion
drawn from synthetic input here is worthless — check against a real mouse.

Screen captures need `BitBlt` with `CAPTUREBLT`; `CopyFromScreen` silently omits
layered windows, so both this strip and TrafficMonitor's vanish from the shot.

## Known issues

- **Reparenting attaches our input queue to explorer's.** If this process hangs it
  can take the shell's responsiveness with it. Inherent to the technique, and why
  TrafficMonitor carries the same reputation.
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
