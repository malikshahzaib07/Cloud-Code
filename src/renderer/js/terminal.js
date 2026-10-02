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
      theme: {
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
      }
    });

    if (FitCtor) {
      this.fitAddon = new FitCtor();
      this.term.loadAddon(this.fitAddon);
    }

    this.term.open(this.container);

    // Size the grid, then start a shell that matches it.
    this.fit();
    this.startShell(this.cwd);
    setTimeout(() => { this.fit(); this.term && this.term.focus(); }, 80);

    // keystrokes -> PTY
    this.term.onData((data) => {
      if (!this.alive) {
        // The shell exited: any key restarts it (like VS Code's "press any key").
        this.startShell(this.cwd);
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

    this.alive = true;

    // Keep the PTY in sync when the panel/container is resized.
    if (typeof ResizeObserver !== 'undefined') {
      try {
        this._ro = new ResizeObserver(() => this.fit());
        this._ro.observe(this.container);
      } catch (e) {
        // ResizeObserver unavailable — the window resize listener still works
      }
    }
    window.addEventListener('resize', () => this.fit());
  }

  // --------------------------------------------------------------------------
  // Shell lifecycle
  // --------------------------------------------------------------------------
  startShell(cwd) {
    // Remember the cwd even if xterm has not finished booting yet.
    if (cwd) this.cwd = cwd;
    if (!this.term || !this.api || !this.api.startTerminal) return;
    this.alive = true;
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