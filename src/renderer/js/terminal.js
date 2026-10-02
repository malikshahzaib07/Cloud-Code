// ============================================================================
// terminal.js — real PTY-backed terminal (xterm.js + node-pty in the main
// process).
//
// NOTE: xterm.js is a UMD bundle. Because Monaco's AMD loader is on the page it
// registers itself through define('XTerm', ...) and NEVER sets window.Terminal —
// so we pull the modules out of the loader instead of relying on a global. This
// was the reason the terminal used to print "xterm Terminal not loaded yet".
// ============================================================================
class TerminalManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.term = null;
    this.fitAddon = null;
    this.cwd = null;
    this.alive = false;
    this._lastCwd = null;
    this.api = window.electronAPI || null;
    this.boot();
  }

  // --------------------------------------------------------------------------
  // Boot: resolve xterm from the AMD loader (with retries while it initialises)
  //
  // xterm's UMD wrapper calls an ANONYMOUS define([], factory) when an AMD
  // loader is present, so the loader keys the module by the script URL — there
  // is no 'XTerm' module id and no window.Terminal global to fall back on.
  // --------------------------------------------------------------------------
  boot() {
    let attempts = 0;
    const xtermUrl = () => new URL('../../node_modules/xterm/lib/xterm.js', location.href).href;
    const fitUrl = () => new URL('../../node_modules/xterm-addon-fit/lib/xterm-addon-fit.js', location.href).href;

    const tryBoot = () => {
      attempts++;

      const req = window.require;
      if (req && typeof req.config === 'function') {
        try {
          req(
            [xtermUrl(), fitUrl()],
            (xMod, fitMod) => {
              const TerminalCtor = xMod && (xMod.Terminal || xMod.XTerm);
              const FitCtor = fitMod && (fitMod.FitAddon || fitMod);
              if (!TerminalCtor) return this.retry(tryBoot, attempts);
              this.create(TerminalCtor, FitCtor);
            },
            () => this.retry(tryBoot, attempts)
          );
          return;
        } catch (e) {
          return this.retry(tryBoot, attempts);
        }
      }

      // Plain browser / no AMD loader: fall back to globals.
      if (typeof window.Terminal !== 'undefined') {
        this.create(window.Terminal, window.FitAddon);
        return;
      }
      this.retry(tryBoot, attempts);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryBoot, { once: true });
    } else {
      tryBoot();
    }
  }

  retry(fn, attempts) {
    if (attempts > 60) {
      console.warn('terminal: xterm could not be loaded');
      return;
    }
    setTimeout(fn, 100);
  }

  /** xterm palette that follows the app theme (light is the default). */
  xtermTheme() {
    const dom = (document.documentElement && document.documentElement.dataset &&
      document.documentElement.dataset.theme) || 'light';
    if (dom === 'dark') {
      return {
        background: '#181818',
        foreground: '#cccccc',
        cursor: '#ffffff',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5'
      };
    }
    return {
      background: '#ffffff',
      foreground: '#1f1f1f',
      cursor: '#000000',
      selectionBackground: 'rgba(0, 122, 204, 0.25)',
      black: '#000000',
      red: '#cd3131',
      green: '#078b21',
      yellow: '#949800',
      blue: '#0451a5',
      magenta: '#bc05bc',
      cyan: '#0598bc',
      white: '#555555',
      brightBlack: '#666666',
      brightRed: '#cd3131',
      brightGreen: '#14ce14',
      brightYellow: '#b5ba00',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#666666'
    };
  }

  /** Re-colour the terminal when the app theme changes. */
  applyTheme() {
    if (!this.term) return;
    try {
      this.term.options.theme = this.xtermTheme();
    } catch (e) {
      // older xterm: ignore
    }
  }

  // --------------------------------------------------------------------------
  // Build the xterm instance and connect it to the PTY
  // --------------------------------------------------------------------------
  create(TerminalCtor, FitCtor) {
    if (this.term || !this.container) return;

    this.term = new TerminalCtor({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      convertEol: false,
      theme: this.xtermTheme()
    });

    if (FitCtor) {
      this.fitAddon = new FitCtor();
      this.term.loadAddon(this.fitAddon);
    }

    this.term.open(this.container);

    // Size the grid, then start a shell only if a workspace folder is open.
    this.fit();
    this._syncCwd();
    setTimeout(() => { this.fit(); this.term && this.term.focus(); }, 80);

    // keystrokes -> PTY
    this.term.onData((data) => {
      if (!this.alive) {
        // The shell exited (or was never started): bring it back if allowed.
        this._syncCwd();
        if (!this.alive) return; // no folder open yet — don't spawn a shell
      }
      if (this.api && this.api.sendTerminalInput) this.api.sendTerminalInput(data);
    });

    // grid size changes -> tell the PTY (full-screen programs need this)
    this.term.onResize(({ cols, rows }) => {
      if (this.api && this.api.resizeTerminal) this.api.resizeTerminal(cols, rows);
    });

    // PTY output -> xterm
    if (this.api && this.api.onTerminalData) {
      this.api.onTerminalData((data) => {
        if (this.term) this.term.write(data);
      });
    }

    if (this.api && this.api.onTerminalExit) {
      this.api.onTerminalExit((info) => {
        this.alive = false;
        const code = info && info.code;
        const label = code === undefined || code === null ? '' : ' (code ' + code + ')';
        if (this.term) {
          this.term.write(
            '\r\n\x1b[90m[process exited' + label + ' — press any key to start a new shell]\x1b[0m\r\n'
          );
        }
      });
    }

    if (typeof ResizeObserver !== 'undefined') {
      try {
        this._ro = new ResizeObserver(() => this.fit());
        this._ro.observe(this.container);
      } catch (e) {
        // ResizeObserver unavailable — the window resize listener still works
      }
    }
    window.addEventListener('resize', () => this.fit());
    window.addEventListener('theme-changed', () => this.applyTheme());
  }

  // --------------------------------------------------------------------------
  // Shell lifecycle
  // --------------------------------------------------------------------------
  startShell(cwd) {
    // Remember the cwd even if xterm has not finished booting yet.
    if (cwd) this.cwd = cwd;
    if (!this.term || !this.api || !this.api.startTerminal) return;
    this.alive = true;
    this._lastCwd = this.cwd;
    this.api.startTerminal(this.cwd, { cols: this.term.cols, rows: this.term.rows });
  }

  // Move the live shell to a directory without restarting it (keeps the user's
  // session, scrollback and any running program alive).
  cd(dir) {
    if (!dir) return;
    if (this.alive && this.api && this.api.sendTerminalInput) {
      const quoted = String(dir).replace(/'/g, "'\\''");
      // `cd` works in PowerShell (alias of Set-Location) and in POSIX shells.
      this.api.sendTerminalInput("cd '" + quoted + "'\r");
      this._lastCwd = dir;
      return;
    }
    this.startShell(dir);
  }

  /**
   * A terminal session only starts once a folder has been selected — the user
   * asked for the IDE to open empty, so don't spawn a shell in the home dir.
   */
  _syncCwd() {
    const dir = (window.explorer && window.explorer.rootPath) || this.cwd || null;
    if (this.alive) {
      if (dir && dir !== this._lastCwd) this.cd(dir);
      return;
    }
    if (!dir) {
      if (this.term) {
        this.term.write(
          '\x1b[90mNo folder open — press Ctrl+O to choose a folder and start a shell here.\x1b[0m\r\n'
        );
      }
      return;
    }
    this.startShell(dir);
  }

  fit() {
    if (!this.fitAddon || !this.term) return;
    try {
      this.fitAddon.fit();
    } catch (e) {
      // container not measurable yet (hidden panel)
    }
  }

  focus() {
    if (this.term) {
      this.fit();
      this.term.focus();
    }
  }

  write(data) {
    if (this.term) this.term.write(data);
  }

  clear() {
    if (this.term) this.term.clear();
  }
}

window.TerminalManager = TerminalManager;