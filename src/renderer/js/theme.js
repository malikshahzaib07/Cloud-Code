/* ============================================================================
 * theme.js — Light/Dark theme controller (classic script, no modules)
 * ----------------------------------------------------------------------------
 * Loaded from index.html (in <body>, before app.js).
 *
 * Exposes window.AppTheme = { get, set, toggle, onChange, STORAGE_KEY, ... }
 *
 * Contract:
 *   - default theme is 'light'
 *   - persisted in localStorage under 'cc.theme'
 *   - writes document.documentElement.dataset.theme
 *   - pushes the matching Monaco theme name to window.editor.setTheme() when the
 *     editor manager exists ('cloud-light' | 'cloud-dark')
 *   - mirrors the theme onto color-scheme so native widgets/scrollbars follow
 *   - dispatches window CustomEvent('theme-changed', { detail: { theme } })
 *
 * Safe to load at any time: every DOM/editor access is guarded so it works
 * before app.js runs and before Monaco has finished loading.
 * ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'cc.theme';
  var DEFAULT_THEME = 'light';
  var VALID = { light: true, dark: true };

  // Monaco theme names, kept in one place so editor.js and this file agree.
  var MONACO_THEME = { light: 'cloud-light', dark: 'cloud-dark' };

  /* ------------------------------------------------------------------ */
  /* Storage helpers (localStorage can throw in locked-down contexts)     */
  /* ------------------------------------------------------------------ */
  function readStored() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function writeStored(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      /* quota / private mode — theme still applies for this session */
    }
  }

  function normalize(theme) {
    return VALID[theme] ? theme : DEFAULT_THEME;
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */
  function root() {
    return (typeof document !== 'undefined' && document.documentElement) || null;
  }

  function applyToDom(theme) {
    var el = root();
    if (!el) return;
    el.setAttribute('data-theme', theme);
    // keep native widgets (select popup, scrollbars, caret) in sync
    el.style.colorScheme = theme;
  }

  function current() {
    var el = root();
    var attr = el && el.getAttribute ? el.getAttribute('data-theme') : null;
    if (VALID[attr]) return attr;
    return normalize(readStored());
  }

  /* ------------------------------------------------------------------ */
  /* Monaco integration                                                  */
  /* ------------------------------------------------------------------ */
  function monacoThemeName(theme) {
    return MONACO_THEME[normalize(theme)];
  }

  function pushToMonaco(theme) {
    var editor = window.editor;
    if (!editor || typeof editor.setTheme !== 'function') return;
    try {
      editor.setTheme(monacoThemeName(theme));
    } catch (e) {
      console.warn('[AppTheme] Monaco setTheme failed:', e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */
  function get() {
    return current();
  }

  function set(theme) {
    var next = normalize(theme);
    writeStored(next);
    applyToDom(next);
    // Monaco is switched by the 'theme-changed' listener below, so the event
    // stays the single source of truth for both this call and external ones.
    try {
      window.dispatchEvent(
        new CustomEvent('theme-changed', { detail: { theme: next } })
      );
    } catch (e) {
      console.warn('[AppTheme] failed to dispatch theme-changed:', e);
    }
    return next;
  }

  function toggle() {
    return set(current() === 'light' ? 'dark' : 'light');
  }

  function onChange(handler) {
    window.addEventListener('theme-changed', function (e) {
      var theme = e && e.detail ? e.detail.theme : current();
      try {
        handler(theme);
      } catch (err) {
        console.error('[AppTheme] theme-changed handler error:', err);
      }
    });
    return handler;
  }

  window.AppTheme = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_THEME: DEFAULT_THEME,
    MONACO_THEME: MONACO_THEME,
    get: get,
    set: set,
    toggle: toggle,
    onChange: onChange,
    monacoThemeName: monacoThemeName,
    /** Push the current theme to Monaco if/once the editor manager exists. */
    syncMonaco: function () {
      pushToMonaco(current());
    }
  };

  // Other modules may want to react to theme changes.
  window.addEventListener('theme-changed', function () {
    pushToMonaco(current());
  });

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                           */
  /* ------------------------------------------------------------------ */
  // Run once now; if the document is still parsing, once more at
  // DOMContentLoaded. `booted` keeps that from applying the theme twice.
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;

    // Apply the stored (or default) theme immediately so the very first paint
    // is already correct — this is what prevents a dark flash.
    applyToDom(current());

    // Monaco may not exist yet (theme.js loads before app.js). Push straight
    // away if it does, then re-apply once it reports readiness.
    pushToMonaco(current());

    var editor = window.editor;
    if (editor && typeof editor.onDidReady === 'function') {
      try {
        editor.onDidReady(function () {
          pushToMonaco(current());
        });
      } catch (e) {
        console.warn('[AppTheme] onDidReady hook failed:', e);
      }
    }
  }

  // Apply as early as possible: immediately, and again once parsing finishes.
  // The `booted` guard means whichever happens first wins.
  boot();

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', boot);

    // Last chance: Monaco (or the editor manager) may only appear after the
    // monaco loader resolves, so re-sync on window load too.
    window.addEventListener('load', function () {
      var editor = window.editor;
      if (!editor) return;
      if (typeof editor.onDidReady === 'function') {
        // Fires immediately when the editor is already ready.
        try { editor.onDidReady(function () { pushToMonaco(current()); }); }
        catch (e) { /* ignore */ }
      } else {
        pushToMonaco(current());
      }
    });
  }
})();