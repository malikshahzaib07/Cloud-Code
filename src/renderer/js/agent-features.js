// Cloud Code — advanced agent features: live plan checklist, run summary
// card, and a "Dry run" approval-gate toggle chip.
// Exposes window.AgentFeatures and auto-boots on DOMContentLoaded.
// Consumes the same window events agent.js dispatches:
//   agent:thinking   {detail:{phase, text, step}}
//   agent:tool-start {detail:{name}}
//   agent:tool-end   {detail:{name, ok}}
//   agent:run-finished {detail:{durationMs, tools, filesChanged, commands, ok}}

(function () {
  'use strict';

  const MAX_PLAN_ITEMS = 8;
  const MAX_PARSE_LINES = 6;

  const state = {
    planCard: null,
    planItems: [],
    planIndex: 0,
    planText: '',
    sawPlanText: false,
    runActive: false,
    chipInserted: false
  };

  function $(sel) { return document.querySelector(sel); }

  function messagesEl() { return document.getElementById('chat-messages'); }

  // --------------------------------------------------------------------------
  // Live plan checklist
  // --------------------------------------------------------------------------
  function parsePlanLines(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    // Split on newlines first; also break inline numbered lists ("1. x 2. y").
    const rough = text
      .replace(/(\d+)[.)]\s+/g, '\n$1. ')
      .split(/\r?\n/);
    for (const raw of rough) {
      const line = raw
        .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
        .replace(/^\s*[—–-]\s*/, '')
        .trim();
      // Skip empty, very short, or meta lines
      if (line.length < 3 || line.length > 120) continue;
      if (/^(planning|thinking|let me|i[' ]?m|first|okay|ok|hmm|alright|now|to (?:do|start|figure|solve)|i need to|the (?:user|request)|so|well)\b/i.test(line)) continue;
      if (/^[\s\W]+$/.test(line)) continue; // only punctuation/whitespace
      out.push(line);
      if (out.length >= MAX_PARSE_LINES) break;
    }
    return out;
  }

  function buildPlanCard(lines) {
    const container = messagesEl();
    if (!container) return null;
    removePlanCard();
    const el = document.createElement('div');
    el.className = 'cc-plan-card';
    el.innerHTML = '<div class="cc-plan-title">📋 Plan</div><ol class="cc-plan-list"></ol>';
    const ol = el.querySelector('.cc-plan-list');
    state.planItems = (lines && lines.length ? lines : ['Working on your request…']).slice(0, MAX_PLAN_ITEMS);
    state.planIndex = 0;
    for (const line of state.planItems) {
      const li = document.createElement('li');
      li.className = 'cc-plan-item';
      li.innerHTML = '<span class="cc-plan-mark"></span><span class="cc-plan-text"></span>';
      li.querySelector('.cc-plan-text').textContent = line;
      ol.appendChild(li);
    }
    // Insert at the top of the message stream so it reads as a plan.
    // If there's a thinking panel, insert after it; otherwise at the very top.
    const thinkPanel = container.querySelector('.think-panel');
    if (thinkPanel && thinkPanel.nextSibling) {
      container.insertBefore(el, thinkPanel.nextSibling);
    } else {
      container.insertBefore(el, container.firstChild);
    }
    state.planCard = el;
    scrollToBottom();
    return el;
  }

  function removePlanCard() {
    if (state.planCard && state.planCard.parentNode) {
      state.planCard.parentNode.removeChild(state.planCard);
    }
    state.planCard = null;
    state.planItems = [];
    state.planIndex = 0;
  }

  function setPlanItemState(index, kind) {
    if (!state.planCard) return;
    const lis = state.planCard.querySelectorAll('.cc-plan-item');
    const li = lis[index];
    if (!li) return;
    li.classList.remove('is-active', 'is-done');
    const mark = li.querySelector('.cc-plan-mark');
    if (kind === 'active') {
      li.classList.add('is-active');
      if (mark) mark.innerHTML = '<span class="cc-plan-spinner"></span>';
    } else if (kind === 'done') {
      li.classList.add('is-done');
      if (mark) mark.textContent = '✓';
    } else {
      if (mark) mark.textContent = '';
    }
  }

  function onToolStart() {
    if (!state.runActive) {
      // Run may have started while "Think: Off" suppressed thinking events.
      state.runActive = true;
      if (!state.planCard) buildPlanCard([]);
    } else if (!state.planCard) {
      buildPlanCard([]);
    }
    // Tick items off in order: the current one shows a spinner.
    if (state.planIndex < state.planItems.length) {
      setPlanItemState(state.planIndex, 'active');
    }
  }

  function onToolEnd() {
    if (state.planIndex < state.planItems.length) {
      setPlanItemState(state.planIndex, 'done');
      state.planIndex += 1;
    }
  }

  function onThinking(e) {
    const d = (e && e.detail) || {};
    const phase = d.phase;
    const text = typeof d.text === 'string' ? d.text : '';
    const step = d.step || 0;

    if (phase === 'planning' && step <= 1 && !state.planCard) {
      state.runActive = true;
      state.planText = '';
      state.sawPlanText = false;
    }
    if (phase === 'thinking' && text && !state.sawPlanText) {
      state.sawPlanText = true;
      state.planText = text;
      // Upgrade a generic card to a parsed one if we now have plan text.
      if (state.planCard && state.planIndex === 0) {
        const parsed = parsePlanLines(text);
        if (parsed.length) buildPlanCard(parsed);
      }
    }
    if (phase === 'planning' && step === 1 && !state.planCard) {
      buildPlanCard(parsePlanLines(state.planText));
    }
    if (phase === 'done') {
      state.runActive = false;
      // The run-finished event will handle removing the plan card and showing summary.
    }
  }

  function scrollToBottom() {
    try {
      if (window.ai && typeof window.ai.scrollToBottom === 'function') {
        window.ai.scrollToBottom(true); // force=true to ensure it scrolls
      }
    } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Run summary card
  // --------------------------------------------------------------------------
  function formatDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm ' + (s % 60) + 's';
  }

  function renderRunSummary(summary) {
    const container = messagesEl();
    if (!container || !summary) return;
    removePlanCard();
    state.runActive = false;
    const el = document.createElement('div');
    el.className = 'cc-run-summary' + (summary.ok === false ? ' is-stopped' : '');
    const title = summary.ok === false ? '⏹ Run ended' : '✅ Run finished';
    el.innerHTML =
      '<div class="cc-run-summary-head"><span class="cc-run-summary-title"></span>' +
      '<button class="cc-run-revert agent-mini-btn" type="button">↺ Revert all</button></div>' +
      '<div class="cc-run-summary-stats"></div>';
    el.querySelector('.cc-run-summary-title').textContent = title;
    el.querySelector('.cc-run-summary-stats').textContent =
      'Duration ' + formatDuration(summary.durationMs) +
      ' · ' + (summary.tools || 0) + ' tools' +
      ' · ' + (summary.filesChanged || 0) + ' files changed' +
      ' · ' + (summary.commands || 0) + ' commands';
    const btn = el.querySelector('.cc-run-revert');
    const canRevert = window.agent && typeof window.agent.revertChange === 'function' && window.agent.changes && window.agent.changes.size > 0;
    if (!canRevert) btn.style.display = 'none';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '↺ Reverting…';
      try {
        const paths = window.agent && window.agent.changes ? Array.from(window.agent.changes.keys()) : [];
        for (const p of paths) {
          try { await window.agent.revertChange(p); } catch (err) { console.error(err); }
        }
        if (window.agent && typeof window.agent.renderChangesList === 'function') window.agent.renderChangesList();
        btn.textContent = '✓ Reverted';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = '↺ Revert all'; }, 800);
      }
    });
    container.appendChild(el);
    scrollToBottom();
  }

  // --------------------------------------------------------------------------
  // Dry-run toggle chip
  // --------------------------------------------------------------------------
  function readDryRun() {
    try { return localStorage.getItem('cc.agentDryRun') === '1'; } catch (e) { return false; }
  }

  function applyDryRun(on) {
    window.agentDryRun = !!on;
    try { localStorage.setItem('cc.agentDryRun', on ? '1' : '0'); } catch (e) { /* private mode */ }
    const chip = document.getElementById('cc-dryrun-chip');
    if (chip) chip.classList.toggle('is-on', !!on);
  }

  function ensureChip() {
    if (document.getElementById('cc-dryrun-chip')) { state.chipInserted = true; return; }
    const bar = document.getElementById('agent-run-bar');
    if (!bar) return;
    const label = document.createElement('label');
    label.id = 'cc-dryrun-chip';
    label.className = 'cc-dryrun-chip' + (window.agentDryRun ? ' is-on' : '');
    label.title = 'Dry run: force the approval gate on for every edit and command, even in Fully-auto mode.';
    label.innerHTML = '<input type="checkbox" id="cc-dryrun-toggle" /> <span>Dry run</span>';
    const input = label.querySelector('input');
    input.checked = !!window.agentDryRun;
    input.addEventListener('change', () => applyDryRun(input.checked));
    // Place it inside the run bar, right after the Stop button when present.
    const stopBtn = document.getElementById('agent-stop-btn');
    if (stopBtn && stopBtn.parentNode === bar) {
      bar.insertBefore(label, stopBtn.nextSibling);
    } else {
      bar.appendChild(label);
    }
    state.chipInserted = true;
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  function boot() {
    window.agentDryRun = readDryRun();
    window.addEventListener('agent:thinking', onThinking);
    window.addEventListener('agent:tool-start', onToolStart);
    window.addEventListener('agent:tool-end', onToolEnd);
    window.addEventListener('agent:run-finished', (e) => renderRunSummary(e && e.detail));
    ensureChip();
    // The run bar is built by AgentController; it may appear after this boot.
    let tries = 0;
    const timer = setInterval(() => {
      ensureChip();
      tries += 1;
      if ((state.chipInserted && document.getElementById('cc-dryrun-chip')) || tries > 40) clearInterval(timer);
    }, 500);
  }

  window.AgentFeatures = {
    boot,
    buildPlanCard,
    removePlanCard,
    renderRunSummary,
    applyDryRun,
    isDryRun: () => !!window.agentDryRun,
    parsePlanLines,
    _state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();