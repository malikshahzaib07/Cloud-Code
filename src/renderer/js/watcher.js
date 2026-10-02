// ============================================================================
// watcher.js — keeps the IDE in sync with the filesystem.
//
// Why this exists: after the agent (or git, or any external editor) changes a
// file, the explorer tree and open editors used to keep showing the old
// contents until the user hit refresh / reopened the folder. This module watches
// the workspace root and pushes changes into the UI automatically.
//
// It is deliberately decoupled: it never calls into another module's internals,
// it only (a) asks the editor to re-read open files, (b) broadcasts a
// `workspace:files-changed` window event that the explorer listens for, and
// (c) nudges the palette index / search results.
// ============================================================================
class WorkspaceWatcher {
  constructor() {
    this.root = null;
    this.watching = false;
    this.pending = new Set();
    this.flushTimer = null;
    this.pollTimer = null;
    this.indexTimer = null;
    this.lastIndexRefresh = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    if (window.electronAPI && window.electronAPI.onFilesChanged) {
      try {
        window.electronAPI.onFilesChanged((evt) => this.queue(evt && evt.path));
      } catch (e) {
        console.warn('watcher: cannot subscribe to fs changes', e);
      }
    }

    // The workspace can change at any moment (open folder / close), and the
    // explorer is owned by another module — so poll its root instead of
    // hooking into it.
    this.pollTimer = setInterval(() => this.sync(), 1000);
    this.sync();

    window.addEventListener('beforeunload', () => this.stop());
  }

  /** (Re)point the OS watcher at the current workspace root. */
  sync() {
    const root = (window.explorer && window.explorer.rootPath) || null;
    if (root === this.root) return;
    this.root = root;

    if (!window.electronAPI) return;

    if (!root) {
      if (this.watching && window.electronAPI.unwatchWorkspace) {
        try { window.electronAPI.unwatchWorkspace(); } catch (e) { /* ignore */ }
      }
      this.watching = false;
      return;
    }

    try {
      Promise.resolve(window.electronAPI.watchWorkspace(root))
        .then((ok) => { this.watching = !!ok; })
        .catch(() => { this.watching = false; });
    } catch (e) {
      this.watching = false;
    }
  }

  /** Collect a changed path and flush shortly after (editors often fire twice). */
  queue(path) {
    if (!path) return;
    this.pending.add(path);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 250);
  }

  async flush() {
    this.flushTimer = null;
    const paths = Array.from(this.pending);
    this.pending.clear();
    if (!paths.length) return;

    // 1) Refresh open editors (clean buffers reload, dirty ones are flagged).
    try {
      if (window.editor && window.editor.reloadExternallyChanged) {
        await window.editor.reloadExternallyChanged(paths);
      }
    } catch (e) {
      console.warn('watcher: editor reload failed', e);
    }

    // 2) Tell the rest of the app (explorer tree listens for this).
    try {
      window.dispatchEvent(new CustomEvent('workspace:files-changed', { detail: { paths } }));
    } catch (e) {
      // CustomEvent unavailable
    }

    // 3) Refresh the palette's file index, throttled (walking a big tree is
    //    expensive, and a git checkout can fire hundreds of events).
    const now = Date.now();
    if (now - this.lastIndexRefresh > 3000) {
      this.lastIndexRefresh = now;
      try { if (window.palette && window.palette.refreshFiles) window.palette.refreshFiles(); } catch (e) { /* ignore */ }
    }

    // 4) Re-run / clear stale search results.
    try {
      if (window.workspaceSearch && window.workspaceSearch.refresh) window.workspaceSearch.refresh();
    } catch (e) { /* ignore */ }
  }

  stop() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.pending.clear();
    if (this.watching && window.electronAPI && window.electronAPI.unwatchWorkspace) {
      try { window.electronAPI.unwatchWorkspace(); } catch (e) { /* ignore */ }
    }
    this.watching = false;
    this.root = null;
    this.started = false;
  }
}

window.WorkspaceWatcher = WorkspaceWatcher;

// Self-boot (the coordinator wires the <script> tag in index.html).
(function bootWorkspaceWatcher() {
  if (window.__workspaceWatcherBooted) return;
  window.__workspaceWatcherBooted = true;
  const boot = () => {
    if (window.fileWatcher) return;
    try {
      window.fileWatcher = new WorkspaceWatcher();
      window.fileWatcher.start();
    } catch (e) {
      console.warn('watcher unavailable:', e);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();