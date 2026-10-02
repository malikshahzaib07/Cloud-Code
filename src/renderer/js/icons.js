// VS Code file & folder icons SVG mapping
const VSCODE_ICONS = {
  // Folders
  folder: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#dcb67a"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4H7.414l-1.707-1.707A1 1 0 0 0 5 2H1.5z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#e8c287"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 6H8.414l-1.707-1.707A1 1 0 0 0 6 4H1.5z"/></svg>`,

  // Generic File
  file: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#8c8c8c"><path d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 1v3h3L9 2z"/></svg>`,

  // Programming Languages
  js: `<svg viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="2" fill="#f7df1e"/><path d="M5.5 12c-.9 0-1.4-.4-1.7-.9l.9-.6c.2.4.4.6.8.6.4 0 .7-.2.7-.6V6.5h1.2V10.5c0 1-.7 1.5-1.9 1.5zm5.3-.1c-.9 0-1.6-.5-1.9-1.2l.9-.5c.2.4.5.7 1 .7.4 0 .8-.2.8-.5 0-.4-.3-.5-.9-.7l-.5-.2c-.9-.4-1.3-.8-1.3-1.6 0-.9.7-1.5 1.8-1.5.8 0 1.4.3 1.7.8l-.8.5c-.2-.3-.5-.4-.9-.4-.4 0-.7.2-.7.5 0 .3.2.4.8.6l.4.2c1 .4 1.4.9 1.4 1.7 0 1-.8 1.4-1.9 1.4z" fill="#000"/></svg>`,
  ts: `<svg viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="2" fill="#3178c6"/><path d="M4.2 6.5h3.6v1H6.5v4.5h-1V7.5H4.2v-1zm6.7 5.4c-.9 0-1.6-.5-1.9-1.2l.9-.5c.2.4.5.7 1 .7.4 0 .8-.2.8-.5 0-.4-.3-.5-.9-.7l-.5-.2c-.9-.4-1.3-.8-1.3-1.6 0-.9.7-1.5 1.8-1.5.8 0 1.4.3 1.7.8l-.8.5c-.2-.3-.5-.4-.9-.4-.4 0-.7.2-.7.5 0 .3.2.4.8.6l.4.2c1 .4 1.4.9 1.4 1.7 0 1-.8 1.4-1.9 1.4z" fill="#fff"/></svg>`,
  json: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#cbcb41"><path d="M4.5 2A1.5 1.5 0 0 0 3 3.5V6a1 1 0 0 1-1 1v2a1 1 0 0 1 1 1v2.5A1.5 1.5 0 0 0 4.5 14h1v-1h-1a.5.5 0 0 1-.5-.5V9.667A1.5 1.5 0 0 0 2.5 8 1.5 1.5 0 0 0 4 6.333V3.5a.5.5 0 0 1 .5-.5h1V2h-1zm7 0h-1v1h1a.5.5 0 0 1 .5.5v2.833A1.5 1.5 0 0 0 13.5 8a1.5 1.5 0 0 0-1.5 1.667V12.5a.5.5 0 0 1-.5.5h-1v1h1a1.5 1.5 0 0 0 1.5-1.5V10a1 1 0 0 1 1-1V7a1 1 0 0 1-1-1V3.5A1.5 1.5 0 0 0 11.5 2z"/></svg>`,
  html: `<svg viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="2" fill="#e34f26"/><path d="M3.5 3l.8 9 3.7 1 3.7-1 .8-9H3.5zm7.3 2.5l-.2 2H6.3l.1 1.2h4l-.3 3.5-2.1.6-2.1-.6-.1-1.3h1.2l.1.5 1 .3 1-.3.1-1.1H5.1l-.3-3.6h5.8l.2-1.5H4.6l-.2-1.1h6.6z" fill="#fff"/></svg>`,
  css: `<svg viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="2" fill="#1572b6"/><path d="M3.5 3l.8 9 3.7 1 3.7-1 .8-9H3.5zm7.3 2.5l-.2 2H6.3l.1 1.2h4l-.3 3.5-2.1.6-2.1-.6-.1-1.3h1.2l.1.5 1 .3 1-.3.1-1.1H5.1l-.3-3.6h5.8l.2-1.5H4.6l-.2-1.1h6.6z" fill="#fff"/></svg>`,
  python: `<svg viewBox="0 0 16 16" width="16" height="16"><path d="M7.8 1.5c-2.3 0-2.2 1-2.2 1l.01 1.1h2.2v.3H4.7c-1.5 0-2.2.8-2.2 2.2 0 1.4.6 2.2 2.2 2.2h.7v-1.1c0-.7.6-1.3 1.3-1.3h2.3c.6 0 1.2-.5 1.2-1.2V2.7c0-.7-.6-1.2-2.4-1.2zm-1.1.7a.4.4 0 1 1 0 .8.4.4 0 0 1 0-.8z" fill="#387eb8"/><path d="M8.2 14.5c2.3 0 2.2-1 2.2-1l-.01-1.1h-2.2v-.3h3.1c1.5 0 2.2-.8 2.2-2.2 0-1.4-.6-2.2-2.2-2.2h-.7v1.1c0 .7-.6 1.3-1.3 1.3H7.1c-.6 0-1.2.5-1.2 1.2v2.1c0 .7.6 1.2 2.3 1.2zm1.1-.7a.4.4 0 1 1 0-.8.4.4 0 0 1 0 .8z" fill="#ffe052"/></svg>`,
  markdown: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#42a5f5"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM3 5v6h1.5V7.5l1.5 2 1.5-2V11H9V5H7.5L6 7.2 4.5 5H3zm8 0v3.5h-1.5L11.5 11l2-2.5H12V5h-1z"/></svg>`,
  git: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#f05032"><path d="M15.4 7.4L8.6.6a1 1 0 0 0-1.4 0L5.7 2.1l2.1 2.1a1.5 1.5 0 0 1 1.9 1.9l2.1 2.1a1.5 1.5 0 1 1-.7.7L9 6.8v4.4a1.5 1.5 0 1 1-1 0V6.6a1.5 1.5 0 0 1-.8-.8L5.1 7.9a1.5 1.5 0 1 1-.7-.7l2.1-2.1-2.9-2.9-3 3a1 1 0 0 0 0 1.4l6.8 6.8a1 1 0 0 0 1.4 0l6.6-6.6a1 1 0 0 0 0-1.4z"/></svg>`,
  env: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#eccb50"><path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zm1 8.5v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 2 0zM7 4a1 1 0 0 1 2 0v2H7V4z"/></svg>`,
  image: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#a074c4"><path d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H2zm1 2h10v6.3l-2.5-2.5a.7.7 0 0 0-1 0L7.4 9.9 5.7 8.2a.7.7 0 0 0-1 0L3 9.9V4zm3 2.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>`,
  rust: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#dea584"><circle cx="8" cy="8" r="6" stroke="#dea584" stroke-width="1.5" fill="none"/><path d="M7 5h2v6H7zM5 7h6v2H5z"/></svg>`,
  cpp: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#00599c"><path d="M8 1a7 7 0 1 0 7 7h-2a5 5 0 1 1-5-5V1zm3 6h1V6h1v1h1v1h-1v1h-1V8h-1V7z"/></svg>`,
  java: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#ea2d2e"><path d="M5.5 12.5s-1.5.3-1.5 1.2c0 .8 1.4 1.3 4 1.3s4-.5 4-1.3c0-.9-1.5-1.2-1.5-1.2-2 .4-3 .4-5 0zm6.2-3.8c.8 0 1.8-.4 1.8-1.5 0-1.1-.9-1.7-1.8-1.7v3.2zm-2-4.5c.3.5.7 1.1.7 1.8 0 1.2-.8 2-1.9 2-1.4 0-2.4-1.3-2.4-2.7 0-.7.3-1.4.7-1.9-1.8 1.4-1.9 3.9-.3 5.4.8.8 2 1.2 3.1 1.2 1.9 0 3.3-1.1 3.3-2.7 0-1.5-1-2.5-1.9-3.1-.4-.3-.9-.6-1.3-1z"/></svg>`,
  go: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#00add8"><circle cx="5" cy="8" r="3"/><circle cx="11" cy="8" r="3"/></svg>`
};

function getFileIcon(filename, isDirectory = false, isOpen = false) {
  if (isDirectory) {
    return isOpen ? VSCODE_ICONS.folderOpen : VSCODE_ICONS.folder;
  }

  const lower = filename.toLowerCase();

  if (lower.startsWith('.env')) return VSCODE_ICONS.env;
  if (lower.startsWith('.git')) return VSCODE_ICONS.git;

  const ext = lower.split('.').pop();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return VSCODE_ICONS.js;
    case 'ts':
    case 'tsx':
      return VSCODE_ICONS.ts;
    case 'json':
      return VSCODE_ICONS.json;
    case 'html':
    case 'htm':
      return VSCODE_ICONS.html;
    case 'css':
    case 'scss':
    case 'less':
      return VSCODE_ICONS.css;
    case 'py':
    case 'pyw':
      return VSCODE_ICONS.python;
    case 'md':
    case 'markdown':
      return VSCODE_ICONS.markdown;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'ico':
    case 'webp':
      return VSCODE_ICONS.image;
    case 'rs':
      return VSCODE_ICONS.rust;
    case 'cpp':
    case 'cc':
    case 'c':
    case 'h':
    case 'hpp':
      return VSCODE_ICONS.cpp;
    case 'java':
      return VSCODE_ICONS.java;
    case 'go':
      return VSCODE_ICONS.go;
    default:
      return VSCODE_ICONS.file;
  }
}

function getLanguageFromFilename(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'json':
      return 'json';
    case 'py':
      return 'python';
    case 'md':
      return 'markdown';
    case 'rs':
      return 'rust';
    case 'cpp':
    case 'cc':
    case 'c':
    case 'h':
      return 'cpp';
    case 'java':
      return 'java';
    case 'go':
      return 'go';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'ps1':
      return 'powershell';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
      return 'xml';
    default:
      return 'plaintext';
  }
}

window.getFileIcon = getFileIcon;
window.getLanguageFromFilename = getLanguageFromFilename;
