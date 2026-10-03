// Main Application Coordinator
document.addEventListener('DOMContentLoaded', async () => {
  // 1) Load persisted settings first (other modules read them at runtime)
  if (window.AppSettings && window.AppSettings.load) {
    try { await window.AppSettings.load(); } catch (e) { console.warn('settings load failed', e); }
  }

  // 2) Initialize Core Subsystems
  window.editor = new EditorManager('monaco-host', 'tabs-bar');
  window.explorer = new FileExplorer('file-tree');
  window.terminal = new TerminalManager('terminal-view');
  window.ai = new AIAssistant('chat-messages', 'chat-input', 'send-msg-btn');

  // 3) Agentic modules (all self-guarded; classes defined in their own files).
  //    palette.js / settings.js / autocomplete.js also self-boot at parse time,
  //    so only create instances that don't already exist.
  window.agent = window.AgentController ? new AgentController() : null;
  if (!window.palette && window.CommandPalette) window.palette = new CommandPalette();
  if (!window.ghostAutocomplete && window.GhostAutocomplete) {
    window.__ghostAutocompleteBooted = true; // prevent the module's self-boot from double-instantiating
    window.ghostAutocomplete = new GhostAutocomplete();
  }
  if (!window.inlineEdit && window.InlineEdit) window.inlineEdit = new InlineEdit();
  if (!window.workspaceSearch && window.WorkspaceSearch) window.workspaceSearch = new WorkspaceSearch();
  if (!window.settingsModal && window.SettingsModal) window.settingsModal = new SettingsModal();

  // Show Chat/Agent run bar for the initial mode
  if (window.ai && window.agent) window.agent.setVisible(window.ai.mode === 'agent');

  // ---------------------------------------------------------------------------
  // Activity Bar Navigation
  // ---------------------------------------------------------------------------
  // Current sidebar view name (kept in sync with the active .sidebar-view).
  let sidebarView = 'explorer';

  function switchView(name) {
    // The AI/Agent view now lives in its own left panel, not in the sidebar.
    if (name === 'ai-chat') {
      toggleAgentPanel(true);
      return;
    }
    document.querySelectorAll('.activity-icon[data-view]').forEach((icon) => {
      icon.classList.toggle('active', icon.getAttribute('data-view') === name);
    });
    document.querySelectorAll('.sidebar-view').forEach((view) => {
      view.classList.toggle('active', view.id === `${name}-view`);
    });
    if (name === 'search' && window.workspaceSearch && window.workspaceSearch.focusInput) {
      window.workspaceSearch.focusInput();
    }
    sidebarView = name;
    syncNav();
  }
  window.switchSidebarView = switchView;

  document.querySelectorAll('.activity-icon[data-view]').forEach((icon) => {
    icon.addEventListener('click', () => switchView(icon.getAttribute('data-view')));
  });

  // ---------------------------------------------------------------------------
  // Agent Panel (left side, between the sidebar and the editor)
  // ---------------------------------------------------------------------------
  const agentPanel = document.getElementById('agent-panel');

  function toggleAgentPanel(force) {
    if (!agentPanel) return false;
    const willShow = (typeof force === 'boolean') ? force : agentPanel.classList.contains('hidden');
    agentPanel.classList.toggle('hidden', !willShow);
    document.querySelectorAll('.activity-icon[data-panel-toggle="ai"]').forEach((icon) => {
      icon.classList.toggle('active', willShow);
    });
    if (willShow && window.ai && window.ai.input) {
      try { window.ai.input.focus(); } catch (e) { /* input not ready */ }
    }
    if (window.editor && typeof window.editor.relayout === 'function') window.editor.relayout();
    syncNav();
    return willShow;
  }
  window.toggleAgentPanel = toggleAgentPanel;
  window.isAgentPanelOpen = () => !!(agentPanel && !agentPanel.classList.contains('hidden'));

  document.querySelectorAll('.activity-icon[data-panel-toggle]').forEach((icon) => {
    icon.addEventListener('click', () => toggleAgentPanel());
  });

  // Reflect the panel's initial state on the activity icon.
  if (agentPanel) {
    document.querySelectorAll('.activity-icon[data-panel-toggle="ai"]').forEach((icon) => {
      icon.classList.toggle('active', !agentPanel.classList.contains('hidden'));
    });

    // Drag handle on the panel's left edge to resize it.
    const resizer = document.createElement('div');
    resizer.id = 'agent-resizer';
    resizer.title = 'Drag to resize the agent panel';
    agentPanel.appendChild(resizer);

    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      resizer.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // The panel is docked right, so its width is the gap to the window edge.
      const width = Math.min(720, Math.max(260, window.innerWidth - e.clientX));
      agentPanel.style.width = width + 'px';
      if (window.terminal && window.terminal.fit) window.terminal.fit();
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      if (window.editor && typeof window.editor.relayout === 'function') window.editor.relayout();
      if (window.terminal && window.terminal.fit) window.terminal.fit();
    });
  }

  // "Open Folder" button on the empty state.
  const emptyOpenFolderBtn = document.getElementById('empty-open-folder-btn');
  if (emptyOpenFolderBtn) emptyOpenFolderBtn.onclick = () => window.explorer.openFolder();

  // ---------------------------------------------------------------------------
  // Top Bar Action Buttons
  // ---------------------------------------------------------------------------
  const openFolderTopBtn = document.getElementById('open-folder-top-btn');
  if (openFolderTopBtn) openFolderTopBtn.onclick = () => window.explorer.openFolder();

  const toggleTerminalBtn = document.getElementById('toggle-terminal-btn');
  const bottomPanel = document.getElementById('bottom-panel');
  if (toggleTerminalBtn && bottomPanel) {
    toggleTerminalBtn.onclick = () => {
      if (bottomPanel.style.display === 'none') {
        bottomPanel.style.display = 'flex';
        window.terminal.fit();
      } else {
        bottomPanel.style.display = 'none';
      }
      syncNav();
    };
  }

  // ---------------------------------------------------------------------------
  // Top navigation bar (VS Code-style: Explorer | Search | Terminal | Agent)
  // ---------------------------------------------------------------------------
  const sidebarEl = document.getElementById('sidebar');
  const navExplorerBtn = document.getElementById('nav-explorer-btn');
  const navSearchBtn = document.getElementById('nav-search-btn');
  const navTerminalBtn = document.getElementById('nav-terminal-btn');
  const navAgentBtn = document.getElementById('nav-agent-btn');

  const isSidebarOpen = () => !!(sidebarEl && !sidebarEl.classList.contains('hidden'));
  const isTerminalOpen = () => !bottomPanel || bottomPanel.style.display !== 'none';

  function syncNav() {
    const open = isSidebarOpen();
    if (navExplorerBtn) navExplorerBtn.classList.toggle('active', open && sidebarView === 'explorer');
    if (navSearchBtn) navSearchBtn.classList.toggle('active', open && sidebarView === 'search');
    if (navTerminalBtn) navTerminalBtn.classList.toggle('active', isTerminalOpen());
    if (navAgentBtn) {
      navAgentBtn.classList.toggle('active', window.isAgentPanelOpen ? window.isAgentPanelOpen() : true);
    }
    if (navThemeLabel && window.AppTheme && window.AppTheme.get) {
      navThemeLabel.textContent = window.AppTheme.get() === 'dark' ? 'Dark' : 'Light';
    }
  }

  /** Show a sidebar view, opening the sidebar if it was collapsed. */
  function showSidebar(name) {
    if (sidebarEl) sidebarEl.classList.remove('hidden');
    switchSidebarView(name);
    if (window.editor && typeof window.editor.relayout === 'function') window.editor.relayout();
    syncNav();
  }

  /** Toggle the sidebar; when opening, switch to the requested view. */
  function toggleSidebar(name) {
    if (isSidebarOpen()) {
      if (sidebarEl) sidebarEl.classList.add('hidden');
    } else {
      if (sidebarEl) sidebarEl.classList.remove('hidden');
      switchSidebarView(name);
    }
    if (window.editor && typeof window.editor.relayout === 'function') window.editor.relayout();
    syncNav();
  }

  if (navExplorerBtn) {
    navExplorerBtn.onclick = () => {
      if (isSidebarOpen() && sidebarView === 'explorer') {
        toggleSidebar('explorer');            // collapse
      } else {
        showSidebar('explorer');              // open / switch to explorer
      }
    };
  }
  // Search always opens the sidebar and focuses the input (never collapses).
  if (navSearchBtn) navSearchBtn.onclick = () => showSidebar('search');
  if (navTerminalBtn) {
    navTerminalBtn.onclick = () => {
      if (toggleTerminalBtn) toggleTerminalBtn.click();
    };
  }
  if (navAgentBtn) navAgentBtn.onclick = () => toggleAgentPanel();

  // Light / dark theme toggle.
  const navThemeBtn = document.getElementById('nav-theme-btn');
  const navThemeLabel = document.getElementById('nav-theme-label');
  if (navThemeBtn) {
    navThemeBtn.onclick = () => {
      if (window.AppTheme && window.AppTheme.toggle) window.AppTheme.toggle();
      syncNav();
    };
  }
  window.addEventListener('theme-changed', syncNav);

  const paletteBtn = document.getElementById('command-palette-btn');
  if (paletteBtn && window.palette) {
    paletteBtn.onclick = () => window.palette.open('commands');
  }

  // ---------------------------------------------------------------------------
  // Explorer Header Action Buttons
  // ---------------------------------------------------------------------------
  const newFileBtn = document.getElementById('new-file-btn');
  if (newFileBtn) newFileBtn.onclick = () => window.explorer.createNewFile();

  const newFolderBtn = document.getElementById('new-folder-btn');
  if (newFolderBtn) newFolderBtn.onclick = () => window.explorer.createNewFolder();

  const refreshExplorerBtn = document.getElementById('refresh-explorer-btn');
  if (refreshExplorerBtn) refreshExplorerBtn.onclick = () => window.explorer.render();

  // ---------------------------------------------------------------------------
  // Settings (real modal instead of alert())
  // ---------------------------------------------------------------------------
  const settingsBtn = document.getElementById('open-settings-btn');
  if (settingsBtn) {
    settingsBtn.onclick = () => {
      if (window.settingsModal) window.settingsModal.open();
      else if (window.electronAPI && window.electronAPI.getAiConfig) {
        window.electronAPI.getAiConfig().then((c) =>
          alert(`API: ${c.baseUrl}\nKey: ${c.apiKey}\nModel: ${c.model}`));
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Command Palette — command registry
  // ---------------------------------------------------------------------------
  const quickPrompt = (text) => {
    if (window.ai) {
      switchSidebarView('ai-chat');
      window.ai.sendPromptWithContext(text);
    }
  };

  if (window.palette) {
    const P = window.palette;
    P.register('file.openFolder', { title: 'File: Open Folder…', keyHint: 'Ctrl+O', category: 'File', handler: () => window.explorer.openFolder() });
    P.register('file.newFile', { title: 'File: New File', category: 'File', handler: () => window.explorer.createNewFile() });
    P.register('file.newFolder', { title: 'File: New Folder', category: 'File', handler: () => window.explorer.createNewFolder() });
    P.register('file.save', { title: 'File: Save', keyHint: 'Ctrl+S', category: 'File', handler: () => window.editor.saveActiveFile() });
    P.register('file.saveAll', { title: 'File: Save All', category: 'File', handler: () => window.editor.saveAllFiles() });
    P.register('file.closeEditor', { title: 'View: Close Editor', keyHint: 'Ctrl+W', category: 'View', handler: () => { if (window.editor.activeKey) window.editor.closeByKey(window.editor.activeKey); } });

    P.register('view.terminal', { title: 'View: Toggle Terminal', keyHint: 'Ctrl+`', category: 'View', handler: () => { if (toggleTerminalBtn) toggleTerminalBtn.click(); } });
    P.register('view.explorer', { title: 'View: Show Explorer', keyHint: 'Ctrl+Shift+E', category: 'View', handler: () => switchSidebarView('explorer') });
    P.register('view.search', { title: 'View: Find in Files', keyHint: 'Ctrl+Shift+F', category: 'View', handler: () => switchSidebarView('search') });
    P.register('view.aiChat', { title: 'View: Show AI Chat', category: 'View', handler: () => switchSidebarView('ai-chat') });
    P.register('view.toggleAgentPanel', { title: 'View: Toggle Agent Panel', keyHint: 'Ctrl+Shift+A', category: 'View', handler: () => toggleAgentPanel() });

    P.register('ai.agentMode', { title: 'AI: Switch to Agent Mode', category: 'AI', handler: () => { switchSidebarView('ai-chat'); if (window.ai) { window.ai.setMode('agent'); window.ai.input.focus(); } } });
    P.register('ai.chatMode', { title: 'AI: Switch to Chat Mode', category: 'AI', handler: () => { switchSidebarView('ai-chat'); if (window.ai) window.ai.setMode('chat'); } });
    P.register('ai.newTask', { title: 'Agent: New Task', category: 'Agent', handler: () => { switchSidebarView('ai-chat'); if (window.agent) window.agent.newTask(); if (window.ai) { window.ai.setMode('agent'); window.ai.input.focus(); } } });
    P.register('ai.clearChat', { title: 'Agent/Clear Chat History', category: 'AI', handler: () => { const b = document.getElementById('clear-chat-btn'); if (b) b.click(); } });
    P.register('ai.explain', { title: 'AI: Explain Selected Code', category: 'AI', handler: () => quickPrompt('Explain this selected code') });
    P.register('ai.findBugs', { title: 'AI: Find Bugs in Selected Code', category: 'AI', handler: () => quickPrompt('Find potential bugs and optimize this code') });
    P.register('ai.refactor', { title: 'AI: Refactor Selected Code', category: 'AI', handler: () => quickPrompt('Refactor this code cleanly') });
    P.register('ai.tests', { title: 'AI: Generate Unit Tests', category: 'AI', handler: () => quickPrompt('Generate comprehensive unit tests for this code') });

    P.register('prefs.settings', { title: 'Preferences: Open Settings', keyHint: 'Ctrl+,', category: 'Preferences', handler: () => window.settingsModal && window.settingsModal.open() });
    P.register('prefs.autocomplete', { title: 'Preferences: Toggle Ghost-Text Autocomplete', category: 'Preferences', handler: () => {
      const cur = window.AppSettings ? window.AppSettings.get('autocompleteEnabled') : true;
      if (window.AppSettings) window.AppSettings.set('autocompleteEnabled', !cur);
    } });
    P.register('agent.reviewChanges', { title: 'Agent: Review Workspace Changes', category: 'Agent', handler: () => { if (window.agent) window.agent.toggleChangesPopup(); } });

    // Generate an image through the configured OpenAI-compatible endpoint and
    // open it in the editor's image viewer.
    P.register('ai.generateImage', {
      title: 'AI: Generate Image…',
      category: 'AI',
      handler: async () => {
        const api = window.electronAPI;
        if (!api || !api.generateImage) {
          alert('Image generation is not available in this build.');
          return;
        }
        const root = window.explorer.rootPath;
        if (!root) {
          alert('Open a folder first — generated images are saved inside the workspace.');
          return;
        }
        let prompt;
        try {
          prompt = await window.explorer.askName('Describe the image you want', '');
        } catch (e) {
          return;
        }
        if (!prompt) return;

        const status = document.getElementById('statusbar-ai-status');
        if (status) status.textContent = '● Generating image…';
        let res;
        try {
          res = await api.generateImage({ prompt: prompt, size: '1024x1024' });
        } catch (err) {
          res = { error: (err && err.message) || String(err) };
        }
        if (status) status.textContent = '● AI Ready';

        if (!res || res.error || (!res.dataUrl && !res.url)) {
          alert('Image generation failed:\n' + ((res && res.error) || 'No image returned.'));
          return;
        }
        const dataUrl = res.dataUrl || res.url;
        const name = 'generated/image-' + Date.now();
        const written = await api.writeBase64(root + '/' + name, dataUrl);
        if (!written || !written.ok) {
          alert('Could not save the image:\n' + ((written && written.error) || 'unknown error'));
          return;
        }
        await window.explorer.render();
        window.editor.openFile(written.path, '');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key;

    if (k === 'o' || k === 'O') {
      e.preventDefault();
      window.explorer.openFolder();
    } else if (k === 's' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      window.editor.saveActiveFile();
    } else if (k === 'S' && e.shiftKey) {
      e.preventDefault();
      window.editor.saveAllFiles();
    } else if (k === '`') {
      e.preventDefault();
      if (toggleTerminalBtn) toggleTerminalBtn.click();
    } else if (k === 'w' || k === 'W') {
      const paletteOpen = !!(window.palette && typeof window.palette.isOpen === 'function' && window.palette.isOpen());
      if (!paletteOpen && window.editor && window.editor.activeKey) {
        e.preventDefault();
        window.editor.closeByKey(window.editor.activeKey);
      }
    } else if (e.shiftKey && (k === 'e' || k === 'E')) {
      e.preventDefault();
      showSidebar('explorer');
    } else if (e.shiftKey && (k === 'f' || k === 'F')) {
      e.preventDefault();
      showSidebar('search');
    } else if (e.shiftKey && (k === 'a' || k === 'A')) {
      e.preventDefault();
      toggleAgentPanel();
    } else if (k === ',') {
      e.preventDefault();
      if (window.settingsModal) window.settingsModal.open();
    }
  });

  // ---------------------------------------------------------------------------
  // Startup: open NO project — the IDE starts empty and the user picks a
  // folder with Ctrl+O / the Open Folder button / the top-bar folder icon.
  // ---------------------------------------------------------------------------
  const startEmptyState = () => {
    switchSidebarView('explorer');
    const empty = document.getElementById('empty-state');
    if (empty) empty.style.display = '';
  };
  setTimeout(startEmptyState, 150);
});
