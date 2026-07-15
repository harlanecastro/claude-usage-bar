/**
 * Which monitors can actually host the widget.
 *
 * Not the display list: on Windows a monitor only has a taskbar to inject into
 * while "show my taskbar on all displays" is on, so the offer is built from the
 * taskbars that exist rather than from the screens that exist. Turn that Windows
 * option on and the extra monitors appear here on their own.
 */
const { screen } = require('electron');

const IS_WIN = process.platform === 'win32';

/** The display a rect sits on, by its centre. */
function displayFor(rect) {
  const point = {
    x: Math.round((rect.left + rect.right) / 2),
    y: Math.round((rect.top + rect.bottom) / 2),
  };
  return screen.getDisplayNearestPoint(point);
}

/**
 * @returns {Array<{id, label, primary, hwnd}>} in left-to-right order. A single
 * entry means there is nothing to choose and the picker stays hidden.
 */
function hostMonitors() {
  if (!IS_WIN) return [];

  const { listTaskbars } = require('./win32-taskbar');
  const primaryId = screen.getPrimaryDisplay().id;

  return listTaskbars().map((bar) => {
    const display = displayFor(bar.rect);
    return {
      id: display.id,
      // Size is what actually tells two monitors apart at a glance; Windows'
      // friendly names are not reachable from here without more native code.
      label: `${display.size.width} × ${display.size.height}`,
      primary: display.id === primaryId,
      hwnd: bar.hwnd,
    };
  });
}

/**
 * The taskbar to live in: the chosen monitor's, falling back to the primary when
 * that monitor is gone (unplugged, or its taskbar switched off).
 */
function resolveTaskbar(monitorId) {
  const monitors = hostMonitors();
  if (!monitors.length) return null;

  const chosen = monitorId != null && monitors.find((m) => m.id === monitorId);
  return (chosen || monitors.find((m) => m.primary) || monitors[0]).hwnd;
}

module.exports = { hostMonitors, resolveTaskbar };
