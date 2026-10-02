// Terminal Manager using xterm.js hooked into electronAPI
class TerminalManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.term = null;
    this.fitAddon = null;
    this.init();
  }

  init() {
    if (typeof Terminal === 'undefined') {
      console.warn('xterm Terminal not loaded yet');
      return;
    }

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
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
        white: '#e5e5e5'
      }
    });

    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      this.fitAddon = new FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);
    }

    this.term.open(this.container);

    if (this.fitAddon) {
      setTimeout(() => this.fitAddon.fit(), 100);
    }

    // Forward keystrokes to Electron PTY shell
    this.term.onData((data) => {
      if (window.electronAPI && window.electronAPI.sendTerminalInput) {
        window.electronAPI.sendTerminalInput(data);
      }
    });

    // Receive output from Electron PTY shell
    if (window.electronAPI && window.electronAPI.onTerminalData) {
      window.electronAPI.onTerminalData((data) => {
        this.term.write(data);
      });
    }

    // Start terminal shell
    if (window.electronAPI && window.electronAPI.startTerminal) {
      window.electronAPI.startTerminal();
    }

    window.addEventListener('resize', () => {
      if (this.fitAddon) this.fitAddon.fit();
    });
  }

  fit() {
    if (this.fitAddon) {
      this.fitAddon.fit();
    }
  }

  write(data) {
    if (this.term) {
      this.term.write(data);
    }
  }

  clear() {
    if (this.term) {
      this.term.clear();
    }
  }
}

window.TerminalManager = TerminalManager;
