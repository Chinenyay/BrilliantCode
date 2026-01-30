import hljs from 'highlight.js/lib/core';
import { setupUpdateCheck } from './updateCheck.js';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import jsonLang from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import python from 'highlight.js/lib/languages/python';
import markdown from 'highlight.js/lib/languages/markdown';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import cLang from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import scala from 'highlight.js/lib/languages/scala';
import shell from 'highlight.js/lib/languages/shell';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import plaintext from 'highlight.js/lib/languages/plaintext';
import 'highlight.js/styles/github-dark.css';

// Renderer boot script. Manages UI state, wires DOM controls to the preload
// surface, and renders live AI responses (including tool progress + reasoning
// traces) as they stream in from the main process.

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('python', python);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cLang);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('toml', ini);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('scala', scala);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('plaintext', plaintext);

const assistantMessageRawContent = new WeakMap<HTMLElement, string>();
const TOKEN_PREFIX = '\uFFF0';
const TOKEN_SUFFIX = '\uFFF1';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }
  return trimmed;
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function normalizePreviewUrl(rawUrl: string): string | null {
  let url = rawUrl?.trim();
  if (!url) return null;
  if (/^workspace:\/\//i.test(url)) return url;
  if (/^([a-z][a-z0-9+.-]*):\/\//i.test(url)) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return url;
  if (/^[a-zA-Z]:\\/.test(url)) return url;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d{2,5})?(\/.*)?$/i.test(url)) {
    return url.startsWith('http://') || url.startsWith('https://') ? url : `http://${url}`;
  }
  if (looksLikeDomain(url)) return `https://${url}`;
  return url;
}

function applyInlineMarkdown(text: string): string {
  const placeholders: string[] = [];
  const addPlaceholder = (html: string): string => {
    const token = `${TOKEN_PREFIX}${placeholders.length}${TOKEN_SUFFIX}`;
    placeholders.push(html);
    return token;
  };

  let working = text ?? '';

  // Inline code
  working = working.replace(/`([^`]+)`/g, (_, code) => addPlaceholder(`<code>${escapeHtml(code)}</code>`));

  // Images
  working = working.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return alt;
    return addPlaceholder(`<img src="${escapeAttribute(safeUrl)}" alt="${escapeHtml(alt)}">`);
  });

  // Links
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return label;
    const lower = safeUrl.toLowerCase();
    const isWorkspaceLink = lower.startsWith('workspace://');
    const attrs = isWorkspaceLink
      ? `href="${escapeAttribute(safeUrl)}" data-workspace-link="true"`
      : `href="${escapeAttribute(safeUrl)}" target="_blank" rel="noopener noreferrer"`;
    return addPlaceholder(`<a ${attrs}>${escapeHtml(label)}</a>`);
  });

  let escaped = escapeHtml(working);

  escaped = escaped.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');
  escaped = escaped.replace(/(\*|_)([^*_]+?)\1/g, '<em>$2</em>');
  escaped = escaped.replace(/~~(.+?)~~/g, '<del>$1</del>');

  escaped = escaped.replace(/ {2,}\n/g, '<br />');
  escaped = escaped.replace(/\n/g, '<br />');

  const tokenRegex = new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g');
  escaped = escaped.replace(tokenRegex, (_, idx) => placeholders[Number(idx)] ?? '');

  escaped = escaped.replace(/\uFFF0\d+\uFFF1/g, '');

  return escaped;
}

function highlightCodeBlock(codeEl: HTMLElement, lang?: string) {
  const raw = codeEl.textContent || '';
  if (!raw) return;
  try {
    codeEl.classList.add('hljs');
    if (lang && hljs.getLanguage(lang)) {
      codeEl.innerHTML = hljs.highlight(raw, { language: lang }).value;
    } else {
      codeEl.innerHTML = hljs.highlightAuto(raw).value;
    }
  } catch {
    codeEl.textContent = raw;
  }
}

function buildMarkdownFragment(markdownText: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!markdownText) return fragment;

  const lines = markdownText.replace(/\r\n/g, '\n').split('\n');
  let paragraphBuffer: string[] = [];
  let listEl: HTMLUListElement | HTMLOListElement | null = null;
  let listType: 'ul' | 'ol' | null = null;
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraphBuffer.length) return;
    const raw = paragraphBuffer.join('\n');
    if (raw.trim()) {
      const p = document.createElement('p');
      p.innerHTML = applyInlineMarkdown(raw);
      fragment.appendChild(p);
    }
    paragraphBuffer = [];
  };

  const closeList = () => {
    listEl = null;
    listType = null;
  };

  const appendCodeBlock = () => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (codeLang) {
      code.dataset.language = codeLang;
      code.classList.add(`language-${codeLang}`);
    }
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    fragment.appendChild(pre);
    highlightCodeBlock(code, codeLang);
    codeLines = [];
    codeLang = '';
  };

  const startList = (type: 'ul' | 'ol') => {
    if (!listEl || listType !== type) {
      listEl = document.createElement(type === 'ul' ? 'ul' : 'ol');
      fragment.appendChild(listEl);
      listType = type;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (inCodeBlock) {
      if (trimmed.startsWith('```')) {
        inCodeBlock = false;
        appendCodeBlock();
        continue;
      }
      codeLines.push(line);
      continue;
    }

    if (trimmed.startsWith('```')) {
      flushParagraph();
      closeList();
      inCodeBlock = true;
      codeLang = trimmed.slice(3).trim().toLowerCase();
      codeLines = [];
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = Math.min(headingMatch[1].length, 6);
      const h = document.createElement(`h${level}`) as HTMLElement;
      h.innerHTML = applyInlineMarkdown(headingMatch[2]);
      fragment.appendChild(h);
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      flushParagraph();
      closeList();
      fragment.appendChild(document.createElement('hr'));
      continue;
    }

    const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushParagraph();
      closeList();
      const block = document.createElement('blockquote');
      block.innerHTML = applyInlineMarkdown(blockquoteMatch[1]);
      fragment.appendChild(block);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType !== 'ul') {
        listEl = null;
      }
      startList('ul');
      const li = document.createElement('li');
      li.innerHTML = applyInlineMarkdown(unorderedMatch[1]);
      listEl!.appendChild(li);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType !== 'ol') {
        listEl = null;
      }
      startList('ol');
      const li = document.createElement('li');
      li.innerHTML = applyInlineMarkdown(orderedMatch[1]);
      listEl!.appendChild(li);
      continue;
    }

    closeList();
    paragraphBuffer.push(line);
  }

  if (inCodeBlock) {
    appendCodeBlock();
  }
  flushParagraph();

  return fragment;
}

function parseWorkspaceHref(href: string): { file: string; start?: number; end?: number } | null {
  if (!href || !/^workspace:\/\//i.test(href)) return null;
  const withoutProto = href.replace(/^workspace:\/\//i, '');
  const [pathPart, hash] = withoutProto.split('#');
  let start: number | undefined;
  let end: number | undefined;
  if (hash && /^L\d+(-L?\d+)?$/i.test(hash)) {
    const m = hash.match(/^L(\d+)(?:-L?(\d+))?$/i);
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
    }
  }
  return { file: pathPart || '', start, end };
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeWorkspacePath(raw: string): string {
  let cleaned = normalizeFsPath(raw.trim());
  cleaned = cleaned.replace(/^\.\/+/, '');
  cleaned = cleaned.replace(/^\/+/, '');
  if (!cleaned) return '';

  const base = workingDir ? normalizeFsPath(workingDir).replace(/\/+$/, '') : '';
  if (base) {
    const lowerBase = base.toLowerCase();
    const lowerClean = cleaned.toLowerCase();
    if (lowerClean === lowerBase) return '';
    if (lowerClean.startsWith(lowerBase + '/')) {
      cleaned = cleaned.slice(base.length + 1);
    }
  }

  return cleaned;
}

function isMentionBoundaryChar(value: string): boolean {
  if (!value) return true;
  if (/\s/.test(value)) return true;
  return /[\[({"'`]/.test(value);
}

function stripAtMentions(text: string): string {
  if (!text) return text;
  return text.replace(/@([\w./\\-]+)/g, (match, rawPath, offset) => {
    const prev = offset > 0 ? text[offset - 1] : '';
    if (offset > 0 && !isMentionBoundaryChar(prev)) return match;
    const normalized = normalizeWorkspacePath(rawPath);
    return normalized ? normalized : match;
  });
}

function buildUserMessageFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  const pattern = /@([\w./\\-]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const prev = start > 0 ? text[start - 1] : '';
    if (start > 0 && !isMentionBoundaryChar(prev)) {
      continue;
    }

    const normalized = normalizeWorkspacePath(match[1]);
    if (!normalized) {
      continue;
    }

    if (start > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }

    const link = document.createElement('a');
    link.href = `workspace://${normalized}`;
    link.textContent = `@${normalized}`;
    link.setAttribute('data-workspace-link', 'true');
    fragment.appendChild(link);
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function renderUserMessageContent(target: HTMLElement, text: string): void {
  target.textContent = '';
  if (!text) return;
  target.appendChild(buildUserMessageFragment(text));
  try { attachWorkspaceLinkEnhancements(target, workingDir || ''); } catch { }
}

function detectLanguageFromPath(file: string): string | undefined {
  const lower = file.toLowerCase();
  // TypeScript
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  // JavaScript
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  // JSON
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'json';
  // CSS
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.less')) return 'css';
  // HTML/XML
  if (lower.endsWith('.xml') || lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.svg')) return 'xml';
  // Python
  if (lower.endsWith('.py') || lower.endsWith('.pyw') || lower.endsWith('.pyi')) return 'python';
  // Diff
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'diff';
  // Go
  if (lower.endsWith('.go')) return 'go';
  // Rust
  if (lower.endsWith('.rs')) return 'rust';
  // Java
  if (lower.endsWith('.java')) return 'java';
  // C/C++
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.hpp') || lower.endsWith('.hxx') || lower.endsWith('.hh')) return 'cpp';
  // C#
  if (lower.endsWith('.cs')) return 'csharp';
  // Ruby
  if (lower.endsWith('.rb') || lower.endsWith('.rake') || lower.endsWith('.gemspec')) return 'ruby';
  // PHP
  if (lower.endsWith('.php') || lower.endsWith('.phtml')) return 'php';
  // SQL
  if (lower.endsWith('.sql')) return 'sql';
  // YAML
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  // TOML
  if (lower.endsWith('.toml')) return 'toml';
  // Swift
  if (lower.endsWith('.swift')) return 'swift';
  // Kotlin
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) return 'kotlin';
  // Scala
  if (lower.endsWith('.scala') || lower.endsWith('.sc')) return 'scala';
  // Shell
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh') || lower.endsWith('.fish')) return 'bash';
  // Dockerfile
  if (lower.endsWith('dockerfile') || lower.includes('dockerfile.')) return 'dockerfile';
  // Markdown
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  // Plain text / config
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'plaintext';
  if (lower.endsWith('.ini') || lower.endsWith('.cfg') || lower.endsWith('.conf')) return 'toml';
  // Env files
  if (lower.endsWith('.env') || lower.includes('.env.')) return 'bash';
  return undefined;
}

async function loadSnippetForAnchor(anchor: HTMLAnchorElement, workingDir: string): Promise<void> {
  try {
    const href = anchor.getAttribute('href') || '';
    const info = parseWorkspaceHref(href);
    if (!info || !info.file) return;

    const relPath = info.file.replace(/^\/+/, '');
    const absPath = relPath;

    // Check if this anchor already has an associated snippet (via data attribute)
    const existingWrapId = anchor.dataset.snippetWrapId;
    if (existingWrapId) {
      const existingWrap = document.getElementById(existingWrapId);
      if (existingWrap) {
        const det = existingWrap.querySelector('details[data-snippet="true"]') as HTMLDetailsElement;
        if (det) {
          det.open = !det.open;
          return;
        }
      }
    }

    // Also check if anchor is inside a wrap
    const existing = anchor.closest('.file-link-wrap') as HTMLElement | null;
    let wrap: HTMLElement;
    if (existing) {
      wrap = existing;
      if (wrap.querySelector('details[data-snippet="true"]')) {
        const det = wrap.querySelector('details[data-snippet="true"]') as HTMLDetailsElement;
        det.open = !det.open;
        return;
      }
    } else {
      wrap = document.createElement('div');
      wrap.className = 'file-link-wrap';
      const wrapId = `snippet-wrap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      wrap.id = wrapId;
      anchor.dataset.snippetWrapId = wrapId;
      anchor.parentElement?.insertBefore(wrap, anchor.nextSibling);
    }

    const res = await (window as any).files?.read?.({ path: absPath });
    if (!res?.ok || res?.isBinary || typeof res.content !== 'string') {
      return;
    }

    const lines = res.content.replace(/\r\n/g, '\n').split('\n');
    let start = (info.start && info.start > 0) ? info.start : 1;
    let end = (info.end && info.end > 0) ? info.end : start;
    if (start > lines.length) start = lines.length;
    if (end > lines.length) end = lines.length;
    if (end < start) end = start;

    const snippet = lines.slice(start - 1, end).join('\n');

    const details = document.createElement('details');
    details.setAttribute('data-snippet', 'true');
    details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'reasoning-summary';
    summary.textContent = `${formatScopedPathForDisplay(relPath)} — lines ${start}-${end}`;

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const lang = detectLanguageFromPath(relPath);
    if (lang) {
      code.dataset.language = lang;
      code.classList.add(`language-${lang}`);
    }
    code.textContent = snippet;
    pre.appendChild(code);

    const actions = document.createElement('div');
    actions.className = 'snippet-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'confirm-btn';
    openBtn.textContent = 'Open in editor';
    openBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { (window as any).viewer?.openFileSpec?.({ file: absPath, line: start }); } catch { }
    });
    actions.appendChild(openBtn);

    details.appendChild(summary);
    details.appendChild(actions);
    details.appendChild(pre);

    const previewWrap = document.createElement('div');
    previewWrap.className = 'preview';
    previewWrap.appendChild(details);

    wrap.appendChild(previewWrap);
    highlightCodeBlock(code, code.dataset.language);
  } catch { }
}

function attachWorkspaceLinkEnhancements(root: HTMLElement, workingDir: string): void {
  const anchors = root.querySelectorAll('a[data-workspace-link="true"]');
  anchors.forEach((a) => {
    const anchor = a as HTMLAnchorElement;
    if (anchor.dataset.enhanced === 'true') return;
    anchor.dataset.enhanced = 'true';

    // Display-only: if the link target (or label) contains a scoped path, show folder names instead.
    try {
      const href = anchor.getAttribute('href') || '';
      const info = parseWorkspaceHref(href);
      const targetRel = info?.file ? info.file.replace(/^\/+/, '') : '';
      const label = (anchor.textContent || '').trim();
      const looksScoped = /^\s*(workspace:|additional:)/i.test(label) || /^\s*(workspace:|additional:)/i.test(targetRel);
      if (looksScoped) {
        const displaySource = /^\s*(workspace:|additional:)/i.test(label) ? label : targetRel;
        const display = formatScopedPathForDisplay(displaySource);
        if (display) {
          anchor.textContent = display;
          anchor.title = displaySource;
        }
      }
    } catch { }

    anchor.addEventListener('click', (e) => {
      const isMetaOpen = (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey;
      e.preventDefault();
      e.stopPropagation();
      if (isMetaOpen) {
        const href = anchor.getAttribute('href') || '';
        const info = parseWorkspaceHref(href);
        if (info && info.file) {
          const relPath = info.file.replace(/^\/+/, '');
          const line = info.start && info.start > 0 ? info.start : undefined;
          try { (window as any).viewer?.openFileSpec?.({ file: relPath, line }); } catch { }
        }
      } else {
        loadSnippetForAnchor(anchor, workingDir).catch(() => { });
      }
    });
  });
}

function renderMarkdownInto(target: HTMLElement, markdownText: string): void {
  try { (window as any).electronAPI?.log(`[Renderer] renderMarkdownInto: len=${markdownText?.length}`); } catch { }
  console.log('[Renderer] renderMarkdownInto:', {
    hasTarget: !!target,
    markdownTextLength: markdownText?.length,
    markdownTextPreview: markdownText?.substring(0, 100),
  });
  target.innerHTML = '';
  if (!markdownText) {
    try { (window as any).electronAPI?.log(`[Renderer] renderMarkdownInto: empty text`); } catch { }
    console.log('[Renderer] renderMarkdownInto: no markdownText, returning early');
    return;
  }
  const fragment = buildMarkdownFragment(markdownText);
  try { (window as any).electronAPI?.log(`[Renderer] fragment nodes: ${fragment.childNodes.length}`); } catch { }
  console.log('[Renderer] renderMarkdownInto: fragment childNodes:', fragment.childNodes.length);
  target.appendChild(fragment);
  // Enhance workspace:// links with lazy inline code snippets
  try { attachWorkspaceLinkEnhancements(target, workingDir || ''); } catch { }
  console.log('[Renderer] renderMarkdownInto complete, target innerHTML length:', target.innerHTML?.length);
}

function setAssistantMessageContent(target: HTMLElement, text: string): void {
  console.log('[Renderer] setAssistantMessageContent:', {
    hasTarget: !!target,
    targetTag: target?.tagName,
    textLength: text?.length,
    textPreview: text?.substring(0, 100),
  });
  assistantMessageRawContent.set(target, text);
  renderMarkdownInto(target, text);
  console.log('[Renderer] setAssistantMessageContent complete, target innerHTML length:', target?.innerHTML?.length);
}

function appendAssistantMessageContent(target: HTMLElement, addition: string): void {
  console.log('[Renderer] appendAssistantMessageContent:', {
    hasTarget: !!target,
    additionLength: addition?.length,
  });
  const prev = assistantMessageRawContent.get(target) ?? '';
  console.log('[Renderer] appendAssistantMessageContent prev:', {
    prevLength: prev?.length,
    newTotal: (prev?.length ?? 0) + (addition?.length ?? 0),
  });
  setAssistantMessageContent(target, prev + addition);
}

function getAssistantMessageContent(target: HTMLElement): string {
  const stored = assistantMessageRawContent.get(target);
  if (stored != null) return stored;
  return target.textContent || '';
}

import type { OpenAIResponseItem, OpenAIUserContent } from '../types/chat.js';
import type { AnthropicConversationItem } from '../agent/chatStore.js';
import type { Provider } from '../agent/models.js';
import { getModelProvider } from '../agent/models.js';

type ChatContentBlock =
  | { type: 'text'; content: string }
  | { type: 'image'; content: { mime_type: string; data: string; filename?: string | null } };

type ChatUserEvent = {
  type: 'user';
  content: ChatContentBlock[];
  timestamp?: number;
};

type ChatMessageEvent = {
  type: 'message';
  content: string;
  timestamp?: number;
};

type ChatReasoningEvent = {
  type: 'reasoning';
  content?: string | null;
  encrypted_reasoning?: string | null;
  timestamp?: number;
};

type ChatToolCallEvent = {
  type: 'tool_call';
  content: {
    tool_name: string;
    call_id: string;
    args: any;
  };
  timestamp?: number;
};

type ChatToolResultEvent = {
  type: 'tool_result';
  content: {
    call_id: string;
    output: string;
  };
  timestamp?: number;
};

type ChatEvent =
  | ChatUserEvent
  | ChatMessageEvent
  | ChatReasoningEvent
  | ChatToolCallEvent
  | ChatToolResultEvent;

type ImageAttachment = { id?: string; name?: string; path?: string; mime: string; base64: string; dataUrl: string };

type UiState = {
  mode: 'chat' | 'agent' | 'agent_full';
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';
  model: string;
  theme: 'dark' | 'light';
};

type TodoStatus = 'todo' | 'in_progress' | 'done';
type TodoSnapshot = Record<number, { status?: string; content?: string }>;
type TodoItem = { index: number; status: TodoStatus; content: string };

type StoredChatRuntime = {
  status: 'idle' | 'running' | 'completed' | 'error';
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
};

type StoredChat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: Provider;
  history: OpenAIResponseItem[] | AnthropicConversationItem[];
  runtime?: StoredChatRuntime;
  additionalWorkingDir?: string;
  workspaceChanges?: WorkspaceChangesSnapshot;
};

const uiState: UiState = { mode: 'agent', reasoning: 'medium', model: 'gpt-5.2', theme: 'dark' };

let lastSentAgentMode: UiState['mode'] | null = null;
const ALL_REASONING_OPTIONS: UiState['reasoning'][] = ['low', 'medium', 'high', 'xhigh'];

type ModelMeta = { key: string; name: string; provider?: string; type?: string; source?: 'builtin' | 'custom' };
let modelsMeta: ModelMeta[] = [];

type ToastKind = 'info' | 'success' | 'error';

type BillingState = {
  ok: boolean;
  checkedAt?: number;
  authenticated: boolean;
  hasActiveSubscription: boolean;
  plan?: string;
  subscriptionStatus?: string;
  creditsTotal?: number;
  creditsUsed?: number;
  subscribeUrl?: string;
  error?: string;
};

type PricingPlan = {
  id?: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  description?: string;
  features: string[];
  cta_label?: string;
  cta_href?: string | null;
  badge?: string | null;
  highlight?: boolean;
  monthly_credits?: number | null;
  plan_type?: string;
};
let latestBillingState: BillingState | null = null;
let openPaywall: (() => void) | null = null;
let promptPaywall: (() => void) | null = null;
let openPaywallCredits: (() => void) | null = null;
let checkoutPolling: { timer: number; startedAt: number; notified?: boolean } | null = null;

function showToast(message: string, kind: ToastKind = 'info'): void {
  const text = String(message || '').trim();
  if (!text) return;
  const host = document.getElementById('system-toast');
  if (!host) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = text;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.appendChild(toast);
  requestAnimationFrame(() => { toast.classList.add('visible'); });
  const remove = () => {
    toast.classList.remove('visible');
    window.setTimeout(() => { toast.remove(); }, 220);
  };
  const timer = window.setTimeout(remove, 4200);
  toast.addEventListener('click', () => { window.clearTimeout(timer); remove(); }, { once: true });
}

function classifyNotice(text: string): ToastKind {
  const value = String(text || '').toLowerCase();
  if (!value) return 'info';
  if (value.includes('connected') || value.includes('ready')) return 'success';
  if (value.includes('error') || value.includes('stderr') || value.includes('exit') || value.includes('failed')) return 'error';
  return 'info';
}

function coerceBillingState(raw: unknown): BillingState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as any;
  if (typeof obj.ok !== 'boolean') return null;
  if (typeof obj.authenticated !== 'boolean') return null;
  if (typeof obj.hasActiveSubscription !== 'boolean') return null;
  return {
    ok: obj.ok,
    checkedAt: Number.isFinite(Number(obj.checkedAt)) ? Number(obj.checkedAt) : undefined,
    authenticated: obj.authenticated,
    hasActiveSubscription: obj.hasActiveSubscription,
    plan: typeof obj.plan === 'string' ? obj.plan : undefined,
    subscriptionStatus: typeof obj.subscriptionStatus === 'string' ? obj.subscriptionStatus : undefined,
    creditsTotal: Number.isFinite(Number(obj.creditsTotal)) ? Number(obj.creditsTotal) : undefined,
    creditsUsed: Number.isFinite(Number(obj.creditsUsed)) ? Number(obj.creditsUsed) : undefined,
    subscribeUrl: typeof obj.subscribeUrl === 'string' ? obj.subscribeUrl : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

function getCreditsRemaining(state: BillingState | null): number | null {
  if (!state) return null;
  if (!Number.isFinite(Number(state.creditsTotal)) || !Number.isFinite(Number(state.creditsUsed))) {
    return null;
  }
  return Math.max(0, Number(state.creditsTotal) - Number(state.creditsUsed));
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);
const INACTIVE_SUBSCRIPTION_STATUSES = new Set(['canceled', 'cancelled', 'incomplete_expired', 'inactive']);

function hasActivePlan(state: BillingState | null): boolean {
  if (!state) return false;
  const status = String(state.subscriptionStatus || '').trim().toLowerCase();
  if (ACTIVE_SUBSCRIPTION_STATUSES.has(status)) return true;
  if (INACTIVE_SUBSCRIPTION_STATUSES.has(status) || !status) return false;
  const planName = String(state.plan || '').trim().toLowerCase();
  if (!planName || planName === 'free') return false;
  return state.hasActiveSubscription === true;
}

function hasCredits(state: BillingState | null): boolean {
  const creditsRemaining = getCreditsRemaining(state);
  if (creditsRemaining === null) return true;
  return creditsRemaining > 0;
}

async function fetchBillingState(): Promise<BillingState | null> {
  try {
    const res = await window.billing?.status?.();
    const state = coerceBillingState(res?.state);
    if (state) latestBillingState = state;
    return state;
  } catch {
    return latestBillingState;
  }
}

function startCheckoutPolling(opts?: { maxMs?: number; intervalMs?: number }): void {
  const maxMs = Number.isFinite(opts?.maxMs) ? Math.max(10_000, Math.floor(opts!.maxMs as number)) : 90_000;
  const intervalMs = Number.isFinite(opts?.intervalMs) ? Math.max(1_000, Math.floor(opts!.intervalMs as number)) : 2_500;

  if (checkoutPolling) return;
  if (!window.billing?.refresh) return;

  const startedAt = Date.now();
  const tick = async () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed > maxMs) {
      if (checkoutPolling) {
        window.clearInterval(checkoutPolling.timer);
        checkoutPolling = null;
      }
      return;
    }

    try {
      const res = await window.billing.refresh();
      const state = coerceBillingState(res?.state);
      if (state && state.ok && state.authenticated && hasCredits(state)) {
        if (!checkoutPolling?.notified) {
          showToast('Billing updated. You can use the agent now.', 'success');
          if (checkoutPolling) checkoutPolling.notified = true;
        }
        if (checkoutPolling) {
          window.clearInterval(checkoutPolling.timer);
          checkoutPolling = null;
        }
      }
    } catch { }
  };

  void tick();
  const timer = window.setInterval(() => { void tick(); }, intervalMs);
  checkoutPolling = { timer, startedAt };

  window.addEventListener('beforeunload', () => {
    if (!checkoutPolling) return;
    window.clearInterval(checkoutPolling.timer);
    checkoutPolling = null;
  }, { once: true });
}

function formatPrice(amount: number, currency: string): string {
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const curr = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: curr,
      minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${curr}`;
  }
}

function setupPaywall(): void {
  const backdrop = document.getElementById('paywall-backdrop') as HTMLDivElement | null;
  const closeBtn = document.getElementById('paywall-close') as HTMLButtonElement | null;
  const dismissBtn = document.getElementById('paywall-dismiss') as HTMLButtonElement | null;
  const loadingEl = document.getElementById('paywall-loading') as HTMLDivElement | null;
  const errorEl = document.getElementById('paywall-error') as HTMLDivElement | null;
  const plansEl = document.getElementById('paywall-plans') as HTMLDivElement | null;
  const titleEl = document.getElementById('paywall-title') as HTMLHeadingElement | null;
  const subtitleEl = document.getElementById('paywall-subtitle') as HTMLParagraphElement | null;
  if (!backdrop || !closeBtn || !dismissBtn || !loadingEl || !errorEl || !plansEl || !window.billing) return;

  const DISMISS_KEY_BASE = 'bc.paywall.dismissed';
  const AUTH_STATE_KEY = 'bc.auth.state';
  let activeDismissKey = DISMISS_KEY_BASE;
  let autoShown = false;
  let lastAuth = false;
  let lastUserKey = '';
  let paywallMode: 'plan' | 'credits' = 'plan';

  const isDismissed = (): boolean => {
    try { return window.localStorage.getItem(activeDismissKey) === '1'; } catch { return false; }
  };
  const setDismissed = (value: boolean): void => {
    try { window.localStorage.setItem(activeDismissKey, value ? '1' : '0'); } catch {}
  };

  const deriveUserKey = (profile: any): string => {
    const sub = typeof profile?.sub === 'string' ? profile.sub.trim() : '';
    if (sub) return sub;
    const email = typeof profile?.email === 'string' ? profile.email.trim().toLowerCase() : '';
    if (email) return `email:${email}`;
    return 'anonymous';
  };

  const readStoredAuthState = (): { authenticated: boolean; userKey: string } | null => {
    try {
      const raw = window.localStorage.getItem(AUTH_STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { authenticated?: boolean; userKey?: string };
      const authenticated = !!parsed?.authenticated;
      const userKey = typeof parsed?.userKey === 'string' ? parsed.userKey : '';
      return { authenticated, userKey };
    } catch {
      return null;
    }
  };

  const writeStoredAuthState = (authenticated: boolean, userKey: string): void => {
    try {
      window.localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ authenticated, userKey }));
    } catch {}
  };

  const setActiveUser = (opts: { authenticated: boolean; profile?: any; resetDismissal?: boolean }): void => {
    if (!opts.authenticated) {
      activeDismissKey = DISMISS_KEY_BASE;
      lastUserKey = '';
      autoShown = false;
      return;
    }
    const userKey = deriveUserKey(opts.profile);
    lastUserKey = userKey;
    activeDismissKey = `${DISMISS_KEY_BASE}:${userKey}`;
    autoShown = false;
    if (opts.resetDismissal) {
      setDismissed(false);
    }
  };

  const setLoading = (loading: boolean): void => {
    loadingEl.hidden = !loading;
  };

  const setError = (message: string | null): void => {
    const text = (message || '').trim();
    if (!text) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = text;
  };

  const setPaywallCopy = (mode: 'plan' | 'credits'): void => {
    paywallMode = mode;
    if (titleEl) {
      titleEl.textContent = 'Choose a plan';
    }
    if (subtitleEl) {
      subtitleEl.textContent =
        mode === 'credits'
          ? 'You are out of credits. Pick a plan to continue.'
          : 'Select a plan to continue.';
    }
    dismissBtn.textContent = 'Continue without changes';
  };

  const clearPlans = (): void => {
    plansEl.textContent = '';
  };

  const normalizePlanKey = (plan: PricingPlan): string => {
    const raw = String(plan?.name || '').trim().toLowerCase();
    if (raw === 'starter' || raw === 'basic' || raw === 'premium' || raw === 'ultra') return raw;
    if (plan?.plan_type === 'payg') return 'payg';
    return raw.replace(/\s+/g, '_');
  };

  const normalizeStatePlanKey = (state: BillingState | null): string => {
    const raw = String(state?.plan || '').trim().toLowerCase();
    if (!raw || raw === 'free') return '';
    if (raw === 'starter' || raw === 'basic' || raw === 'premium' || raw === 'ultra') return raw;
    return raw.replace(/\s+/g, '_');
  };

  const renderPlans = (plans: PricingPlan[]): void => {
    clearPlans();
    const showPlans = paywallMode !== 'credits';
    if (showPlans) {
      const visiblePlans = plans.filter((plan) => plan.plan_type !== 'payg');
      const currentPlanKey = normalizeStatePlanKey(latestBillingState);
      const currentPlanIsActive = hasActivePlan(latestBillingState);
      for (const plan of visiblePlans) {
        const planKey = normalizePlanKey(plan);
        const isCurrent = !!currentPlanKey && currentPlanKey === planKey;
        const isCurrentActive = isCurrent && currentPlanIsActive;
        const card = document.createElement('article');
        card.className = `paywall-plan${plan.highlight ? ' highlight' : ''}${isCurrent ? ' current' : ''}`;

        const top = document.createElement('div');
        top.className = 'paywall-plan-top';

        const titleWrap = document.createElement('div');
        const name = document.createElement('p');
        name.className = 'paywall-plan-name';
        name.textContent = plan.name;

        const price = document.createElement('div');
        price.className = 'paywall-plan-price';
        const amount = document.createElement('span');
        amount.className = 'amount';
        amount.textContent = formatPrice(plan.price, plan.currency);
        const interval = document.createElement('span');
        interval.className = 'interval';
        const intervalValue = (plan.interval ?? '').toLowerCase();
        if (intervalValue === 'year') {
          interval.textContent = 'per year';
        } else {
          interval.textContent = 'per month';
        }
        price.append(amount, interval);

        titleWrap.append(name, price);

        top.appendChild(titleWrap);

        const badgesWrap = document.createElement('div');
        badgesWrap.className = 'paywall-plan-badges';
        let badgeText = typeof plan.badge === 'string' ? plan.badge.trim() : '';
        if (planKey === 'starter') badgeText = 'Starter';
        if (planKey === 'basic') badgeText = 'Best value';
        if (badgeText) {
          const badge = document.createElement('span');
          badge.className = 'paywall-plan-badge';
          badge.textContent = badgeText;
          badgesWrap.appendChild(badge);
        }
        if (isCurrent) {
          const badge = document.createElement('span');
          badge.className = 'paywall-plan-badge current';
          badge.textContent = 'Current';
          badgesWrap.appendChild(badge);
        }
        if (badgesWrap.childElementCount) top.appendChild(badgesWrap);

        const desc = document.createElement('p');
        desc.className = 'paywall-plan-desc';
        desc.textContent = plan.description || '';

        const features = document.createElement('ul');
        features.className = 'paywall-plan-features';
        const list = Array.isArray(plan.features) ? plan.features : [];
        for (const item of list) {
          const li = document.createElement('li');
          li.textContent = String(item || '').trim();
          if (li.textContent) features.appendChild(li);
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'paywall-plan-cta';
        btn.textContent = isCurrentActive ? 'Current plan' : (plan.cta_label || `Choose ${plan.name}`);
        btn.disabled = isCurrentActive;

        btn.addEventListener('click', async () => {
          const planLabel = plan.name || planKey;
          if (!planKey || !['starter', 'basic', 'premium', 'ultra'].includes(planKey)) {
            showToast(`Unsupported plan: ${planLabel}`, 'error');
            return;
          }
          btn.disabled = true;
          const originalText = btn.textContent || '';
          btn.textContent = 'Opening Stripe checkout...';
          try {
            const res = await window.billing?.checkout?.(planKey);
            if (!res?.ok) {
              throw new Error(res?.error || 'Failed to start checkout.');
            }
            showToast('Checkout opened in your browser. Return to the app when done.', 'info');
            startCheckoutPolling();
          } catch (error: any) {
            showToast(error?.message || 'Failed to start checkout.', 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = originalText;
          }
        });

        card.append(top);
        if (desc.textContent) card.append(desc);
        if (features.childElementCount) card.append(features);
        card.append(btn);

        plansEl.appendChild(card);
      }
    }
  };

  const loadPricing = async (): Promise<void> => {
    setError(null);
    setLoading(true);
    try {
      const res = await window.billing?.pricing?.();
      if (!res?.ok) throw new Error(res?.error || 'Failed to load pricing.');
      const plans = Array.isArray((res as any).plans) ? (res as any).plans as PricingPlan[] : [];
      if (!plans.length) throw new Error('No pricing plans available.');
      renderPlans(plans);
    } catch (error: any) {
      clearPlans();
      setError(error?.message || 'Failed to load pricing.');
    } finally {
      setLoading(false);
    }
  };

  const show = async (opts?: { force?: boolean; auto?: boolean; mode?: 'plan' | 'credits' }): Promise<void> => {
    if (!opts?.force && isDismissed()) return;
    if (opts?.auto && autoShown) return;
    if (opts?.auto) autoShown = true;
    await fetchBillingState();
    const mode = opts?.mode ?? resolveMode();
    setPaywallCopy(mode);
    backdrop.hidden = false;
    await loadPricing();
  };

  const hide = (opts?: { dismiss?: boolean }): void => {
    backdrop.hidden = true;
    if (opts?.dismiss) setDismissed(true);
  };

  const resolveMode = (): 'plan' | 'credits' => {
    const state = latestBillingState;
    if (!state || !state.ok || !state.authenticated) return 'plan';
    if (!hasCredits(state)) return hasActivePlan(state) ? 'credits' : 'plan';
    return 'plan';
  };

  openPaywall = () => { void show({ force: true }); };
  promptPaywall = () => { void show({ auto: true }); };
  openPaywallCredits = () => { void show({ force: true, mode: 'credits' }); };

  closeBtn.addEventListener('click', () => hide({ dismiss: true }));
  dismissBtn.addEventListener('click', () => hide({ dismiss: true }));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) hide({ dismiss: true });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.hidden) {
      hide({ dismiss: true });
    }
  });

  window.billing.onStateChange?.((state: any) => {
    const coerced = coerceBillingState(state);
    if (!coerced) return;
    const planActive = hasActivePlan(coerced);
    const creditsOk = hasCredits(coerced);
    if (!coerced.authenticated || (coerced.ok && creditsOk)) {
      hide({ dismiss: false });
      return;
    }
    if (coerced.ok && !creditsOk) {
      const mode = planActive ? 'credits' : 'plan';
      void show({ auto: true, mode });
    }
  });

  void (async () => {
    try {
      const initial = await window.auth?.status?.();
      const authenticated = !!initial?.authenticated;
      const userKey = authenticated ? deriveUserKey(initial?.profile) : '';
      const stored = readStoredAuthState();
      const isFreshLogin = authenticated && (!stored || !stored.authenticated || stored.userKey !== userKey);
      lastAuth = authenticated;
      setActiveUser({ authenticated, profile: initial?.profile, resetDismissal: isFreshLogin });
      writeStoredAuthState(authenticated, userKey);
    } catch {
      lastAuth = false;
    }

    window.auth?.onStateChange?.((state) => {
      const authenticated = !!state?.authenticated;
      const userKey = authenticated ? deriveUserKey(state?.profile) : '';

      const didLogin = !lastAuth && authenticated;
      const changedUser = authenticated && userKey && userKey !== lastUserKey;

      lastAuth = authenticated;
      setActiveUser({ authenticated, profile: state?.profile, resetDismissal: didLogin || changedUser });
      writeStoredAuthState(authenticated, userKey);

      if (!authenticated) {
        hide({ dismiss: false });
        return;
      }

      // After a fresh login (or account switch), refresh billing state so the paywall can auto-show.
      if (didLogin || changedUser) {
        void window.billing?.refresh?.();
      }
    });
  })();

  void fetchBillingState().then((state) => {
    if (!state || !state.authenticated || !state.ok) return;
    const planActive = hasActivePlan(state);
    const creditsOk = hasCredits(state);
    if (!creditsOk) {
      const mode = planActive ? 'credits' : 'plan';
      void show({ auto: true, mode });
    }
  });
}

let noticeListenerAttached = false;

// UI state persists in localStorage so the app remembers the last model &
// agent mode the user picked.

function allowedReasoningOptions(modelKey: string): UiState['reasoning'][] {
  if (modelKey === 'gpt-5-pro') return ['high'];
  if (modelKey === 'gpt-5.2' || modelKey === 'gpt-5.1' || modelKey === 'gpt-5.1-codex-max') return ['low', 'medium', 'high', 'xhigh'];
  // Default: standard models support low/medium/high
  return ['low', 'medium', 'high'];
}

function enforceReasoningForModel(): void {
  const allowed = allowedReasoningOptions(uiState.model);
  if (!allowed.includes(uiState.reasoning)) {
    uiState.reasoning = allowed[allowed.length - 1] ?? 'high';
  }
}

function applyReasoningConstraints(): void {
  const allowed = allowedReasoningOptions(uiState.model);
  const menu = document.getElementById('dd-reason');

  // Ensure xhigh exists in the DOM even if markup was stale/trimmed
  if (menu && !menu.querySelector('[data-value="xhigh"]')) {
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('data-value', 'xhigh');
    btn.textContent = 'Extra High';
    menu.appendChild(btn);
  }

  menu?.querySelectorAll<HTMLButtonElement>('.item').forEach(btn => {
    const value = btn.getAttribute('data-value') as UiState['reasoning'] | null;
    if (!value) return;
    const isAllowed = allowed.includes(value);
    // Always show 'xhigh' but grey it out if not allowed
    if (value === 'xhigh') {
      btn.hidden = false;
      btn.disabled = !isAllowed;
      btn.classList.toggle('disabled-option', !isAllowed);
      btn.removeAttribute('aria-hidden');
      if (!isAllowed) {
        btn.title = 'Only available for gpt-5.1, gpt-5.1-codex-max, and gpt-5.2';
      } else {
        btn.title = '';
      }
    } else {
      btn.hidden = !isAllowed;
      btn.disabled = !isAllowed;
      btn.classList.remove('disabled-option');
      if (isAllowed) {
        btn.removeAttribute('aria-hidden');
      } else {
        btn.setAttribute('aria-hidden', 'true');
      }
    }
  });
}

function lockedProviderForActiveSession(): Provider | null {
  const session = getActiveSession();
  if (!session) return null;
  const hasHistory = Array.isArray(session.history) && session.history.length > 0;
  return hasHistory ? session.provider : null;
}

function enforceModelProviderLock(): void {
  const locked = lockedProviderForActiveSession();
  if (!locked) return;
  const currentProvider = modelsMeta.find(m => m.key === uiState.model)?.provider;
  if (currentProvider && currentProvider === locked) return;
  const fallback = modelsMeta.find(m => m.provider === locked)?.key;
  if (fallback && fallback !== uiState.model) {
    uiState.model = fallback;
    enforceReasoningForModel();
    saveUiState();
    syncUiLabels();
  }
}

function alignActiveSessionProviderToModel(): void {
  const session = getActiveSession();
  if (!session) return;
  const hasHistory = Array.isArray(session.history) && session.history.length > 0;
  if (hasHistory) return;
  const provider = getModelProvider(uiState.model);
  if (session.provider === provider) return;
  session.provider = provider;
  const idx = chatSessions.findIndex(s => s.id === session.id);
  if (idx >= 0) chatSessions[idx] = { ...session };
}

function applyModelLockConstraints(): void {
  const locked = lockedProviderForActiveSession();
  const menu = document.getElementById('dd-model');
  menu?.querySelectorAll<HTMLButtonElement>('.item').forEach(btn => {
    const key = btn.getAttribute('data-value') || '';
    const meta = modelsMeta.find(m => m.key === key);
    const provider = meta?.provider || getModelProvider(key);
    const lockedOut = locked && provider && provider !== locked;
    btn.disabled = lockedOut;
    if (lockedOut) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = 'Switch provider by starting a new chat';
    } else {
      btn.removeAttribute('aria-disabled');
      btn.title = '';
    }
  });
}

function loadUiState(): void {
  try {
    const raw = localStorage.getItem('bc.ui') || '';
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v?.mode) uiState.mode = v.mode;
    if (v?.reasoning) uiState.reasoning = v.reasoning;
    if (v?.model) uiState.model = v.model;
    if (v?.theme) uiState.theme = v.theme;
  } catch { }
  enforceReasoningForModel();
}
function saveUiState(): void { try { localStorage.setItem('bc.ui', JSON.stringify(uiState)); } catch { } }
function syncUiLabels(): void {
  const modeText = document.querySelector('#btn-mode .label-text') as HTMLElement | null;
  if (modeText) modeText.textContent = uiState.mode === 'agent' ? 'Agent' : uiState.mode === 'agent_full' ? 'Full Access' : 'Chat';
  const rs = document.getElementById('reasoning-current');
  if (rs) {
    const label = (() => {
      switch (uiState.reasoning) {
        case 'low': return 'Low';
        case 'medium': return 'Medium';
        case 'high': return 'High';
        case 'xhigh': return 'Extra High';
        default: return uiState.reasoning.charAt(0).toUpperCase() + uiState.reasoning.slice(1);
      }
    })();
    rs.textContent = label;
  }
  const model = document.getElementById('model-current');
  if (model) {
    const meta = modelsMeta.find(m => m.key === uiState.model);
    model.textContent = meta?.name || uiState.model;
  }
  applyReasoningConstraints();

  if (lastSentAgentMode !== uiState.mode) {
    try { window.agent?.setMode?.(uiState.mode); } catch { }
    lastSentAgentMode = uiState.mode;
  }
}

class TodoPanel {
  private readonly storageKey = 'bc.todos.collapsed';
  private root: HTMLElement | null;
  private summaryEl: HTMLElement | null;
  private pillEl: HTMLElement | null;
  private listEl: HTMLOListElement | null;
  private collapseBtn: HTMLButtonElement | null;
  private items: TodoItem[] = [];
  private collapsed = false;
  private bumpTimer: number | undefined;

  constructor() {
    this.root = document.getElementById('todo-panel');
    this.summaryEl = document.getElementById('todo-summary-text');
    this.pillEl = document.getElementById('todo-progress-pill');
    this.listEl = document.getElementById('todo-list') as HTMLOListElement | null;
    this.collapseBtn = document.getElementById('todo-collapse-btn') as HTMLButtonElement | null;

    this.collapsed = this.loadCollapsed();
    this.applyCollapsed();
    this.render();

    if (this.collapseBtn) {
      this.collapseBtn.addEventListener('click', () => this.toggle());
    }
  }

  private loadCollapsed(): boolean {
    try {
      return localStorage.getItem(this.storageKey) === 'true';
    } catch {
      return false;
    }
  }

  private persistCollapsed(): void {
    try {
      localStorage.setItem(this.storageKey, this.collapsed ? 'true' : 'false');
    } catch { }
  }

  private applyCollapsed(): void {
    if (!this.root) return;
    this.root.dataset.collapsed = this.collapsed ? 'true' : 'false';
    if (this.collapseBtn) {
      const expanded = this.collapsed ? 'false' : 'true';
      this.collapseBtn.setAttribute('aria-expanded', expanded);
      this.collapseBtn.setAttribute('aria-label', this.collapsed ? 'Expand todo panel' : 'Collapse todo panel');
      this.collapseBtn.setAttribute('data-tooltip', this.collapsed ? 'Expand todos' : 'Collapse todos');
    }
  }

  private isVisible(): boolean {
    return !!(this.root && this.root.style.display !== 'none');
  }

  private setVisibility(shouldShow: boolean): void {
    if (!this.root) return;
    const currentlyVisible = this.isVisible();
    if (shouldShow === currentlyVisible) return;
    this.root.style.display = shouldShow ? 'flex' : 'none';
    this.root.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  private normalizeStatus(status?: string): TodoStatus {
    const key = (status || '').trim().toLowerCase();
    if (key === 'done' || key === 'completed' || key === 'complete' || key === 'finished' || key === 'shipped' || key === 'resolved') {
      return 'done';
    }
    if (key === 'in_progress' || key === 'in progress' || key === 'progress' || key === 'doing' || key === 'working' || key === 'started' || key === 'wip' || key === 'active') {
      return 'in_progress';
    }
    return 'todo';
  }

  private render(): void {
    const total = this.items.length;
    const completed = this.items.filter(i => i.status === 'done').length;
    const hasOutstanding = this.items.some(i => i.status !== 'done');

    this.setVisibility(hasOutstanding);

    if (this.summaryEl) {
      if (!hasOutstanding) {
        this.summaryEl.textContent = total === 0 ? 'No tasks yet' : 'All tasks complete';
      } else {
        this.summaryEl.textContent = `${completed} out of ${total} task${total === 1 ? '' : 's'} completed`;
      }
    }
    if (this.pillEl) {
      this.pillEl.textContent = total === 0 ? '0/0' : `${completed}/${total}`;
      this.pillEl.style.opacity = hasOutstanding ? '1' : '0.6';
    }

    if (this.listEl) {
      this.listEl.innerHTML = '';
      if (!hasOutstanding) return;
      for (const item of this.items) {
        const li = document.createElement('li');
        li.className = `todo-item status-${item.status}`;
        li.setAttribute('data-index', String(item.index));

        const indicator = document.createElement('span');
        indicator.className = 'todo-status-indicator';

        const indexEl = document.createElement('span');
        indexEl.className = 'todo-index';
        indexEl.textContent = `${item.index}.`;

        const contentEl = document.createElement('span');
        contentEl.className = 'todo-content';
        contentEl.textContent = item.content;

        li.append(indicator, indexEl, contentEl);
        this.listEl.appendChild(li);
      }
    }
  }

  private updateItems(snapshot?: TodoSnapshot): void {
    if (!snapshot || typeof snapshot !== 'object') {
      this.items = [];
      this.render();
      return;
    }
    const items: TodoItem[] = [];
    for (const [key, value] of Object.entries(snapshot)) {
      const idx = Number(key);
      if (!Number.isFinite(idx)) continue;
      const content = typeof value?.content === 'string' ? value.content : '';
      const status = this.normalizeStatus(value?.status);
      items.push({ index: idx, status, content });
    }
    items.sort((a, b) => a.index - b.index);
    this.items = items;
    this.render();
  }

  private bump(): void {
    if (!this.root) return;
    this.root.classList.add('todo-bump');
    if (this.bumpTimer) window.clearTimeout(this.bumpTimer);
    this.bumpTimer = window.setTimeout(() => {
      if (this.root) this.root.classList.remove('todo-bump');
      this.bumpTimer = undefined;
    }, 700);
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.applyCollapsed();
    this.persistCollapsed();
  }

  setCollapsed(value: boolean): void {
    this.collapsed = !!value;
    this.applyCollapsed();
    this.persistCollapsed();
  }

  setSnapshot(snapshot?: TodoSnapshot): void {
    this.updateItems(snapshot);
  }

  clear(): void {
    this.items = [];
    if (this.bumpTimer) {
      window.clearTimeout(this.bumpTimer);
      this.bumpTimer = undefined;
    }
    if (this.root) this.root.classList.remove('todo-bump');
    this.render();
  }

  updateFromTool(name: string | undefined, data: any, _errorMessage?: string): void {
    const wasVisible = this.isVisible();
    const snapshot = data && typeof data === 'object' ? (data.todos as TodoSnapshot) : undefined;
    if (snapshot || name === 'clear_todos_tool') {
      this.setSnapshot(snapshot);
    }
    const nowVisible = this.isVisible();
    if (!wasVisible && nowVisible && this.collapsed) {
      this.setCollapsed(false);
    }
    if (nowVisible && (!wasVisible || name === 'add_todo_tool')) {
      this.bump();
    }
  }
}

function setupDropdown(triggerId: string, menuId: string) {
  const trigger = document.getElementById(triggerId) as HTMLButtonElement | null;
  const menu = document.getElementById(menuId) as HTMLElement | null;
  if (!trigger || !menu) return;

  const close = () => {
    menu.classList.remove('open', 'drop-down', 'align-right');
    trigger.setAttribute('aria-expanded', 'false');
    menu.style.maxHeight = '';
  };

  const place = () => {
    if (!menu.classList.contains('open')) return;

    menu.classList.remove('drop-down', 'align-right');

    const btnRect = trigger.getBoundingClientRect();
    const clip = (trigger.closest('.terminal') as HTMLElement | null) ?? document.body;
    const clipRect = clip.getBoundingClientRect();
    const gap = 6;

    const desired = Math.min(menu.scrollHeight, Math.min(window.innerHeight * 0.4, 320));
    const spaceBelow = Math.max(0, clipRect.bottom - (btnRect.bottom + gap));
    const spaceAbove = Math.max(0, (btnRect.top - gap) - clipRect.top);
    const openDown = spaceBelow >= desired || spaceBelow >= spaceAbove;
    menu.classList.toggle('drop-down', openDown);

    const maxH = Math.max(120, Math.min(desired, openDown ? spaceBelow - gap : spaceAbove - gap));
    menu.style.maxHeight = `${maxH}px`;

    const menuWidth = menu.offsetWidth || 240;
    const spaceRight = Math.max(0, clipRect.right - btnRect.left);
    const spaceLeft = Math.max(0, btnRect.right - clipRect.left);
    const needAlignRight = menuWidth > spaceRight && spaceLeft >= spaceRight;
    menu.classList.toggle('align-right', needAlignRight);
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');

    document.querySelectorAll<HTMLElement>('.dropdown.open')
      .forEach(m => m.classList.remove('open', 'drop-down', 'align-right'));
    document.querySelectorAll<HTMLButtonElement>('.seg-btn[aria-expanded="true"]')
      .forEach(b => b.setAttribute('aria-expanded', 'false'));

    if (willOpen) {
      if (menuId === 'dd-model') {
        applyModelLockConstraints();
      }
      menu.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(place);
    } else {
      close();
    }
  });

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown').forEach(el => el.classList.remove('open', 'drop-down'));
  document.querySelectorAll('.seg-btn[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
}

function setupNoticeToasts(): void {
  try {
    const detach = window.ai?.onNotice?.((payload: any) => {
      try {
        const text = String(payload?.text || payload?.message || '').trim();
        if (!text) return;
        if (/^MCP\(.+\) connected with /i.test(text)) return;
        showToast(text, classifyNotice(text));
      } catch { }
    });
    if (detach) {
      noticeListenerAttached = true;
      window.addEventListener('beforeunload', () => { try { detach(); } catch { }; }, { once: true });
    }
  } catch { }
}

function openCustomModelDialog(onChanged?: () => void): void {
  if (document.getElementById('custom-model-overlay')) return;

  // Hide the WebContentsView (right pane child view) so the modal appears above it
  try { window.layout?.setRightBounds?.({ x: 0, y: 0, width: 0, height: 0 }); } catch { }

  const restoreRightPane = () => {
    // Trigger a resize event to restore the right pane bounds via setupBoundsSync
    try { window.dispatchEvent(new Event('resize')); } catch { }
  };

  const overlay = document.createElement('div');
  overlay.id = 'custom-model-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:16px;';

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(520px,92vw)',
    'max-height:min(90vh,720px)',
    'overflow:auto',
    'background:#0f0f10',
    'border:1px solid #2a2a2a',
    'border-radius:14px',
    'padding:16px',
    'color:#eaeaea',
    'box-shadow:0 18px 48px rgba(0,0,0,0.55)',
    'box-sizing:border-box',
  ].join(';');

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:8px;';
  title.textContent = 'Add new model';
  card.appendChild(title);

  const desc = document.createElement('p');
  desc.style.cssText = 'margin:0 0 12px;color:#b8b8b8;font-size:12px;line-height:1.45;';
  desc.textContent = 'Point at any OpenAI-compatible Responses API model. Name is optional; default uses the model key.';
  card.appendChild(desc);

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const makeField = (labelText: string, input: HTMLElement) => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:#cfcfcf;';
    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = 'opacity:0.9;';
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return wrap;
  };

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'gpt-4.1-mini';
  keyInput.required = true;
  keyInput.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid #2d2d2d;background:#151515;color:#fff;box-sizing:border-box;width:100%;';
  form.appendChild(makeField('Model ID (as sent to the API)', keyInput));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Display name (optional)';
  nameInput.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid #2d2d2d;background:#151515;color:#fff;box-sizing:border-box;width:100%;';
  form.appendChild(makeField('Display name', nameInput));

  const providerSelect = document.createElement('select');
  providerSelect.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid #2d2d2d;background:#151515;color:#fff;box-sizing:border-box;width:100%;';
  ['openai', 'anthropic'].forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible';
    providerSelect.appendChild(opt);
  });
  form.appendChild(makeField('Provider', providerSelect));

  const typeSelect = document.createElement('select');
  typeSelect.style.cssText = 'padding:8px 10px;border-radius:8px;border:1px solid #2d2d2d;background:#151515;color:#fff;box-sizing:border-box;width:100%;';
  [
    { value: 'reasoning', label: 'Reasoning (default)' },
    { value: 'chat', label: 'Chat' },
    { value: 'extended_thinking', label: 'Extended thinking' },
  ].forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    typeSelect.appendChild(opt);
  });
  form.appendChild(makeField('Type', typeSelect));

  const errorEl = document.createElement('div');
  errorEl.style.cssText = 'min-height:16px;color:#f6b0b0;font-size:12px;';
  form.appendChild(errorEl);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin-top:4px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eaeaea;cursor:pointer;min-width:96px;';
  cancelBtn.addEventListener('click', () => { overlay.remove(); restoreRightPane(); });
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid #3a6ee8;background:#2554c7;color:#fff;cursor:pointer;min-width:110px;';
  actions.appendChild(saveBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    const name = nameInput.value.trim();
    const provider = providerSelect.value === 'anthropic' ? 'anthropic' : 'openai';
    const type = typeSelect.value || 'reasoning';
    if (!key) {
      errorEl.textContent = 'Model key is required.';
      return;
    }
    errorEl.textContent = 'Saving…';
    saveBtn.disabled = true;
    try {
      const res = await window.ai?.models?.add?.({ key, name, provider, type });
      if (!res || !res.ok) {
        errorEl.textContent = res?.error || 'Failed to save model.';
        saveBtn.disabled = false;
        return;
      }
      showToast('Custom model added', 'success');
      overlay.remove();
      restoreRightPane();
      onChanged?.();
    } catch (err: any) {
      errorEl.textContent = err?.message || 'Save failed.';
      saveBtn.disabled = false;
    }
  });

  form.appendChild(actions);
  card.appendChild(form);

  const divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid #222;margin:14px -16px 10px;';
  card.appendChild(divider);

  const listTitle = document.createElement('div');
  listTitle.textContent = 'Custom models';
  listTitle.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;';
  card.appendChild(listTitle);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:min(32vh,220px);overflow:auto;';
  const customs = modelsMeta.filter(m => m.source === 'custom');
  if (customs.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9a9a9a;font-size:12px;';
    empty.textContent = 'No custom models yet.';
    list.appendChild(empty);
  } else {
    for (const m of customs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #1f1f1f;border-radius:8px;background:#131313;';
      const label = document.createElement('div');
      label.style.cssText = 'display:flex;flex-direction:column;';
      const title = document.createElement('span');
      title.textContent = m.name || m.key;
      title.style.cssText = 'font-size:13px;color:#eaeaea;';
      const meta = document.createElement('span');
      meta.textContent = `${m.provider || 'openai'} · ${m.key}`;
      meta.style.cssText = 'font-size:11px;color:#a0a0a0;';
      label.appendChild(title);
      label.appendChild(meta);
      row.appendChild(label);

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Remove';
      del.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid #3a2424;background:#1f1313;color:#f2c3c3;cursor:pointer;';
      del.addEventListener('click', async () => {
        try {
          const res = await window.ai?.models?.remove?.(m.key);
          if (!res || !res.ok) {
            showToast(res?.error || 'Failed to remove model', 'error');
            return;
          }
          showToast('Removed custom model', 'success');
          overlay.remove();
          restoreRightPane();
          onChanged?.();
        } catch (err: any) {
          showToast(err?.message || 'Failed to remove model', 'error');
        }
      });
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  card.appendChild(list);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

async function populateModelMenu(menu: HTMLElement | null): Promise<void> {
  if (!menu) return;
  menu.innerHTML = '<div class="item" role="menuitem" style="opacity:.7">Loading…</div>';
  try {
    const res = await window.ai?.models?.list?.();
    if (!res || !res.ok || !Array.isArray(res.models) || res.models.length === 0) {
      menu.innerHTML = '<div class="item" role="menuitem">No models available</div>';
      return;
    }
    modelsMeta = res.models.map((m: any) => ({
      key: String(m?.key || ''),
      name: String(m?.name || m?.key || ''),
      provider: typeof m?.provider === 'string' ? m.provider : getModelProvider(String(m?.key || '')),
      type: typeof m?.type === 'string' ? m.type : undefined,
      source: m?.source === 'custom' ? 'custom' : 'builtin',
    })).filter(meta => meta.key);
    menu.innerHTML = '';

    enforceModelProviderLock();

    const lockedProvider = lockedProviderForActiveSession();

    const onSelect = (key: string) => {
      const meta = modelsMeta.find(m => m.key === key);
      const provider = meta?.provider || getModelProvider(key);
      if (lockedProvider && provider && provider !== lockedProvider) return;
      uiState.model = key;
      alignActiveSessionProviderToModel();
      enforceReasoningForModel();
      saveUiState();
      syncUiLabels();
      closeAllDropdowns();
    };

    // Create scrollable container for model items
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'model-list-scroll';

    for (const meta of modelsMeta) {
      const btn = document.createElement('button');
      btn.className = 'item';
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-value', meta.key);
      btn.textContent = meta.name;
      const lockedOut = lockedProvider && meta.provider && meta.provider !== lockedProvider;
      btn.disabled = lockedOut;
      if (lockedOut) {
        btn.setAttribute('aria-disabled', 'true');
        btn.title = 'Switch provider by starting a new chat';
      } else {
        btn.removeAttribute('aria-disabled');
        btn.title = '';
      }
      btn.addEventListener('click', () => onSelect(meta.key));
      scrollContainer.appendChild(btn);
    }
    menu.appendChild(scrollContainer);

    // Create fixed footer for "Add new model" button
    const footer = document.createElement('div');
    footer.className = 'model-add-footer';
    const addBtn = document.createElement('button');
    addBtn.className = 'item';
    addBtn.type = 'button';
    addBtn.setAttribute('role', 'menuitem');
    addBtn.textContent = 'Add new model…';
    addBtn.addEventListener('click', () => {
      closeAllDropdowns();
      openCustomModelDialog(() => { void populateModelMenu(menu); });
    });
    footer.appendChild(addBtn);
    menu.appendChild(footer);

    if (!modelsMeta.some(meta => meta.key === uiState.model)) {
      uiState.model = modelsMeta[0]?.key || uiState.model;
      enforceReasoningForModel();
      saveUiState();
    }
    alignActiveSessionProviderToModel();
    syncUiLabels();
    applyModelLockConstraints();
  } catch (error) {
    console.error('Failed to load model list', error);
    menu.innerHTML = '<div class="item" role="menuitem">Failed to load models</div>';
  }
}

async function setupUiControls(): Promise<void> {
  loadUiState();
  syncUiLabels();
  const ddMode = document.getElementById('dd-mode');
  const ddReason = document.getElementById('dd-reason');
  const ddModel = document.getElementById('dd-model');
  setupDropdown('btn-mode', 'dd-mode');
  setupDropdown('btn-reason', 'dd-reason');
  setupDropdown('btn-model', 'dd-model');
  applyModelLockConstraints();
  ddMode?.querySelectorAll('.item').forEach(it => it.addEventListener('click', (e) => { const v = (e.currentTarget as HTMLElement).getAttribute('data-value') as UiState['mode'] | null; if (!v) return; uiState.mode = v; saveUiState(); syncUiLabels(); closeAllDropdowns(); }));
  ddReason?.querySelectorAll('.item').forEach(it => it.addEventListener('click', (e) => {
    const v = (e.currentTarget as HTMLElement).getAttribute('data-value') as UiState['reasoning'] | null;
    if (!v) return;
    const allowed = allowedReasoningOptions(uiState.model);
    if (!allowed.includes(v)) return;
    uiState.reasoning = v;
    saveUiState();
    syncUiLabels();
    closeAllDropdowns();
  }));
  await populateModelMenu(ddModel);
}

// Chat UI helpers
const chatEl = document.getElementById('chat-thread') as HTMLElement;
const chatHomeEl = document.getElementById('chat-home') as HTMLElement | null;
const wsBar = document.getElementById('workspace-bar') as HTMLElement;
const wsPath = document.getElementById('workspace-path') as HTMLElement;
const btnChangeWs = document.getElementById('btn-change-ws') as HTMLButtonElement;
const btnSend = document.getElementById('btn-send') as HTMLButtonElement | null;
const btnChatBack = document.getElementById('btn-chat-back') as HTMLButtonElement | null;
const btnNewChat = document.getElementById('btn-new-chat') as HTMLButtonElement | null;
const btnThemeToggle = document.getElementById('btn-theme-toggle') as HTMLButtonElement | null;

// Theme management
function applyTheme(theme: 'dark' | 'light'): void {
  if (theme === 'light') {
    document.body.classList.add('theme-light');
  } else {
    document.body.classList.remove('theme-light');
  }
  // Notify child view of theme change
  try { (window as any).layout?.setTheme?.(theme); } catch { }
}

function toggleTheme(): void {
  uiState.theme = uiState.theme === 'dark' ? 'light' : 'dark';
  applyTheme(uiState.theme);
  saveUiState();
}
const workspaceBtnLabel = document.getElementById('workspace-label') as HTMLElement | null;
const todoPanel = new TodoPanel();

chatEl?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const anchor = target.closest('a') as HTMLAnchorElement | null;
  if (!anchor) return;
  const hrefAttr = anchor.getAttribute('href') || '';
  const fullHref = anchor.href || hrefAttr;
  const href = hrefAttr || fullHref;
  if (!href) return;
  const isWorkspaceLink = anchor.dataset.workspaceLink === 'true';
  if (isWorkspaceLink) {
    const lower = hrefAttr.toLowerCase();
    if (!lower.startsWith('workspace://')) return;
    event.preventDefault();
    const rawPath = hrefAttr.slice('workspace://'.length);
    const decoded = decodeURIComponent(rawPath).replace(/^\/+/, '');
    if (!decoded || decoded.includes('\0')) return;
    try {
      window.viewer.openPath(decoded);
    } catch {

    }
    return;
  }
  if (href.startsWith('#')) return;
  event.preventDefault();
  const normalized = normalizePreviewUrl(fullHref);
  if (!normalized) return;
  try {
    const result = window.preview?.open?.(normalized, { focus: true });
    if (result && typeof (result as Promise<any>).catch === 'function') {
      (result as Promise<any>).catch(() => {
        try { window.open(normalized, '_blank', 'noopener,noreferrer'); } catch { }
      });
    }
  } catch {
    try { window.open(normalized, '_blank', 'noopener,noreferrer'); } catch { }
  }
});

const projectOverlay = document.getElementById('project-overlay') as HTMLElement | null;
const projectOverlayOpenBtn = document.getElementById('project-overlay-open') as HTMLButtonElement | null;
const projectOverlayError = document.getElementById('project-overlay-error') as HTMLElement | null;

let workingDir = '';
let additionalWorkingDir: string | null = null;
// If the user selects an additional directory before any chat session exists,
// hold it here and apply it to the next newly-created session.
let pendingAdditionalWorkingDir: string | null = null;

function basenameFromFsPath(p: string): string {
  const norm = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || norm || '';
}

function formatScopedPathForDisplay(rawPath: string): string {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return '';

  const workspaceName = basenameFromFsPath(workingDir) || 'workspace';
  const additionalName = basenameFromFsPath(additionalWorkingDir || '') || 'additional';

  const lower = raw.toLowerCase();
  if (lower.startsWith('workspace:')) {
    const rest = raw.slice('workspace:'.length).replace(/^\/+/, '');
    return rest ? `${workspaceName}/${rest}` : workspaceName;
  }
  if (lower.startsWith('additional:')) {
    const rest = raw.slice('additional:'.length).replace(/^\/+/, '');
    return rest ? `${additionalName}/${rest}` : additionalName;
  }
  return raw;
}

let chatSessions: StoredChat[] = [];
let activeChatId: string | null = null;
let conversationHistory: ChatEvent[] = [];
let conversationRaw: OpenAIResponseItem[] = [];
let stopCurrent: (() => void) | null = null;
let streamingSessionId: string | null = null;
const sessionRunTokens = new Map<string, string>();
let currentAssistant: HTMLElement | null = null;
let awaitingNewSegment = false;
let pendingAttachments: ImageAttachment[] = [];
let assistantWorkingIndicatorEl: HTMLElement | null = null;
let assistantWorkingIndicatorLabelEl: HTMLElement | null = null;
let assistantWorkingIndicatorActive = false;
const assistantWorkingWords = [
  'Thinking',
  'Working',
  'Reasoning',
  'Pondering',
  'Iterating',
  'Analyzing',
  'Calculating',
  'Processing',
  'Composing',
  'Formulating',
  'Strategizing',
  'Evaluating',
  'Synthesizing',
  'Reflecting',
  'Contemplating',
  'Deliberating',
  'Optimizing',
  'Exploring',
  'Innovating',
];

type StartStreamingSessionOptions = {
  sessionId: string;
  newItems?: OpenAIResponseItem[];
  resume?: boolean;
};

let startStreamingSession: ((opts: StartStreamingSessionOptions) => void | Promise<void>) | null = null;

const isImageMime = (m?: string) => typeof m === 'string' && m.startsWith('image/');
const fileExt = (name?: string, mime?: string) =>
  (name || '').split('.').pop() || (mime || 'file');
const fileBaseName = (value?: string): string => {
  if (!value) return '';
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
};
function createFileIcon(ext: string): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = (ext || 'file').slice(0, 4).toUpperCase();
  return icon;
}


// Smart scroll: track if user is near bottom, only auto-scroll if they are
const SCROLL_THRESHOLD = 150; // pixels from bottom to consider "at bottom"
let userScrolledUp = false;
let hasNewContent = false;

function isNearBottom(): boolean {
  try {
    const { scrollTop, scrollHeight, clientHeight } = chatEl;
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
  } catch { return true; }
}

function updateScrollState(): void {
  userScrolledUp = !isNearBottom();
  if (!userScrolledUp) {
    hasNewContent = false;
    hideJumpToBottomButton();
  }
}

function showJumpToBottomButton(): void {
  const btn = document.getElementById('jump-to-bottom-btn');
  if (btn) btn.classList.add('visible');
}

function hideJumpToBottomButton(): void {
  const btn = document.getElementById('jump-to-bottom-btn');
  if (btn) btn.classList.remove('visible');
}

function scrollToBottom(force = false): void {
  try {
    if (force || !userScrolledUp) {
      chatEl.scrollTop = chatEl.scrollHeight;
      hasNewContent = false;
      hideJumpToBottomButton();
    } else {
      // User has scrolled up, don't auto-scroll but show the button
      hasNewContent = true;
      showJumpToBottomButton();
    }
  } catch { }
}

// Listen for user scroll events
chatEl.addEventListener('scroll', () => {
  updateScrollState();
}, { passive: true });

// Jump to bottom button click handler
const jumpToBottomBtn = document.getElementById('jump-to-bottom-btn');
if (jumpToBottomBtn) {
  jumpToBottomBtn.addEventListener('click', () => {
    userScrolledUp = false;
    hasNewContent = false;
    scrollToBottom(true);
  });
}

function addMessage(role: 'user' | 'assistant', text: string): HTMLElement {
  // Remove greeting when first message is added
  if (role === 'user') {
    const existingGreeting = document.getElementById('chat-greeting-message');
    if (existingGreeting) {
      existingGreeting.remove();
    }
  }

  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? 'You' : 'Assistant';
  const content = document.createElement('div');
  content.className = 'content';
  if (role === 'assistant') {
    setAssistantMessageContent(content, text);
  } else {
    renderUserMessageContent(content, text);
  }
  el.appendChild(roleEl); el.appendChild(content);

  chatEl.appendChild(el); scrollToBottom();
  repositionAssistantWorkingIndicator();
  return content;
}

type WorkspaceChangeFile = { path: string; status: string; additions?: number | null; deletions?: number | null };
type WorkspaceChangesResponse = {
  ok: boolean;
  git?: boolean;
  files?: WorkspaceChangeFile[];
  totals?: { files: number; additions: number; deletions: number };
  fingerprint?: string;
  page?: { offset: number; limit: number; hasMore: boolean };
  error?: string;
};

type WorkspaceChangesSnapshot = {
  updatedAt: number;
  runId?: string;
  totals: { files: number; additions: number; deletions: number };
  files: WorkspaceChangeFile[];
  anchorAssistantMessageIndex?: number;
  page?: { offset: number; limit: number; hasMore: boolean };
};

function findLastAssistantContentEl(): HTMLElement | null {
  const nodes = chatEl.querySelectorAll('.msg.assistant .content');
  if (!nodes.length) return null;
  return nodes[nodes.length - 1] as HTMLElement;
}

function formatChangeCounts(additions?: number | null, deletions?: number | null): string {
  const add = typeof additions === 'number' ? `+${additions}` : '';
  const del = typeof deletions === 'number' ? `-${deletions}` : '';
  if (add && del) return `${add} ${del}`;
  return add || del || '';
}

function statusLabel(status: string): { label: string; cls: string } {
  const s = (status || '').trim();
  switch (s) {
    case 'A': return { label: 'Added', cls: 'st-added' };
    case 'M': return { label: 'Modified', cls: 'st-modified' };
    case 'D': return { label: 'Deleted', cls: 'st-deleted' };
    case 'R': return { label: 'Renamed', cls: 'st-renamed' };
    case '?': return { label: 'Untracked', cls: 'st-untracked' };
    default: return { label: s || 'Changed', cls: 'st-modified' };
  }
}

function fingerprintWorkspaceChangesFiles(files: WorkspaceChangeFile[] | undefined): string {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return '';
  const normalized = list
    .map((f) => ({
      path: typeof f?.path === 'string' ? f.path : '',
      status: typeof f?.status === 'string' ? f.status : '',
      additions: f?.additions === null || f?.additions === undefined ? null : Number(f.additions),
      deletions: f?.deletions === null || f?.deletions === undefined ? null : Number(f.deletions),
    }))
    .filter((f) => !!f.path)
    .map((f) => ({
      ...f,
      additions: typeof f.additions === 'number' && Number.isFinite(f.additions) ? Math.max(0, Math.floor(f.additions)) : null,
      deletions: typeof f.deletions === 'number' && Number.isFinite(f.deletions) ? Math.max(0, Math.floor(f.deletions)) : null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  try { return JSON.stringify(normalized); } catch { return normalized.map(f => `${f.path}|${f.status}|${f.additions ?? ''}|${f.deletions ?? ''}`).join('\n'); }
}

function snapshotFromWorkspaceChangesResponse(
  res: WorkspaceChangesResponse,
  opts?: { runId?: string; anchorAssistantMessageIndex?: number }
): WorkspaceChangesSnapshot | null {
  if (!res?.ok) return null;
  const files = Array.isArray(res.files) ? res.files : [];
  if (!files.length) return null;
  const totals = res.totals || { files: files.length, additions: 0, deletions: 0 };
  const snapshot: WorkspaceChangesSnapshot = {
    updatedAt: Date.now(),
    runId: opts?.runId || undefined,
    totals,
    files,
  };
  if (typeof opts?.anchorAssistantMessageIndex === 'number' && Number.isFinite(opts.anchorAssistantMessageIndex)) {
    snapshot.anchorAssistantMessageIndex = Math.max(0, Math.floor(opts.anchorAssistantMessageIndex));
  }
  if (res.page && typeof res.page === 'object') {
    const offset = Math.max(0, Math.floor(Number((res.page as any).offset) || 0));
    const limit = Math.max(0, Math.floor(Number((res.page as any).limit) || 0));
    const hasMore = Boolean((res.page as any).hasMore);
    snapshot.page = { offset, limit, hasMore };
  }
  return snapshot;
}

function normalizeWorkspaceChangesSnapshot(value: any): WorkspaceChangesSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const updatedAt = Number(value.updatedAt) || Date.now();
  const totalsRaw = value.totals || {};
  const totals = {
    files: Math.max(0, Math.floor(Number(totalsRaw.files) || 0)),
    additions: Math.max(0, Math.floor(Number(totalsRaw.additions) || 0)),
    deletions: Math.max(0, Math.floor(Number(totalsRaw.deletions) || 0)),
  };
  const filesRaw = Array.isArray(value.files) ? value.files : [];
  const files: WorkspaceChangeFile[] = [];
  for (const entry of filesRaw.slice(0, 300)) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (!path) continue;
    const status = typeof entry.status === 'string' ? entry.status : '?';
    const additions = entry.additions === null || entry.additions === undefined ? null : Number(entry.additions);
    const deletions = entry.deletions === null || entry.deletions === undefined ? null : Number(entry.deletions);
    files.push({
      path,
      status,
      additions: typeof additions === 'number' && Number.isFinite(additions) ? Math.max(0, Math.floor(additions)) : null,
      deletions: typeof deletions === 'number' && Number.isFinite(deletions) ? Math.max(0, Math.floor(deletions)) : null,
    });
  }
  if (!files.length) return undefined;
  const runId = typeof value.runId === 'string' && value.runId.trim() ? value.runId.trim() : undefined;
  const anchorAssistantMessageIndexRaw = value.anchorAssistantMessageIndex;
  const anchorAssistantMessageIndex =
    typeof anchorAssistantMessageIndexRaw === 'number' && Number.isFinite(anchorAssistantMessageIndexRaw)
      ? Math.max(0, Math.floor(anchorAssistantMessageIndexRaw))
      : undefined;
  const pageRaw = value.page || {};
  const pageOffset = Math.max(0, Math.floor(Number(pageRaw.offset) || 0));
  const pageLimit = Math.max(0, Math.floor(Number(pageRaw.limit) || 0));
  const pageHasMore = Boolean(pageRaw.hasMore);
  const snapshot: WorkspaceChangesSnapshot = {
    updatedAt,
    runId,
    totals: totals.files ? totals : { ...totals, files: files.length },
    files,
  };
  if (anchorAssistantMessageIndex !== undefined) snapshot.anchorAssistantMessageIndex = anchorAssistantMessageIndex;
  if (pageLimit > 0 || pageOffset > 0 || pageHasMore) snapshot.page = { offset: pageOffset, limit: pageLimit, hasMore: pageHasMore };
  return snapshot;
}

async function setSessionWorkspaceChanges(sessionId: string, workspaceChanges: WorkspaceChangesSnapshot | undefined): Promise<void> {
  const setter = (window as any).ai?.sessions?.setWorkspaceChanges;
  if (!sessionId || typeof setter !== 'function') return;
  try {
    const res = await setter(sessionId, workspaceChanges);
    if (res?.ok && res.session) {
      const updated = normalizeStoredSession(res.session);
      if (updated) {
        const idx = chatSessions.findIndex(s => s.id === updated.id);
        if (idx >= 0) chatSessions[idx] = updated;
      }
    }
  } catch { }
}

function renderWorkspaceChangesPanel(host: HTMLElement, snapshot: WorkspaceChangesSnapshot, ctx?: { sessionId?: string }): void {
  if (!host || !snapshot || !snapshot.files?.length) return;
  try { host.querySelector('.workspace-changes')?.remove(); } catch {}

  const api = (window as any).workspace;
  const canControl = !!api?.diff && !!api?.undoFile && !!api?.undoAll;
  const sessionId = typeof ctx?.sessionId === 'string' && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined;
  const runId = typeof snapshot.runId === 'string' && snapshot.runId.trim() ? snapshot.runId.trim() : undefined;
  const anchorAssistantMessageIndex =
    typeof snapshot.anchorAssistantMessageIndex === 'number' && Number.isFinite(snapshot.anchorAssistantMessageIndex)
      ? Math.max(0, Math.floor(snapshot.anchorAssistantMessageIndex))
      : undefined;

  const files = snapshot.files;
  const totals = snapshot.totals || { files: files.length, additions: 0, deletions: 0 };

  const panel = document.createElement('div');
  panel.className = 'workspace-changes';

  const header = document.createElement('div');
  header.className = 'workspace-changes-header';

  const title = document.createElement('div');
  title.className = 'workspace-changes-title';
  title.textContent = `${totals.files} file${totals.files === 1 ? '' : 's'} changed`;

  const counts = document.createElement('div');
  counts.className = 'workspace-changes-counts';
  counts.textContent = `+${totals.additions}  -${totals.deletions}`;

  const actions = document.createElement('div');
  actions.className = 'workspace-changes-actions';

  const btnViewAll = document.createElement('button');
  btnViewAll.type = 'button';
  btnViewAll.className = 'workspace-changes-btn';
  btnViewAll.textContent = 'View diff';
  btnViewAll.disabled = !canControl;

  const btnUndoAll = document.createElement('button');
  btnUndoAll.type = 'button';
  btnUndoAll.className = 'workspace-changes-btn danger';
  btnUndoAll.textContent = 'Undo all';
  btnUndoAll.disabled = !canControl;

  const refresh = async () => {
    try {
      await renderWorkspaceChangesInto(host, { sessionId: ctx?.sessionId, runId: snapshot.runId, anchorAssistantMessageIndex });
    } catch { }
  };

  btnViewAll.addEventListener('click', async () => {
    if (!canControl) return;
    btnViewAll.disabled = true;
    try {
      const diffRes = await api.diff({ sessionId, runId });
      if (diffRes?.ok && typeof diffRes.diff === 'string') {
        try { (window as any).child?.switchTab?.('code'); } catch {}
        try {
          await (window as any).viewer?.showText?.({ title: 'BrilliantCode Diff (all).diff', content: diffRes.diff });
        } catch {}
      } else if (diffRes && typeof diffRes.error === 'string' && diffRes.error.trim()) {
        showToast(diffRes.error.trim(), 'error');
      }
    } finally {
      btnViewAll.disabled = false;
    }
  });

  btnUndoAll.addEventListener('click', async () => {
    if (!canControl) return;
    btnUndoAll.disabled = true;
    try {
      const res = await api.undoAll({ sessionId, runId });
      if (res && res.ok !== true && typeof res.error === 'string' && res.error.trim()) {
        showToast(res.error.trim(), 'error');
        return;
      }
      await refresh();
    } finally {
      btnUndoAll.disabled = false;
    }
  });

  actions.appendChild(btnViewAll);
  actions.appendChild(btnUndoAll);

  header.appendChild(title);
  header.appendChild(counts);
  header.appendChild(actions);
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'workspace-changes-list';

  const renderPathInto = (btn: HTMLButtonElement, rawPath: string): void => {
    btn.textContent = '';
    const normalized = String(rawPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const base = parts.length ? parts[parts.length - 1] : normalized;
    const dir = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';

    if (dir) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'path-dir';
      dirSpan.textContent = dir;
      btn.appendChild(dirSpan);
    }
    const baseSpan = document.createElement('span');
    baseSpan.className = 'path-base';
    baseSpan.textContent = base || rawPath || '';
    btn.appendChild(baseSpan);
  };

  const appendFileRow = (f: WorkspaceChangeFile) => {
    const row = document.createElement('div');
    row.className = 'workspace-change';

    const left = document.createElement('div');
    left.className = 'workspace-change-left';

    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'workspace-change-file';
    renderPathInto(fileBtn, f.path);
    fileBtn.title = 'Open file';
    fileBtn.addEventListener('click', async () => {
      try { await (window as any).viewer?.openPath?.(f.path); } catch {}
    });

    const st = statusLabel(f.status);
    const stEl = document.createElement('span');
    stEl.className = `workspace-change-status ${st.cls}`;
    stEl.textContent = st.label;

    left.appendChild(fileBtn);
    left.appendChild(stEl);

    const right = document.createElement('div');
    right.className = 'workspace-change-right';

    const countsEl = document.createElement('span');
    countsEl.className = 'workspace-change-counts';
    countsEl.textContent = formatChangeCounts(f.additions, f.deletions);

    const btnDiff = document.createElement('button');
    btnDiff.type = 'button';
    btnDiff.className = 'workspace-change-btn';
    btnDiff.textContent = 'View diff';
    btnDiff.disabled = !canControl;
    btnDiff.addEventListener('click', async () => {
      if (!canControl) return;
      btnDiff.disabled = true;
      try {
        const diffRes = await api.diff({ path: f.path, sessionId, runId });
        if (diffRes?.ok && typeof diffRes.diff === 'string') {
          try { (window as any).child?.switchTab?.('code'); } catch {}
          try {
            await (window as any).viewer?.showText?.({ title: `BrilliantCode Diff - ${f.path}.diff`, content: diffRes.diff });
          } catch {}
        } else if (diffRes && typeof diffRes.error === 'string' && diffRes.error.trim()) {
          showToast(diffRes.error.trim(), 'error');
        }
      } finally {
        btnDiff.disabled = false;
      }
    });

    const btnUndo = document.createElement('button');
    btnUndo.type = 'button';
    btnUndo.className = 'workspace-change-btn';
    btnUndo.textContent = 'Undo';
    btnUndo.addEventListener('click', async () => {
      if (!canControl) return;
      btnUndo.disabled = true;
      try {
        const res = await api.undoFile({ path: f.path, sessionId, runId });
        if (res && res.ok !== true && typeof res.error === 'string' && res.error.trim()) {
          showToast(res.error.trim(), 'error');
          return;
        }
        await refresh();
      } finally {
        btnUndo.disabled = false;
      }
    });

    right.appendChild(countsEl);
    right.appendChild(btnUndo);
    right.appendChild(btnDiff);

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  };

  for (const f of files) appendFileRow(f);

  let currentOffset = files.length;
  const totalFiles = Math.max(0, Math.floor(Number(totals.files) || files.length));
  const hasMoreInitial = snapshot.page?.hasMore === true || currentOffset < totalFiles;
  if (hasMoreInitial) {
    const moreRow = document.createElement('div');
    moreRow.className = 'workspace-change more-row';
    const spacer = document.createElement('div');
    spacer.className = 'workspace-change-left';
    const right = document.createElement('div');
    right.className = 'workspace-change-right';
    const btnMore = document.createElement('button');
    btnMore.type = 'button';
    btnMore.className = 'workspace-change-btn';
    const remaining = Math.max(0, totalFiles - currentOffset);
    const showCount = Math.min(DEFAULT_CHANGES_PAGE_LIMIT, remaining || DEFAULT_CHANGES_PAGE_LIMIT);
    btnMore.textContent = `Show ${showCount} more (${currentOffset}/${totalFiles})`;
    btnMore.disabled = !api?.changes;
    btnMore.addEventListener('click', async () => {
      if (!api?.changes) return;
      btnMore.disabled = true;
      try {
        const res: WorkspaceChangesResponse = await api.changes({ sessionId, runId, offset: currentOffset, limit: DEFAULT_CHANGES_PAGE_LIMIT });
        if (!res?.ok) {
          if (res && typeof res.error === 'string' && res.error.trim()) showToast(res.error.trim(), 'error');
          return;
        }
        const next = Array.isArray(res.files) ? res.files : [];
        for (const entry of next) appendFileRow(entry);
        currentOffset += next.length;
        const total = Math.max(0, Math.floor(Number(res.totals?.files) || totalFiles));
        const hasMore = res.page?.hasMore === true || currentOffset < total;
        if (!hasMore || next.length === 0) {
          moreRow.remove();
        } else {
          const remaining = Math.max(0, total - currentOffset);
          const showCount = Math.min(DEFAULT_CHANGES_PAGE_LIMIT, remaining || DEFAULT_CHANGES_PAGE_LIMIT);
          btnMore.textContent = `Show ${showCount} more (${currentOffset}/${total})`;
        }
      } catch { }
      finally { btnMore.disabled = false; }
    });
    right.appendChild(btnMore);
    moreRow.appendChild(spacer);
    moreRow.appendChild(right);
    list.appendChild(moreRow);
  }

  panel.appendChild(list);
  host.appendChild(panel);
}

const DEFAULT_CHANGES_PAGE_LIMIT = 20;

async function computeWorkspaceChangesSnapshot(ctx?: { runId?: string; sessionId?: string; anchorAssistantMessageIndex?: number }): Promise<WorkspaceChangesSnapshot | null> {
  const api = (window as any).workspace;
  if (!api?.changes) return null;

  let res: WorkspaceChangesResponse | null = null;
  const sessionId = typeof ctx?.sessionId === 'string' && ctx.sessionId.trim() ? ctx.sessionId.trim() : undefined;
  const runId = typeof ctx?.runId === 'string' && ctx.runId.trim() ? ctx.runId.trim() : undefined;
  try { res = await api.changes({ sessionId, runId, limit: DEFAULT_CHANGES_PAGE_LIMIT, offset: 0 }); } catch { res = null; }
  if (!res?.ok) {
    if (res && typeof (res as any).error === 'string' && (res as any).error.trim()) {
      showToast((res as any).error.trim(), 'error');
    }
    return null;
  }
  const snapshot = snapshotFromWorkspaceChangesResponse(res, { runId: ctx?.runId || undefined, anchorAssistantMessageIndex: ctx?.anchorAssistantMessageIndex });
  return snapshot;
}

async function renderWorkspaceChangesInto(host: HTMLElement, ctx?: { sessionId?: string; runId?: string; anchorAssistantMessageIndex?: number }): Promise<void> {
  if (!host) return;
  const snapshot = await computeWorkspaceChangesSnapshot({ sessionId: ctx?.sessionId, runId: ctx?.runId, anchorAssistantMessageIndex: ctx?.anchorAssistantMessageIndex });
  if (!snapshot) {
    try { host.querySelector('.workspace-changes')?.remove(); } catch {}
    if (ctx?.sessionId) void setSessionWorkspaceChanges(ctx.sessionId, undefined);
    return;
  }
  if (ctx?.sessionId) void setSessionWorkspaceChanges(ctx.sessionId, snapshot);
  renderWorkspaceChangesPanel(host, snapshot, { sessionId: ctx?.sessionId });
}


function renderAttachmentChips(container: HTMLElement, items: ImageAttachment[]): void {
  if (!items?.length) return;
  const wrap = document.createElement('div');
  wrap.style.marginTop = '8px';
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '6px';

  for (const a of items) {
    const chip = document.createElement('span');
    chip.className = 'ai-attachment';

    if (isImageMime(a.mime) && a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name || 'image';
      img.onerror = () => {
        img.remove();
        chip.insertBefore(createFileIcon(fileExt(a.name, a.mime)), chip.firstChild || null);
      };
      chip.appendChild(img);
    } else {
      chip.appendChild(createFileIcon(fileExt(a.name, a.mime)));
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = a.name || a.mime || 'file';
    chip.appendChild(name);

    wrap.appendChild(chip);
  }

  container.appendChild(wrap);
}

function pickAssistantWorkingWord(): string {
  if (!assistantWorkingWords.length) return 'Working…';
  const index = Math.floor(Math.random() * assistantWorkingWords.length);
  const base = assistantWorkingWords[index] ?? 'Working';
  return base.endsWith('…') ? base : `${base}…`;
}

function showAssistantWorkingIndicator(label?: string): void {
  if (!chatEl) return;
  if (!assistantWorkingIndicatorEl) {
    const row = document.createElement('div');
    row.className = 'assistant-working';
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');
    row.setAttribute('aria-atomic', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('span');
    labelEl.className = 'assistant-working-text';
    row.appendChild(spinner);
    row.appendChild(labelEl);
    assistantWorkingIndicatorEl = row;
    assistantWorkingIndicatorLabelEl = labelEl;
  }
  const labelText = label && label.trim() ? label.trim() : pickAssistantWorkingWord();
  if (assistantWorkingIndicatorLabelEl) {
    assistantWorkingIndicatorLabelEl.textContent = labelText;
  }
  chatEl.appendChild(assistantWorkingIndicatorEl!);
  assistantWorkingIndicatorActive = true;
  scrollToBottom();
}

function hideAssistantWorkingIndicator(): void {
  assistantWorkingIndicatorActive = false;
  if (assistantWorkingIndicatorEl?.parentElement) {
    assistantWorkingIndicatorEl.parentElement.removeChild(assistantWorkingIndicatorEl);
  }
}

function updateAssistantWorkingIndicator(label?: string): void {
  showAssistantWorkingIndicator(label);
  repositionAssistantWorkingIndicator();
}

function repositionAssistantWorkingIndicator(): void {
  if (!assistantWorkingIndicatorActive || !assistantWorkingIndicatorEl || !chatEl) return;
  if (chatEl.lastElementChild !== assistantWorkingIndicatorEl) {
    chatEl.appendChild(assistantWorkingIndicatorEl);
    scrollToBottom();
  }
}

function setProgress(active: boolean, text?: string): void {
  if (active) {
    updateAssistantWorkingIndicator(text);
  } else {
    hideAssistantWorkingIndicator();
  }
}

function setSendButton(mode: 'send' | 'stop'): void {
  if (!btnSend) return;
  if (mode === 'stop') {
    btnSend.setAttribute('aria-label', 'Stop');
    btnSend.setAttribute('data-tooltip', 'Stop');
    btnSend.type = 'button';
    btnSend.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/></svg>';
    btnSend.onclick = () => {
      const sessionId = activeChatId;
      if (sessionId) {
        try { window.ai.stop(sessionId); } catch { }
        syncSessionFromStore(sessionId, { reRender: false }).catch(() => { });
      }
      if (stopCurrent) {
        try { stopCurrent(); } catch { }
      } else {
        setProgress(false);
        setSendButton('send');
      }
    };
  } else {
    btnSend.setAttribute('aria-label', 'Send');
    btnSend.setAttribute('data-tooltip', 'Send');
    btnSend.type = 'submit';
    btnSend.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    btnSend.onclick = null;
  }
}

function deriveChatTitle(text: string): string {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'New Chat';
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function formatTimestamp(ts: number): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return fmt.format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

function cloneHistory(items: OpenAIResponseItem[]): OpenAIResponseItem[] {
  const sc = (globalThis as any).structuredClone;
  if (typeof sc === 'function') {
    try {
      return sc(items) as OpenAIResponseItem[];
    } catch { }
  }
  try {
    return JSON.parse(JSON.stringify(items));
  } catch {
    return items.map(item => ({ ...item }));
  }
}

function openAIUserContentToBlocks(content: OpenAIUserContent[] | undefined): ChatContentBlock[] {
  const blocks: ChatContentBlock[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text') {
      const text = typeof part.text === 'string' ? part.text : part.text == null ? '' : String(part.text);
      blocks.push({ type: 'text', content: text });
    } else if (part.type === 'input_image') {
      const url = typeof (part as any).image_url === 'string' ? (part as any).image_url : '';
      if (!url) continue;
      if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const mime = match[1] || 'image/png';
          const data = match[2] || '';
          if (data) {
            blocks.push({ type: 'image', content: { mime_type: mime, data, filename: (part as any)?.filename ?? null } });
          }
          continue;
        }
      }
      if (/^[A-Za-z0-9+/=]+$/.test(url) && url.length > 100) {
        const mime = (typeof (part as any).mime_type === 'string' && (part as any).mime_type.trim()) ? (part as any).mime_type : 'image/png';
        blocks.push({ type: 'image', content: { mime_type: mime, data: url, filename: (part as any)?.filename ?? null } });
      } else {
        blocks.push({ type: 'text', content: `[image] ${url}` });
      }
    }
  }
  return blocks;
}

function blocksToUserContent(blocks: ChatContentBlock[]): OpenAIUserContent[] {
  const content: OpenAIUserContent[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') {
      content.push({ type: 'input_text', text: block.content ?? '' });
    } else if (block.type === 'image') {
      const mime = block.content?.mime_type || 'image/png';
      const data = block.content?.data || '';
      if (!data) continue;
      const filename = block.content?.filename ?? null;
      content.push({
        type: 'input_image',
        image_url: `data:${mime};base64,${data}`,
        filename,
      });
    }
  }
  if (!content.some(part => part.type === 'input_text')) {
    content.unshift({ type: 'input_text', text: '' });
  }
  return content;
}

// Provider-aware history conversion
function convertHistoryToChatEvents(
  history: OpenAIResponseItem[] | AnthropicConversationItem[],
  provider: Provider
): ChatEvent[] {
  if (provider === 'anthropic') {
    return convertAnthropicHistoryToEvents(history as AnthropicConversationItem[]);
  } else {
    return convertOpenAIHistoryToEvents(history as OpenAIResponseItem[]);
  }
}

// Convert Anthropic native format to UI events
function convertAnthropicHistoryToEvents(history: AnthropicConversationItem[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  const baseTs = Date.now();
  let offset = 0;

  for (const item of history || []) {
    if (!item || typeof item !== 'object') continue;
    const ts = baseTs + offset++;

    if (item.role === 'user' && 'content' in item) {
      // Handle Anthropic user messages
      const content = Array.isArray(item.content) ? item.content : [item.content];
      const blocks: ChatContentBlock[] = [];

      for (const block of content) {
        if (typeof block === 'string') {
          blocks.push({ type: 'text', content: block });
        } else if (block && typeof block === 'object') {
          if (block.type === 'text') {
            blocks.push({ type: 'text', content: (block as any).text || '' });
          } else if (block.type === 'image') {
            blocks.push({
              type: 'image',
              content: {
                mime_type: (block as any).source?.media_type || 'image/png',
                data: (block as any).source?.data || '',
                filename: null
              }
            });
          }
        }
      }

      if (blocks.length > 0) {
        events.push({ type: 'user', content: blocks, timestamp: ts });
      }
    } else if (item.role === 'assistant' && 'content' in item) {
      const contentBlocks = Array.isArray(item.content) ? item.content : [item.content];

      for (const block of contentBlocks) {
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'thinking') {
          events.push({
            type: 'reasoning',
            content: (block as any).thinking || '',
            timestamp: ts
          });
        } else if (block.type === 'text') {
          events.push({
            type: 'message',
            content: (block as any).text || '',
            timestamp: ts
          });
        } else if (block.type === 'tool_use') {
          const toolUse = block as any;
          events.push({
            type: 'tool_call',
            content: {
              tool_name: toolUse.name || '',
              call_id: toolUse.id || '',
              args: toolUse.input || {}
            },
            timestamp: ts
          });
        }
      }
    } else if ((item as any).type === 'tool_result') {
      const toolResult = item as any;
      const content = Array.isArray(toolResult.content) ? toolResult.content : [toolResult.content];

      for (const block of content) {
        if (block?.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            content: {
              call_id: block.tool_use_id || '',
              output: block.content || ''
            },
            timestamp: ts
          });
        }
      }
    }
  }

  return events;
}

// Convert OpenAI format to UI events
function convertOpenAIHistoryToEvents(history: OpenAIResponseItem[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  const baseTs = Date.now();
  let offset = 0;
  for (const item of history || []) {
    if (!item || typeof item !== 'object') continue;
    const ts = baseTs + offset++;

    if (item.role === 'user') {
      let blocks = openAIUserContentToBlocks(item.content as OpenAIUserContent[] | undefined);
      const displayText = typeof (item as any).display_text === 'string' ? (item as any).display_text : '';
      if (displayText) {
        if (blocks.some(block => block.type === 'text')) {
          blocks = blocks.map(block => block.type === 'text' ? { ...block, content: displayText } : block);
        } else {
          blocks = [{ type: 'text', content: displayText }, ...blocks];
        }
      }
      if (!blocks.length) continue;
      events.push({ type: 'user', content: blocks, timestamp: ts });
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .filter(block => block?.type === 'output_text')
        .map(block => String(block.text || ''))
        .join('');
      events.push({ type: 'message', content: text, timestamp: ts });
      continue;
    }

    if (item.type === 'function_call') {
      const toolName = typeof item.name === 'string' ? item.name : '';
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      if (!toolName || !callId) continue;
      let args: any = {};
      if (typeof item.arguments === 'string') {
        try { args = JSON.parse(item.arguments); } catch { args = item.arguments; }
      } else if (item.arguments != null) {
        args = item.arguments;
      }
      events.push({ type: 'tool_call', content: { tool_name: toolName, call_id: callId, args }, timestamp: ts });
      continue;
    }

    if (item.type === 'function_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      if (!callId) continue;
      const output = typeof item.output === 'string' ? item.output : item.output == null ? '' : String(item.output);
      events.push({ type: 'tool_result', content: { call_id: callId, output }, timestamp: ts });
      continue;
    }

    if (item.type === 'reasoning') {
      const summary = Array.isArray((item as any).summary)
        ? (item as any).summary
          .filter((block: any) => block?.type === 'summary_text')
          .map((block: any) => String(block.text || ''))
          .join('\n')
        : undefined;
      const text = typeof item.content === 'string' ? item.content : summary || '';
      const encrypted = typeof (item as any)?.encrypted_content === 'string' ? (item as any).encrypted_content : undefined;
      events.push({ type: 'reasoning', content: text, encrypted_reasoning: encrypted, timestamp: ts });
      continue;
    }
  }
  return events;
}

function normalizeStoredRuntime(value: any): StoredChatRuntime | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const statusRaw = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  const status: StoredChatRuntime['status'] =
    statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'error'
      ? statusRaw
      : 'idle';
  const updatedAtRaw = Number((value as any).updatedAt);
  const runtime: StoredChatRuntime = {
    status,
    updatedAt: Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now(),
  };
  const startedAtRaw = Number((value as any).startedAt);
  if (Number.isFinite(startedAtRaw) && startedAtRaw > 0) runtime.startedAt = startedAtRaw;
  const completedAtRaw = Number((value as any).completedAt);
  if (Number.isFinite(completedAtRaw) && completedAtRaw > 0) runtime.completedAt = completedAtRaw;
  return runtime;
}

function normalizeStoredSession(entry: any): StoredChat | null {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && entry.id ? entry.id : null;
  if (!id) return null;
  const title = typeof entry.title === 'string' && entry.title ? entry.title : 'New Chat';
  const createdAt = Number(entry.createdAt) || Date.now();
  const updatedAt = Number(entry.updatedAt) || createdAt;
  const provider: Provider = (entry as any).provider === 'anthropic' ? 'anthropic' : 'openai';
  const history = Array.isArray(entry.history) ? cloneHistory(entry.history) : [];
  const runtime = normalizeStoredRuntime((entry as any).runtime);
  const additionalWorkingDir = typeof entry.additionalWorkingDir === 'string' && entry.additionalWorkingDir ? entry.additionalWorkingDir : undefined;
  const workspaceChanges = normalizeWorkspaceChangesSnapshot((entry as any).workspaceChanges);
  return { id, title, createdAt, updatedAt, provider, history, runtime, additionalWorkingDir, workspaceChanges };
}

async function loadChatSessions(): Promise<void> {
  try {
    const res = await window.ai.sessions.list();
    if (!res || !res.ok || !Array.isArray(res.sessions)) {
      chatSessions = [];
      return;
    }
    chatSessions = (res.sessions as any[])
      .map(normalizeStoredSession)
      .filter((session): session is StoredChat => Boolean(session));
    chatSessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    chatSessions = [];
  }
}

function cloneEvents(events: ChatEvent[]): ChatEvent[] {
  const sc = (globalThis as any).structuredClone;
  if (typeof sc === 'function') {
    try {
      return sc(events) as ChatEvent[];
    } catch { }
  }
  try {
    return JSON.parse(JSON.stringify(events));
  } catch {
    return events.map(ev => ({ ...ev } as ChatEvent));
  }
}

function userTextFromBlocks(blocks: ChatContentBlock[]): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(block => block?.type === 'text')
    .map(block => (block as { type: 'text'; content: string }).content.trim())
    .filter(Boolean)
    .join(' ');
}

function imagesFromBlocks(blocks: ChatContentBlock[] | undefined | null): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  if (!Array.isArray(blocks)) return attachments;
  for (const block of blocks) {
    if (block?.type !== 'image') continue;
    const mime = block.content?.mime_type || 'image/png';
    const data = block.content?.data || '';
    if (!data) continue;
    const filename = typeof block.content?.filename === 'string' && block.content.filename ? block.content.filename : undefined;
    attachments.push({
      mime,
      base64: data,
      dataUrl: `data:${mime};base64,${data}`,
      name: filename ? fileBaseName(filename) : block.content?.filename || undefined,
      path: filename,
    });
  }
  return attachments;
}

function firstUserTextFromHistory(history: OpenAIResponseItem[]): string {
  for (const item of history || []) {
    if (item?.role === 'user') {
      const blocks = openAIUserContentToBlocks(item.content as OpenAIUserContent[] | undefined);
      const text = userTextFromBlocks(blocks);
      if (text) return text;
    }
  }
  return '';
}

function getActiveSession(): StoredChat | null {
  if (!activeChatId) return null;
  return chatSessions.find(session => session.id === activeChatId) ?? null;
}

function renderAdditionalWorkingDirBadge(): void {
  const additionalDirContainer = document.getElementById('additional-dir-container') as HTMLElement | null;
  if (!additionalDirContainer) return;
  if (!additionalWorkingDir) {
    additionalDirContainer.hidden = true;
    additionalDirContainer.innerHTML = '';
    return;
  }
  additionalDirContainer.hidden = false;
  const dirName = additionalWorkingDir.split('/').pop() || additionalWorkingDir;
  additionalDirContainer.innerHTML = `
    <div class="additional-dir-badge" title="${additionalWorkingDir}">
      <span class="dir-icon">
        <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
      </span>
      <span class="dir-name">${dirName}</span>
      <button class="remove-dir" type="button" title="Remove directory" aria-label="Remove directory">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
  `;
  const removeBtn = additionalDirContainer.querySelector('.remove-dir');
  removeBtn?.addEventListener('click', () => {
    setAdditionalWorkingDirState(null);
  });
}

function setAdditionalWorkingDirState(next: string | null, opts: { persist?: boolean } = {}): void {
  additionalWorkingDir = next || null;
  const activeSession = getActiveSession();
  if (activeSession) {
    activeSession.additionalWorkingDir = additionalWorkingDir || undefined;
  }
  renderAdditionalWorkingDirBadge();

  if (opts.persist === false) return;

  if (activeChatId) {
    // Persist immediately for the active session.
    pendingAdditionalWorkingDir = null;
    (window as any).ai?.sessions?.setAdditionalWorkingDir?.(activeChatId, additionalWorkingDir || undefined)?.catch?.(() => { });
    return;
  }

  // No session yet: keep it pending and apply to the next created session.
  pendingAdditionalWorkingDir = additionalWorkingDir;
}

function chatPreviewText(session: StoredChat): string {
  const events = convertHistoryToChatEvents(session.history, session.provider);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === 'message') {
      const text = (event.content || '').trim().replace(/\s+/g, ' ');
      if (text) return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    }
    if (event.type === 'user') {
      const text = userTextFromBlocks(event.content).trim().replace(/\s+/g, ' ');
      if (text) return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    }
    if (event.type === 'tool_result') {
      const text = (event.content?.output || '').trim().replace(/\s+/g, ' ');
      if (text) return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    }
  }
  return 'No messages yet';
}

function persistActiveChat(opts: { updateTimestamp?: boolean; updateTitle?: boolean; skipRender?: boolean; skipSort?: boolean } = {}): void {
  const session = getActiveSession();
  if (!session) return;
  session.history = cloneHistory(conversationRaw);
  const shouldUpdateTimestamp = opts.updateTimestamp !== false;
  if (shouldUpdateTimestamp) session.updatedAt = Date.now();
  if (opts.updateTitle) {
    const titleSeed = firstUserTextFromHistory(conversationRaw);
    if (titleSeed) {
      const derived = deriveChatTitle(titleSeed);
      if (!session.title || session.title === 'New Chat') {
        session.title = derived;
      }
    }
  }
  if (!opts.skipSort) sortSessionsByRecency();
  if (!opts.skipRender) renderChatHome();
}

function appendEventToActiveChat(event: ChatEvent): number {
  conversationHistory.push(event);
  return conversationHistory.length - 1;
}

function setChatView(view: 'home' | 'chat'): void {
  if (view === 'home') {
    chatHomeEl?.classList.add('active');
    chatEl.classList.add('hidden');
    if (btnChatBack) {
      btnChatBack.classList.add('hidden');
      btnChatBack.setAttribute('aria-hidden', 'true');
      btnChatBack.setAttribute('tabindex', '-1');
    }
  } else {
    chatHomeEl?.classList.remove('active');
    chatEl.classList.remove('hidden');
    if (btnChatBack) {
      btnChatBack.classList.remove('hidden');
      btnChatBack.removeAttribute('aria-hidden');
      btnChatBack.removeAttribute('tabindex');
    }
  }
}

function renderChatHome(): void {
  if (!chatHomeEl) return;
  chatHomeEl.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'chat-home-inner';

  const header = document.createElement('div');
  header.className = 'chat-home-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'chat-home-title';
  titleEl.textContent = 'Tasks';
  header.appendChild(titleEl);
  container.appendChild(header);

  const subtitle = document.createElement('div');
  subtitle.className = 'chat-home-subtitle';
  subtitle.textContent = chatSessions.length === 0 ? 'No conversations yet' : 'Recent conversations';
  container.appendChild(subtitle);

  if (chatSessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No tasks yet. Start a new task to see it here.';
    container.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'chat-list';
    const items = [...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const session of items) {
      const row = document.createElement('div');
      row.className = 'chat-item-row';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-item';
      btn.addEventListener('click', () => { openChatSession(session.id, { focusInput: true }); });

      const itemTitle = document.createElement('div');
      itemTitle.className = 'chat-item-title';
      itemTitle.textContent = session.title?.trim() ? session.title : 'New Chat';
      const runtimeStatusRaw = session.runtime?.status;
      const runtimeStatus = typeof runtimeStatusRaw === 'string' ? runtimeStatusRaw.toLowerCase() : '';
      if (runtimeStatus === 'running') {
        const badge = document.createElement('span');
        badge.className = 'chat-item-badge status-running';
        const spin = document.createElement('span');
        spin.className = 'spinner';
        spin.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'chat-item-badge-text';
        label.textContent = 'Running';
        badge.append(spin, label);
        itemTitle.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'chat-item-meta';
      meta.textContent = `Updated ${formatTimestamp(session.updatedAt)}`;

      const preview = document.createElement('div');
      preview.className = 'chat-item-preview';
      preview.textContent = chatPreviewText(session);

      btn.append(itemTitle, meta, preview);
      row.appendChild(btn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'chat-item-delete';
      deleteBtn.setAttribute('aria-label', `Delete chat ${session.title || session.id}`);
      deleteBtn.innerHTML = '&times;';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        void confirmAndDeleteSession(session.id, session.title);
      });
      row.appendChild(deleteBtn);

      list.appendChild(row);
    }
    container.appendChild(list);
  }

  chatHomeEl.appendChild(container);
}

async function confirmAndDeleteSession(sessionId: string, sessionTitle?: string): Promise<void> {
  const label = sessionTitle?.trim() ? sessionTitle.trim() : 'this chat';
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
  await deleteChatSession(sessionId);
}

function appendRetryButtonToLastAssistantIfPending(): void {
  try {
    const pending = (window as any).__retryAfterRenderForSession as string | undefined;
    if (!pending) return;
    const nodes = Array.from(document.querySelectorAll('#chat-thread .msg.assistant .content')) as HTMLElement[];
    const host = nodes[nodes.length - 1] || null;
    if (!host || host.querySelector('.retry-btn')) return;
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Retry request';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      try {
        const lastUser = [...conversationHistory].slice().reverse().find(ev => ev && ev.type === 'user') as ChatUserEvent | undefined;
        if (lastUser) {
          const newItems: OpenAIResponseItem[] = [{ role: 'user', content: blocksToUserContent(lastUser.content) }];
          startStreamingSession({ sessionId: pending, newItems });
        } else {
          const inputEl = document.getElementById('ai-input') as HTMLTextAreaElement | null;
          if (inputEl) inputEl.focus();
        }
      } catch { }
    });
    host.appendChild(document.createElement('br'));
    host.appendChild(retryBtn);
  } catch { }
  try { delete (window as any).__retryAfterRenderForSession; } catch { }
}

function renderConversationFromHistory(): void {
  chatEl.innerHTML = '';
  currentAssistant = null;
  currentReasoning = null;
  awaitingNewSegment = false;
  if (conversationHistory.length === 0) {
    if (!workingDir) {
      showCta();
    } else {
      // Show friendly greeting for empty chat with workspace
      const greetingEl = document.createElement('div');
      greetingEl.className = 'chat-greeting';
      greetingEl.id = 'chat-greeting-message';
      greetingEl.textContent = 'What are we building today?';
      chatEl.appendChild(greetingEl);
    }
    return;
  }

  // Remove greeting if it exists (user has sent a message)
  const existingGreeting = document.getElementById('chat-greeting-message');
  if (existingGreeting) {
    existingGreeting.remove();
  }

  const activeSession = getActiveSession();
  const anchoredChanges = activeSession?.workspaceChanges;
  const anchoredIndex =
    anchoredChanges && typeof anchoredChanges.anchorAssistantMessageIndex === 'number'
      ? Math.max(0, Math.floor(anchoredChanges.anchorAssistantMessageIndex))
      : null;
  let assistantMessageIndex = 0;
  let anchoredRendered = false;

  const renderToolMessage = (title: string, body: string, opts?: { collapsible?: boolean; summaryLabel?: string; defaultOpen?: boolean }) => {
    const el = document.createElement('div');
    el.className = 'msg tool';
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = title;
    const content = document.createElement('div');
    content.className = 'content';
    const text = body ?? '';
    if (opts?.collapsible && text) {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview';
      const details = document.createElement('details');
      details.open = Boolean(opts?.defaultOpen);
      const summary = document.createElement('summary');
      summary.textContent = opts.summaryLabel || 'View output';
      details.appendChild(summary);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = text;
      pre.appendChild(code);
      details.appendChild(pre);
      wrapper.appendChild(details);
      content.appendChild(wrapper);
    } else {
      content.textContent = text;
    }
    el.append(role, content);
    chatEl.appendChild(el);
    repositionAssistantWorkingIndicator();
  };
  const toolNamesByCallId = new Map<string, string>();
  const historyToolEls = new Map<string, { el: HTMLElement; roleEl: HTMLElement; contentEl: HTMLElement; filePath?: string }>();
  const historyTodoToolNames = new Set(['add_todo_tool', 'update_todo_item_tool', 'update_todo_status_tool', 'clear_todos_tool', 'list_todos_tool']);
  const historySilentResultTools = new Set([
    'terminal_input',
    'read_terminal',
    'summarize_terminal_output',
    'create_terminal',
    'close_terminal',
    'detect_dev_server',
    'preview_file',
    'refresh_preview_tab',
    'set_preview_url',
    'screenshot_preview',
    'visit_url',
  ]);
  const historyPrettyName = (name?: string): string => {
    switch (name) {
      case 'read_file': return 'Reading File';
      case 'grep_search': return 'Grep Search';
      case 'create_file': return 'Create File';
      case 'create_diff': return 'Diff';
      case 'terminal_input': return 'Terminal Input';
      case 'read_terminal': return 'Read Terminal';
      case 'summarize_terminal_output': return 'Summarize Terminal Output';
      case 'create_terminal': return 'Create Terminal';
      case 'close_terminal': return 'Close Terminal';
      case 'detect_dev_server': return 'Detect Dev Server';
      case 'generate_image_tool': return 'Generate Image';
      default: return name ? `Tool: ${name}` : 'Tool';
    }
  };
  const renderHistoryToolRow = (callId: string, toolName: string, detail?: string, filePath?: string): { el: HTMLElement; roleEl: HTMLElement; contentEl: HTMLElement } => {
    const el = document.createElement('div');
    el.className = `msg tool tool-${toolName}`;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = historyPrettyName(toolName);
    const content = document.createElement('div');
    content.className = 'content';
    if (filePath) {
      const a = document.createElement('span');
      a.className = 'file-link';
      a.textContent = formatScopedPathForDisplay(filePath);
      a.title = filePath;
      a.addEventListener('click', () => { try { window.viewer.openPath(filePath); } catch { } });
      content.appendChild(a);
    } else if (detail) {
      content.textContent = detail;
    }
    el.append(role, content);
    chatEl.appendChild(el);
    repositionAssistantWorkingIndicator();
    const rec = { el, roleEl: role, contentEl: content, filePath };
    if (callId) historyToolEls.set(callId, rec);
    return rec;
  };
  const parseToolResultData = (output: string): any => {
    const trimmed = String(output || '').trim();
    if (!trimmed) return null;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { return null; }
    }
    return null;
  };
  const renderGenerateImageFromHistory = (args: any, callId: string): void => {
    const el = document.createElement('div');
    el.className = 'msg tool tool-generate_image_tool';
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = 'Generate Image';
    const content = document.createElement('div');
    content.className = 'content';

    const outputPath = typeof args?.outputPath === 'string' ? args.outputPath.trim() : '';
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
    const resolution = typeof args?.size === 'string' && args.size.trim() ? String(args.size) : 'auto';
    const quality = typeof args?.quality === 'string' && args.quality.trim() ? String(args.quality) : 'high';

    const meta = document.createElement('div');
    meta.className = 'tool-image-meta';
    if (outputPath) {
      const pathEl = document.createElement('span');
      pathEl.className = 'file-link tool-image-path';
      pathEl.textContent = formatScopedPathForDisplay(outputPath);
      pathEl.title = outputPath;
      pathEl.addEventListener('click', () => { try { (window as any).files?.openExternal?.({ path: outputPath }); } catch { } });
      meta.appendChild(pathEl);
    }
    const jsonPayload = { prompt, resolution, quality };
    const jsonEl = document.createElement('pre');
    jsonEl.className = 'tool-image-json';
    jsonEl.textContent = JSON.stringify(jsonPayload, null, 2).replace(/\s*\n\s*/g, ' ');
    meta.appendChild(jsonEl);
    content.appendChild(meta);

    if (outputPath) {
      (window as any).viewer?.readFileBase64?.({ path: outputPath })
        ?.then((res: any) => {
          if (!res?.ok || !res?.base64 || !res?.mime || !String(res.mime).startsWith('image/')) return;
          const imgWrap = document.createElement('div');
          imgWrap.className = 'tool-image-preview';
          const img = document.createElement('img');
          img.src = `data:${res.mime};base64,${res.base64}`;
          img.alt = 'generated image';
          img.addEventListener('click', () => { try { (window as any).files?.openExternal?.({ path: outputPath }); } catch { } });
          imgWrap.appendChild(img);
          content.appendChild(imgWrap);
          repositionAssistantWorkingIndicator();
        })
        ?.catch?.(() => { });
    }

    el.append(role, content);
    chatEl.appendChild(el);
    repositionAssistantWorkingIndicator();
  };

  for (const event of conversationHistory) {
    if (!event) continue;
    if (event.type === 'user') {
      const text = userTextFromBlocks(event.content);
      const attachments = imagesFromBlocks(event.content);
      const displayText = text || (attachments.length ? '(attached images)' : '');
      const contentEl = addMessage('user', displayText);
      if (attachments.length) {
        renderAttachmentChips(contentEl, attachments);
      }
      continue;
    }
    if (event.type === 'message') {
      const host = addMessage('assistant', event.content || '');
      if (!anchoredRendered && anchoredIndex != null && assistantMessageIndex === anchoredIndex && anchoredChanges && activeSession) {
        renderWorkspaceChangesPanel(host, anchoredChanges, { sessionId: activeSession.id });
        anchoredRendered = true;
      }
      assistantMessageIndex += 1;
      continue;
    }
    if (event.type === 'reasoning') {
      const reasoningEl = addReasoningMessage();
      const parsed = parseReasoningContent(event.content);
      reasoningEl.summaryEl.textContent = parsed.title || 'Reasoning';
      reasoningEl.tracePre.textContent = parsed.detail;
      reasoningEl.summaryText = (event.content || '').trim();
      reasoningEl.summaryTitle = parsed.title;
      reasoningEl.summaryRest = parsed.detail;
      reasoningEl.traceAccum = parsed.detail;
      reasoningEl.sawText = Boolean(parsed.detail);
      reasoningEl.completed = true;
      continue;
    }
    if (event.type === 'tool_call') {
      const toolName = event.content?.tool_name || '';
      const args = event.content?.args ?? {};
      const callId = event.content?.call_id || '';
      if (callId) toolNamesByCallId.set(callId, toolName);
      if (toolName === 'generate_image_tool' && callId) {
        renderGenerateImageFromHistory(args, callId);
        continue;
      }

      if (historyTodoToolNames.has(toolName)) {
        continue;
      }
      let detail = '';
      let fileForOpen: string | undefined;
      switch (toolName) {
        case 'read_file': detail = args?.filePath ? `${formatScopedPathForDisplay(args.filePath)}` : ''; fileForOpen = args?.filePath; break;
        case 'grep_search': detail = [args?.pattern ? `pattern: ${args.pattern}` : '', args?.files ? `files: ${formatScopedPathForDisplay(args.files)}` : ''].filter(Boolean).join(' | '); break;
        case 'terminal_input': {
          const cmd = String(args?.text ?? '');
          const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
          const trimmed = cmd.trim();
          detail = trimmed ? `[${terminal}] ${trimmed}` : `[${terminal}]`;
          break;
        }
        case 'read_terminal': {
          const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
          const modeHint = typeof args?.bytes === 'number' ? `${args.bytes} bytes` : typeof args?.lines === 'number' ? `${args.lines} lines` : '';
          detail = `[${terminal}] ${modeHint}`.trim();
          break;
        }
        case 'summarize_terminal_output': {
          const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
          const modeHint = typeof args?.bytes === 'number' ? `${args.bytes} bytes` : typeof args?.lines === 'number' ? `${args.lines} lines` : '';
          const prompt = args?.prompt ? String(args.prompt).trim() : '';
          const promptShort = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
          detail = [`[${terminal}]`, modeHint, promptShort].filter(Boolean).join(' ').trim();
          break;
        }
        case 'create_terminal': {
          const terminalCwd = args?.cwd ? formatScopedPathForDisplay(String(args.cwd)) : ''; const dims = [] as string[];
          const colsVal = Number(args?.cols);
          const rowsVal = Number(args?.rows);
          if (Number.isFinite(colsVal) && colsVal > 0) dims.push(`${colsVal} cols`);
          if (Number.isFinite(rowsVal) && rowsVal > 0) dims.push(`${rowsVal} rows`);
          const parts = [terminalCwd ? `cwd: ${terminalCwd}` : '', dims.length ? dims.join(', ') : ''].filter(Boolean);
          detail = parts.join(' | ');
          break;
        }
        case 'close_terminal': {
          const terminal = args?.terminal_id ? String(args.terminal_id) : '';
          detail = terminal ? `[${terminal}]` : '';
          break;
        }
        case 'detect_dev_server': {
          const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
          const bytesVal = Number(args?.bytes);
          const bytesHint = Number.isFinite(bytesVal) && bytesVal > 0 ? `${bytesVal} bytes` : '';
          detail = `[${terminal}] ${bytesHint}`.trim();
          break;
        }
        case 'create_file': detail = args?.filePath ? formatScopedPathForDisplay(String(args.filePath)) : ''; fileForOpen = args?.filePath; break;
        case 'create_diff': detail = args?.filePath ? formatScopedPathForDisplay(String(args.filePath)) : ''; fileForOpen = args?.filePath; break;
        default: {
          try { detail = JSON.stringify(args, null, 0); } catch { detail = String(args ?? ''); }
        }
      }
      if (callId) {
        renderHistoryToolRow(callId, toolName, detail, fileForOpen);
      } else {
        const argsString = (() => {
          try { return JSON.stringify(args, null, 2); }
          catch { return String(args); }
        })();
        renderToolMessage(`Tool call: ${toolName}`, argsString, { collapsible: Boolean(argsString), summaryLabel: 'Show call' });
      }
      continue;
    }
    if (event.type === 'tool_result') {
      const callId = event.content?.call_id || '';
      if (callId && toolNamesByCallId.get(callId) === 'generate_image_tool') {
        continue;
      }
      const toolName = callId ? toolNamesByCallId.get(callId) || '' : '';
      const outputText = event.content?.output || '';
      const data = parseToolResultData(outputText);
      const rec = callId ? historyToolEls.get(callId) : undefined;
      if (toolName && historyTodoToolNames.has(toolName)) {
        try { todoPanel.updateFromTool(toolName, data, typeof outputText === 'string' ? outputText : undefined); } catch { }
        continue;
      }
      if (toolName && historySilentResultTools.has(toolName)) {
        continue;
      }
      if (rec && toolName) {
        let text: string | undefined;
        let diffPreview: { filePath: string; oldText: string; newText: string } | null = null;
        if (toolName === 'read_file') {
          text = data?.content;
          if (data?.path) rec.filePath = data.path;
        } else if (toolName === 'grep_search') {
          text = data?.stdout;
        } else if (toolName === 'create_file') {
          text = data?.content;
          if (data?.path) rec.filePath = data.path;
        } else if (toolName === 'create_diff') {
          const p = data?.preview;
          if (p && typeof p === 'object') {
            const oldT = typeof p.oldText === 'string' ? p.oldText : '';
            const newT = typeof p.newText === 'string' ? p.newText : '';
            diffPreview = { filePath: String(data?.path || rec?.filePath || ''), oldText: oldT, newText: newT };
          }
          if (data?.path) rec.filePath = data.path;
        }
        const hasTextPreview = typeof text === 'string' && text.trim();
        const hasDiffPreview = toolName === 'create_diff' && diffPreview;
        if (hasTextPreview || hasDiffPreview) {
          const wrapper = document.createElement('div'); wrapper.className = 'preview';
          const details = document.createElement('details');
          const isFileModifyTool = toolName === 'create_diff' || toolName === 'create_file';
          if (isFileModifyTool) details.open = true;
          const summary = document.createElement('summary');
          const pre = document.createElement('pre');
          const codeEl = document.createElement('code');
          const ext = (rec?.filePath || '').split('.').pop()?.toLowerCase();
          let lang = ext === 'htm' ? 'xml' : (ext || '');
          const isDiffPreview = toolName === 'create_diff';
          const MAX_PREVIEW_LINES = 100;
          const langLabel = isDiffPreview ? 'diff' : (lang || 'text');

          if (isDiffPreview && diffPreview) {
            const oldLines = diffPreview.oldText.replace(/\r\n/g, '\n').split('\n');
            const newLines = diffPreview.newText.replace(/\r\n/g, '\n').split('\n');
            const fullDiff = generateUnifiedDiff(oldLines, newLines);
            const meaningfulDiff = filterDiffContext(fullDiff, 3);
            const lineCount = meaningfulDiff.length;
            const isTruncated = lineCount > MAX_PREVIEW_LINES;
            const displayDiff = isTruncated ? meaningfulDiff.slice(0, MAX_PREVIEW_LINES) : meaningfulDiff;
            const truncatedHint = isTruncated ? ` (first ${MAX_PREVIEW_LINES} shown)` : '';
            summary.textContent = `Preview · DIFF · ${lineCount} lines${truncatedHint}`;
            details.appendChild(summary);
            renderUnifiedDiffIntoCode(codeEl, rec?.filePath || diffPreview.filePath || '', displayDiff);
            pre.appendChild(codeEl);
            if (isTruncated) {
              const showAllBtn = document.createElement('button');
              showAllBtn.className = 'preview-show-all';
              showAllBtn.textContent = `Show all ${lineCount} lines`;
              showAllBtn.addEventListener('click', () => {
                renderUnifiedDiffIntoCode(codeEl, rec?.filePath || diffPreview.filePath || '', meaningfulDiff);
                showAllBtn.remove();
                summary.textContent = `Preview · DIFF · ${lineCount} lines`;
              });
              pre.appendChild(showAllBtn);
            }
          } else {
            const fullText = typeof text === 'string' ? text : '';
            const allLines = fullText.split('\n');
            const lineCount = allLines.length;
            const isTruncated = lineCount > MAX_PREVIEW_LINES;
            const displayText = isTruncated ? allLines.slice(0, MAX_PREVIEW_LINES).join('\n') : fullText;
            const truncatedHint = isTruncated ? ` (first ${MAX_PREVIEW_LINES} shown)` : '';
            summary.textContent = `Preview · ${langLabel.toUpperCase()} · ${lineCount} line${lineCount !== 1 ? 's' : ''}${truncatedHint}`;
            details.appendChild(summary);
            codeEl.removeAttribute('data-diff');
            try {
              if (lang && hljs.getLanguage(lang)) {
                codeEl.innerHTML = hljs.highlight(displayText, { language: lang }).value;
              } else {
                codeEl.innerHTML = hljs.highlightAuto(displayText).value;
              }
            } catch { codeEl.textContent = displayText; }
            pre.appendChild(codeEl);
            if (isTruncated) {
              const showAllBtn = document.createElement('button');
              showAllBtn.className = 'preview-show-all';
              showAllBtn.textContent = `Show all ${lineCount} lines`;
              showAllBtn.addEventListener('click', () => {
                try {
                  if (lang && hljs.getLanguage(lang)) {
                    codeEl.innerHTML = hljs.highlight(fullText, { language: lang }).value;
                  } else {
                    codeEl.innerHTML = hljs.highlightAuto(fullText).value;
                  }
                } catch { codeEl.textContent = fullText; }
                showAllBtn.remove();
                summary.textContent = `Preview · ${langLabel.toUpperCase()} · ${lineCount} line${lineCount !== 1 ? 's' : ''}`;
              });
              pre.appendChild(showAllBtn);
            }
          }
          details.appendChild(pre);
          wrapper.appendChild(details);
          rec.contentEl.appendChild(wrapper);
        }
        if (rec?.filePath) {
          rec.contentEl.addEventListener('dblclick', () => { try { window.viewer.openPath(rec.filePath!); } catch { } });
        }
      } else {
        renderToolMessage('Tool result', outputText, { collapsible: true, summaryLabel: 'Show result' });
      }
      continue;
    }
  }
  // If the anchored message isn't available (e.g., history truncated), avoid
  // reattaching to the last message; that was causing duplicate/misplaced panels.
  scrollToBottom();
}

function sortSessionsByRecency(): void {
  chatSessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function syncSessionFromStore(sessionId: string, opts: { reRender?: boolean } = {}): Promise<void> {
  if (!sessionId) return;
  try {
    const res = await window.ai.sessions.get(sessionId);
    if (!res || !res.ok || !res.session) return;
    const normalized = normalizeStoredSession(res.session);
    if (!normalized) return;
    const idx = chatSessions.findIndex(s => s.id === normalized.id);
    const incomingHistory = cloneHistory(normalized.history);
    const isActive = activeChatId === sessionId;
    const localHistoryLength = isActive ? conversationRaw.length : 0;
    const incomingHistoryLength = incomingHistory.length;
    const shouldApplyIncomingHistory = !isActive || incomingHistoryLength >= localHistoryLength;

    if (idx >= 0) {
      const existing = chatSessions[idx];
      const preservedHistory = shouldApplyIncomingHistory
        ? cloneHistory(incomingHistory)
        : cloneHistory(existing?.history ?? conversationRaw);
      chatSessions[idx] = { ...normalized, history: preservedHistory };
    } else {
      const historyToStore = shouldApplyIncomingHistory ? cloneHistory(incomingHistory) : cloneHistory(conversationRaw);
      chatSessions.unshift({ ...normalized, history: historyToStore });
    }

    sortSessionsByRecency();

    if (isActive) {
      const updatedSession = chatSessions.find(s => s.id === sessionId);
      const nextAdditional = updatedSession?.additionalWorkingDir || pendingAdditionalWorkingDir || additionalWorkingDir || null;
      setAdditionalWorkingDirState(nextAdditional, { persist: false });
    }

    if (isActive && shouldApplyIncomingHistory) {
      conversationRaw = cloneHistory(incomingHistory);
      conversationHistory = convertHistoryToChatEvents(conversationRaw, normalized.provider);
      if (opts.reRender !== false) {
        renderConversationFromHistory();
      }
    }
    if (opts.reRender !== false) renderChatHome();
  } catch { }
}

function openChatSession(chatId: string, opts: { focusInput?: boolean; pendingAdditionalWorkingDir?: string | null } = {}): void {
  const session = chatSessions.find(s => s.id === chatId);
  if (!session) return;
  resetActiveRun();
  activeChatId = session.id;
  // Restore additional working directory from session.
  // If this session is newly created and has no stored additional dir yet,
  // allow the pending in-memory value to populate it.
  const desiredAdditional = session.additionalWorkingDir || opts.pendingAdditionalWorkingDir || null;
  setAdditionalWorkingDirState(desiredAdditional, { persist: false });
  alignActiveSessionProviderToModel();
  conversationRaw = cloneHistory(session.history);
  conversationHistory = convertHistoryToChatEvents(conversationRaw, session.provider);
  enforceModelProviderLock();
  syncUiLabels();
  applyModelLockConstraints();
  renderConversationFromHistory();
  setChatView('chat');
  try { (window as any).ai?.sessions?.setActive?.(session.id); } catch { }

  // If we had a pending additional dir (picked before any session existed),
  // persist it onto this newly created session now that we have a sessionId.
  if (!session.additionalWorkingDir && opts.pendingAdditionalWorkingDir) {
    setAdditionalWorkingDirState(opts.pendingAdditionalWorkingDir, { persist: true });
  }
  if (opts.focusInput) {
    const input = document.getElementById('ai-input') as HTMLTextAreaElement | null;
    input?.focus();
  }
  syncSessionFromStore(session.id).catch(() => { });
  resumeActiveRun(session.id, session.runtime?.status).catch(() => { });
}

async function startNewChatSession(): Promise<void> {
  try {
    const res = await window.ai.sessions.create({ model: uiState.model });
    if (!res || !res.ok || !res.session) return;
    const session = normalizeStoredSession(res.session);
    if (!session) return;
    chatSessions.unshift(session);
    sortSessionsByRecency();
    renderChatHome();
    openChatSession(session.id, { focusInput: true, pendingAdditionalWorkingDir });
  } catch { }
}

async function deleteChatSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const res = await window.ai.sessions.delete(sessionId);
    if (!res || !res.ok) {
      const reason = res?.error ? `: ${res.error}` : '';
      showToast(`Failed to delete chat${reason}`, 'error');
      return;
    }

    chatSessions = chatSessions.filter(session => session.id !== sessionId);

    if (activeChatId === sessionId) {
      resetActiveRun();
      activeChatId = null;
      try { (window as any).ai?.sessions?.setActive?.(undefined); } catch { }
      conversationHistory = [];
      conversationRaw = [];
      chatEl.innerHTML = '';
      setChatView('home');
    }

    renderChatHome();
    showToast('Chat deleted.', 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    showToast(`Failed to delete chat${message ? `: ${message}` : ''}`, 'error');
  }
}

async function ensureActiveChat(): Promise<void> {
  if (!activeChatId) {
    await startNewChatSession();
  }
}

async function resumeActiveRun(sessionId: string, hintedStatus?: string): Promise<void> {
  if (!sessionId || !startStreamingSession) return;
  const hinted = typeof hintedStatus === 'string' ? hintedStatus.toLowerCase() : '';
  if (activeChatId !== sessionId) return;
  try {
    const res = await window.ai.session.status(sessionId);
    const statusObj = res?.ok ? res.status : undefined;
    const status = typeof statusObj?.status === 'string' ? statusObj.status.toLowerCase() : '';
    if (status === 'running') {
      startStreamingSession({ sessionId, resume: true });
      return;
    }
  } catch { }
  if (hinted === 'running') {
    syncSessionFromStore(sessionId, { reRender: false }).catch(() => { });
  }
}

function goHome(): void {
  resetActiveRun();
  activeChatId = null;
  conversationHistory = [];
  conversationRaw = [];
  chatEl.innerHTML = '';
  setChatView('home');
  renderChatHome();
  loadChatSessions().then(() => { renderChatHome(); }).catch(() => { });
}

async function setupChatUi(): Promise<void> {
  await loadChatSessions();
  renderChatHome();
  setChatView('home');
  if (btnChatBack && !btnChatBack.dataset.bound) {
    btnChatBack.dataset.bound = 'true';
    btnChatBack.addEventListener('click', () => { goHome(); });
  }
  if (btnNewChat && !btnNewChat.dataset.bound) {
    btnNewChat.dataset.bound = 'true';
    btnNewChat.addEventListener('click', () => { startNewChatSession().catch(() => { }); });
  }

  // Theme toggle button
  if (btnThemeToggle && !btnThemeToggle.dataset.bound) {
    btnThemeToggle.dataset.bound = 'true';
    btnThemeToggle.addEventListener('click', toggleTheme);
  }

  // Apply saved theme on load
  applyTheme(uiState.theme);
}

type ReasoningSummaryParts = { title: string; afterTitle: string };

type ParsedReasoningContent = { title: string; detail: string };

function extractReasoningSummaryParts(raw: string | undefined | null): ReasoningSummaryParts {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { title: '', afterTitle: '' };
  }
  const boldMatch = text.match(/^\*\*(.+?)\*\*(.*)$/s);
  if (boldMatch) {
    return { title: (boldMatch[1] || '').trim(), afterTitle: (boldMatch[2] || '').trim() };
  }
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex !== -1) {
    const title = text.slice(0, newlineIndex).trim();
    const afterTitle = text.slice(newlineIndex + 1).trim();
    return { title, afterTitle };
  }
  return { title: text, afterTitle: '' };
}

function parseReasoningContent(raw: string | undefined | null): ParsedReasoningContent {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { title: 'Reasoning', detail: '' };
  }
  const [summaryPart, ...restParts] = trimmed.split(/\n{2,}/);
  const rest = restParts.join('\n\n').trim();
  const { title, afterTitle } = extractReasoningSummaryParts(summaryPart);
  const pieces = [afterTitle, rest].filter(Boolean);
  return {
    title: title || summaryPart.trim() || 'Reasoning',
    detail: pieces.join('\n\n'),
  };
}

type ReasoningState = {
  root: HTMLElement;
  summaryEl: HTMLElement;
  tracePre: HTMLElement;
  summaryText: string;
  summaryTitle: string;
  summaryRest: string;
  traceAccum: string;
  sawText: boolean;
  completed: boolean;
};

let currentReasoning: ReasoningState | null = null;

function resetActiveRun(): void {
  if (stopCurrent) {
    try { stopCurrent(); } catch { }
  }
  stopCurrent = null;
  streamingSessionId = null;
  currentAssistant = null;
  currentReasoning = null;
  awaitingNewSegment = false;
  setProgress(false);
  setSendButton('send');
  todoPanel.clear();
  try {
    const sessionId = activeChatId;
    if (sessionId && window.todos?.reset) {
      const maybeReset = window.todos.reset(sessionId);
      if (maybeReset && typeof (maybeReset as Promise<unknown>).catch === 'function') {
        (maybeReset as Promise<unknown>).catch(() => { });
      }
    }
  } catch { }
}

function addReasoningMessage(): ReasoningState {
  const el = document.createElement('div');
  el.className = 'msg reasoning';
  const roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = 'Reasoning';
  const content = document.createElement('div');
  content.className = 'content';

  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  summary.className = 'reasoning-summary';
  summary.textContent = 'Reasoning summary';
  const tracePre = document.createElement('pre');
  tracePre.className = 'reasoning-trace';
  details.appendChild(summary);
  details.appendChild(tracePre);

  const previewWrap = document.createElement('div');
  previewWrap.className = 'preview';
  previewWrap.appendChild(details);

  content.appendChild(previewWrap);
  el.appendChild(roleEl);
  el.appendChild(content);
  chatEl.appendChild(el);
  scrollToBottom();
  repositionAssistantWorkingIndicator();

  return {
    root: el,
    summaryEl: summary,
    tracePre,
    summaryText: '',
    summaryTitle: '',
    summaryRest: '',
    traceAccum: '',
    sawText: false,
    completed: false
  };
}
function setProjectOverlayError(message?: string): void {
  if (projectOverlayError) {
    projectOverlayError.textContent = message?.trim() || '';
  }
}

function showProjectOverlay(): void {
  if (!projectOverlay) return;
  projectOverlay.classList.add('active');
  projectOverlay.setAttribute('aria-hidden', 'false');
  setProjectOverlayError('');
  window.setTimeout(() => {
    try { projectOverlayOpenBtn?.focus(); } catch { }
  }, 40);
}

function hideProjectOverlay(): void {
  if (!projectOverlay) return;
  projectOverlay.classList.remove('active');
  projectOverlay.setAttribute('aria-hidden', 'true');
  setProjectOverlayError('');
}

function setupProjectOverlay(): void {
  projectOverlayOpenBtn?.addEventListener('click', () => {
    setProjectOverlayError('');
    void chooseWorkspace();
  });
}

function showCta(): void {
  chatEl.innerHTML = '';
  showProjectOverlay();
}
function setWorkspace(cwd: string, persisted: boolean): void {
  workingDir = typeof cwd === 'string' ? cwd.trim() : '';
  if (workingDir) {
    wsBar.style.display = 'none';
    wsPath.textContent = workingDir;
    if (btnChangeWs) btnChangeWs.title = workingDir;
    if (workspaceBtnLabel) {
      const parts = workingDir.split(/[\\/]/).filter(Boolean);
      const last = parts[parts.length - 1] || workingDir;
      const display = parts.length > 1
        ? `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}`
        : last;
      workspaceBtnLabel.textContent = display || 'Workspace';
    }
    if (!persisted) {
      showCta();
    } else {
      hideProjectOverlay();
    }
  } else {
    wsBar.style.display = 'none';
    if (btnChangeWs) btnChangeWs.title = 'Select workspace';
    if (workspaceBtnLabel) workspaceBtnLabel.textContent = 'Workspace';
    showCta();
  }

  resetActiveRun();
  activeChatId = null;
  conversationHistory = [];
  chatEl.innerHTML = '';
  setChatView('home');
  loadChatSessions().then(() => { renderChatHome(); }).catch(() => { });
}
async function chooseWorkspace(): Promise<void> {
  try {
    const res = await window.workspace.choose();
    if (res?.ok && res.cwd) {
      setWorkspace(res.cwd, true);
      setProjectOverlayError('');
      return;
    }
    const maybeError = (res as { error?: string } | undefined)?.error;
    if (maybeError) {
      setProjectOverlayError(maybeError);
    } else if (!res?.canceled) {
      setProjectOverlayError('Unable to open folder.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to open folder.';
    setProjectOverlayError(message);
  }
}

btnChangeWs?.addEventListener('click', () => { chooseWorkspace(); });

// AI input
function setupAiInput(): void {
  const form = document.getElementById('ai-form') as HTMLFormElement | null;
  const input = document.getElementById('ai-input') as HTMLTextAreaElement | null;
  const attachmentsBar = document.getElementById('ai-attachments') as HTMLDivElement | null;
  if (!form || !input) return;
  // Ensure clean slate for new session boot.
  conversationHistory = [];
  stopCurrent = null;
  currentAssistant = null;
  currentReasoning = null;
  awaitingNewSegment = false;

  const updateAttachmentsUi = (): void => {
    if (!attachmentsBar) return;
    attachmentsBar.innerHTML = '';
    if (!pendingAttachments.length) {
      attachmentsBar.classList.remove('active');
      return;
    }
    attachmentsBar.classList.add('active');

    for (const a of pendingAttachments) {
      const chip = document.createElement('span');
      chip.className = 'ai-attachment';

      if (isImageMime(a.mime) && a.dataUrl) {
        const img = document.createElement('img');
        img.src = a.dataUrl;
        img.alt = a.name || 'image';
        img.onerror = () => {
          img.remove();
          chip.insertBefore(createFileIcon(fileExt(a.name, a.mime)), chip.firstChild || null);
        };
        chip.appendChild(img);
      } else {
        chip.appendChild(createFileIcon(fileExt(a.name, a.mime)));
      }

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = a.name || a.mime || 'file';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        const id = a.id || a.name || a.dataUrl;
        pendingAttachments = pendingAttachments.filter(x => (x.id || x.name || x.dataUrl) !== id);
        updateAttachmentsUi();
      });

      chip.append(name, remove);
      attachmentsBar.appendChild(chip);
    }
  };


  const onPickAttachments = async (): Promise<void> => {
    try {
      const ai = (window as any).ai;
      // Prefer a generic file picker if present, otherwise fall back to images
      const res = ai?.pickFiles ? await ai.pickFiles() : await ai?.pickImages?.();
      if (!res || !res.ok || res.canceled || !Array.isArray(res.files) || res.files.length === 0) return;

      const next: ImageAttachment[] = res.files.map((f: any) => ({
        id: f?.id,
        name: f?.name || fileBaseName(f?.path),
        path: f?.path,
        mime: f?.mime || 'application/octet-stream',
        base64: f?.base64,
        dataUrl: f?.base64 ? `data:${f?.mime || 'application/octet-stream'};base64,${f?.base64}` : '',
      }));

      pendingAttachments = [...pendingAttachments, ...next];
      updateAttachmentsUi();
    } catch { }
  };


  const btnAttach = document.getElementById('btn-add-context') as HTMLButtonElement | null;
  const addContextPopover = document.getElementById('add-context-popover') as HTMLElement | null;
  const btnAddImage = document.getElementById('btn-add-image') as HTMLButtonElement | null;

  const hidePopover = (): void => {
    if (addContextPopover) {
      addContextPopover.hidden = true;
      btnAttach?.setAttribute('aria-expanded', 'false');
    }
  };

  const togglePopover = (): void => {
    if (addContextPopover) {
      const isHidden = addContextPopover.hidden;
      addContextPopover.hidden = !isHidden;
      btnAttach?.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    }
  };

  const onPickDirectory = async (): Promise<void> => {
    try {
      const result = await (window as any).workspace?.pickFolder?.();
      if (result && result.ok && result.path) {
        setAdditionalWorkingDirState(result.path);
      }
    } catch { }
  };

  if (btnAttach && !btnAttach.dataset.bound) {
    btnAttach.dataset.bound = 'true';
    btnAttach.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });
  }

  // Handle popover menu items
  if (addContextPopover && !(addContextPopover as any).dataset?.bound) {
    (addContextPopover as any).dataset.bound = 'true';
    addContextPopover.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.action;
      hidePopover();
      if (action === 'attach-images') {
        onPickAttachments();
      } else if (action === 'add-directory') {
        onPickDirectory();
      }
    });
  }

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    if (addContextPopover && !addContextPopover.hidden) {
      const target = e.target as HTMLElement;
      if (!target.closest('.add-context-wrap')) {
        hidePopover();
      }
    }
  });

  if (btnAddImage && !btnAddImage.dataset.bound) {
    btnAddImage.dataset.bound = 'true';
    btnAddImage.addEventListener('click', () => { onPickAttachments(); });
  }

  const mentionMenu = document.getElementById('ai-mention-menu') as HTMLDivElement | null;
  const mentionList = mentionMenu?.querySelector('.mention-list') as HTMLDivElement | null;
  const mentionEmpty = mentionMenu?.querySelector('.mention-empty') as HTMLDivElement | null;

  type MentionItem = { path: string; type: 'file' | 'dir' };
  type MentionContext = { start: number; cursor: number; query: string };

  let mentionItems: MentionItem[] = [];
  let mentionIndex = 0;
  let mentionContext: MentionContext | null = null;
  let mentionRequestId = 0;
  let mentionUpdateTimer: number | null = null;

  const isMentionOpen = () => !!mentionMenu && !mentionMenu.hidden;

  const hideMentionMenu = () => {
    if (!mentionMenu) return;
    mentionMenu.hidden = true;
    mentionItems = [];
    mentionIndex = 0;
    mentionContext = null;
  };

  const setMentionActiveIndex = (nextIndex: number) => {
    if (!mentionList || mentionItems.length === 0) return;
    mentionIndex = Math.max(0, Math.min(nextIndex, mentionItems.length - 1));
    const nodes = mentionList.querySelectorAll<HTMLButtonElement>('.mention-item');
    nodes.forEach((node, idx) => {
      const active = idx === mentionIndex;
      node.classList.toggle('active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  const findMentionContext = (): MentionContext | null => {
    const cursor = input.selectionStart ?? input.value.length;
    if (cursor <= 0) return null;
    const before = input.value.slice(0, cursor);
    const atIndex = before.lastIndexOf('@');
    if (atIndex < 0) return null;
    const prev = atIndex > 0 ? before[atIndex - 1] : '';
    if (prev && !isMentionBoundaryChar(prev)) return null;
    const query = before.slice(atIndex + 1);
    if (!query || /\s/.test(query)) {
      if (query === '') {
        return { start: atIndex, cursor, query: '' };
      }
      return null;
    }
    return { start: atIndex, cursor, query };
  };

  const fetchMentionItems = async (ctx: MentionContext): Promise<MentionItem[]> => {
    if (!workingDir) return [];
    const normalized = ctx.query.replace(/^\/+/, '');
    const lastSlash = normalized.lastIndexOf('/');
    const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '.';
    const prefix = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    const res = await (window as any).files?.list?.({ dir: dir || '.' });
    if (!res?.ok || !Array.isArray(res.entries)) return [];
    const base = res.path && res.path !== '.' ? String(res.path) : '';
    const prefixLower = prefix.toLowerCase();
    const filtered = res.entries
      .filter((entry: any) => entry?.name && (prefixLower ? String(entry.name).toLowerCase().startsWith(prefixLower) : true))
      .sort((a: any, b: any) => {
        if (a.type === b.type) return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
        return a.type === 'dir' ? -1 : 1;
      })
      .slice(0, 12);
    return filtered.map((entry: any) => {
      const name = String(entry.name || '');
      const path = base ? `${base}/${name}` : name;
      return { path, type: entry.type === 'dir' ? 'dir' : 'file' };
    });
  };

  const renderMentionMenu = () => {
    if (!mentionMenu || !mentionList || !mentionEmpty) return;
    mentionList.textContent = '';
    if (mentionItems.length === 0) {
      mentionEmpty.hidden = false;
    } else {
      mentionEmpty.hidden = true;
      mentionItems.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mention-item';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', idx === mentionIndex ? 'true' : 'false');
        btn.dataset.index = String(idx);

        const icon = document.createElement('span');
        icon.className = 'mention-icon';
        icon.textContent = item.type === 'dir' ? 'D' : 'F';

        const path = document.createElement('span');
        path.className = 'mention-path';
        path.textContent = item.type === 'dir' ? `${item.path}/` : item.path;

        const kind = document.createElement('span');
        kind.className = 'mention-kind';
        kind.textContent = item.type === 'dir' ? 'Folder' : 'File';

        btn.append(icon, path, kind);

        if (idx === mentionIndex) btn.classList.add('active');

        btn.addEventListener('mouseenter', () => setMentionActiveIndex(idx));
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyMentionSelection(item);
        });

        mentionList.appendChild(btn);
      });
    }
    mentionMenu.hidden = false;
  };

  const updateMentionMenu = async () => {
    if (!mentionMenu || !mentionList || !mentionEmpty) return;
    const ctx = findMentionContext();
    if (!ctx || !workingDir) {
      hideMentionMenu();
      return;
    }
    const requestId = ++mentionRequestId;
    const items = await fetchMentionItems(ctx);
    if (requestId !== mentionRequestId) return;
    mentionContext = ctx;
    mentionItems = items;
    mentionIndex = 0;
    renderMentionMenu();
  };

  const scheduleMentionUpdate = () => {
    if (mentionUpdateTimer) window.clearTimeout(mentionUpdateTimer);
    mentionUpdateTimer = window.setTimeout(() => {
      mentionUpdateTimer = null;
      void updateMentionMenu();
    }, 80);
  };

  const applyMentionSelection = (item: MentionItem) => {
    if (!mentionContext) return;
    const value = input.value || '';
    const before = value.slice(0, mentionContext.start);
    const after = value.slice(mentionContext.cursor);
    const suffix = item.type === 'dir' ? '/' : (after.startsWith(' ') ? '' : ' ');
    const nextValue = `${before}@${item.path}${suffix}${after}`;
    const nextCursor = before.length + 1 + item.path.length + suffix.length;
    input.value = nextValue;
    try { input.setSelectionRange(nextCursor, nextCursor); } catch { }
    autoSize();
    if (item.type === 'dir') {
      scheduleMentionUpdate();
    } else {
      hideMentionMenu();
    }
    input.focus();
  };

  const handleMentionKey = (e: KeyboardEvent): boolean => {
    if (!isMentionOpen()) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      hideMentionMenu();
      return true;
    }
    if (mentionItems.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMentionActiveIndex(mentionIndex + 1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionActiveIndex(mentionIndex - 1);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = mentionItems[mentionIndex];
      if (item) applyMentionSelection(item);
      return true;
    }
    return false;
  };

  document.addEventListener('click', (e) => {
    if (!mentionMenu || mentionMenu.hidden) return;
    const target = e.target as HTMLElement;
    if (target === input || mentionMenu.contains(target)) return;
    hideMentionMenu();
  });

  const startStreamingSessionImpl = async (opts: StartStreamingSessionOptions): Promise<void> => {
    try {
      const sessionId = typeof opts?.sessionId === 'string' ? opts.sessionId : '';
      if (!sessionId || sessionId !== activeChatId) return;
      const resume = opts?.resume === true;
      if (resume && streamingSessionId === sessionId && stopCurrent) return;
      const messageBatch = resume ? [] : (Array.isArray(opts?.newItems) ? opts.newItems : []);
      if (!resume && messageBatch.length === 0) return;
      if (!resume && stopCurrent && streamingSessionId === sessionId) {
        try { stopCurrent(); } catch { }
      }

    const existingRunToken = sessionRunTokens.get(sessionId) || null;
    const runToken = resume ? existingRunToken : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!resume && runToken) {
      sessionRunTokens.set(sessionId, runToken);
    }
    const clearRunToken = () => {
      if (runToken && sessionRunTokens.get(sessionId) === runToken) {
        sessionRunTokens.delete(sessionId);
      }
    };

    let historyDirty = false;
    let currentAssistantEventIndex: number | null = null;
    let currentReasoningEventIndex: number | null = null;
	    let currentAssistantRawIndex: number | null = null;
	    let currentReasoningRawIndex: number | null = null;
	    const pendingToolCallsRaw = new Map<string, { name: string; args: string }>();
	    let preChangesFingerprint: string | null = null;

    const markDirty = () => { historyDirty = true; };

    const flushHistory = (opts: { updateTimestamp?: boolean } = {}) => {
      if (!historyDirty) return;
      persistActiveChat({
        updateTimestamp: opts.updateTimestamp !== false,
        skipRender: false,
        skipSort: false,
      });
      historyDirty = false;
    };

    const finalizeCurrent = () => {
      if (!currentAssistant) return;
      const txt = getAssistantMessageContent(currentAssistant);
      if (currentAssistantEventIndex == null) {
        const event: ChatMessageEvent = { type: 'message', content: txt, timestamp: Date.now() };
        currentAssistantEventIndex = appendEventToActiveChat(event);
      } else {
        const event = conversationHistory[currentAssistantEventIndex] as ChatMessageEvent | undefined;
        if (event) event.content = txt;
      }
      if (currentAssistantRawIndex != null) {
        const rawItem = conversationRaw[currentAssistantRawIndex];
        if (rawItem) {
          rawItem.content = [{ type: 'output_text', text: txt }];
        }
      }
      markDirty();
      currentAssistant = null;
      currentAssistantEventIndex = null;
      currentAssistantRawIndex = null;
    };
    const startAssistantMessage = () => {
      console.log('[Renderer] startAssistantMessage called');
      finalizeCurrent();
      const event: ChatMessageEvent = { type: 'message', content: '', timestamp: Date.now() };
      currentAssistantEventIndex = appendEventToActiveChat(event);
      const rawItem: OpenAIResponseItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '' }],
      };
      currentAssistantRawIndex = conversationRaw.push(rawItem) - 1;
      currentAssistant = addMessage('assistant', '');
      console.log('[Renderer] startAssistantMessage finished:', {
        hasCurrentAssistant: !!currentAssistant,
        currentAssistantTag: currentAssistant?.tagName,
      });
      awaitingNewSegment = false;
      scrollToBottom();
      markDirty();
    };
    const ensureAssistant = () => {
      console.log('[Renderer] ensureAssistant:', { awaitingNewSegment, hasCurrentAssistant: !!currentAssistant });
      if (awaitingNewSegment || !currentAssistant) startAssistantMessage();
    };

    // Don't create assistant message at startup - let it be created by first onToken or onReasoningEvent
    // This ensures proper ordering: if reasoning comes first, it will be rendered before assistant message
    repositionAssistantWorkingIndicator();

    const startReasoningMessage = (): ReasoningState => {
      const state = addReasoningMessage();
      currentReasoning = state;
      const event: ChatReasoningEvent = { type: 'reasoning', content: '', timestamp: Date.now() };
      currentReasoningEventIndex = appendEventToActiveChat(event);
      const rawItem: OpenAIResponseItem = { type: 'reasoning', content: '' };
      currentReasoningRawIndex = conversationRaw.push(rawItem) - 1;
      markDirty();
      return state;
    };
    const ensureReasoning = (forceReuse = false): ReasoningState => {
      if (!currentReasoning || (!forceReuse && currentReasoning.completed)) {
        return startReasoningMessage();
      }
      if (currentReasoningEventIndex == null) {
        const event: ChatReasoningEvent = { type: 'reasoning', content: '', timestamp: Date.now() };
        currentReasoningEventIndex = appendEventToActiveChat(event);
      }
      return currentReasoning;
    };
    const resetReasoning = (): ReasoningState => {
      const rn = startReasoningMessage();
      rn.summaryText = '';
      rn.summaryTitle = '';
      rn.summaryRest = '';
      rn.traceAccum = '';
      rn.sawText = false;
      rn.completed = false;
      rn.summaryEl.textContent = 'Reasoning...';
      rn.tracePre.textContent = '';
      if (currentReasoningEventIndex != null) {
        const event = conversationHistory[currentReasoningEventIndex] as ChatReasoningEvent | undefined;
        if (event) {
          event.content = '';
          event.encrypted_reasoning = undefined;
        }
      }
      if (currentReasoningRawIndex != null) {
        const rawItem = conversationRaw[currentReasoningRawIndex];
        if (rawItem && rawItem.type === 'reasoning') {
          rawItem.content = '';
          rawItem.summary = undefined;
          rawItem.encrypted_content = undefined;
        }
      }
      return rn;
    };
    const renderTrace = (rn: ReasoningState) => {
      const parts: string[] = [];
      if (rn.summaryRest) parts.push(rn.summaryRest);
      if (rn.traceAccum) parts.push(rn.traceAccum);
      const combined = parts.join(parts.length > 1 ? '\n\n' : '');
      rn.tracePre.textContent = combined;
      if (currentReasoningEventIndex != null) {
        const event = conversationHistory[currentReasoningEventIndex] as ChatReasoningEvent | undefined;
        if (event) {
          const summary = rn.summaryText ? rn.summaryText.trim() : '';
          const trail = combined ? combined.trim() : '';
          event.content = [summary, trail].filter(Boolean).join('\n\n');
          if (currentReasoningRawIndex != null) {
            const rawItem = conversationRaw[currentReasoningRawIndex];
            if (rawItem && rawItem.type === 'reasoning') {
              rawItem.content = event.content;
            }
          }
        }
        markDirty();
      }
    };
    const applySummaryText = (rn: ReasoningState, text: string) => {
      rn.summaryText = text;
      const trimmed = text.trim();
      const { title, afterTitle } = extractReasoningSummaryParts(trimmed);
      rn.summaryTitle = title || trimmed;
      rn.summaryRest = afterTitle;
      if (title) {
        rn.summaryEl.textContent = title;
      } else if (trimmed) {
        rn.summaryEl.textContent = trimmed;
      } else {
        rn.summaryEl.textContent = 'Reasoning...';
      }
      if (currentReasoningRawIndex != null) {
        const rawItem = conversationRaw[currentReasoningRawIndex];
        if (rawItem && rawItem.type === 'reasoning') {
          rawItem.summary = title ? [{ type: 'summary_text', text: title }] : undefined;
          rawItem.content = trimmed || rawItem.content || '';
        }
      }
      renderTrace(rn);
    };
    const onToken = (t: string) => {
      try { (window as any).electronAPI?.log(`[Renderer] onToken: len=${t?.length}`); } catch { }
      console.log('[Renderer] onToken called:', {
        tokenLength: t?.length,
        tokenPreview: t?.substring(0, 100),
        hasCurrentAssistant: !!currentAssistant,
        awaitingNewSegment,
      });
      ensureAssistant();
      console.log('[Renderer] After ensureAssistant:', {
        hasCurrentAssistant: !!currentAssistant,
        currentAssistantTag: currentAssistant?.tagName,
      });
      if (!currentAssistant) {
        console.warn('[Renderer] ⚠️  currentAssistant is null after ensureAssistant!');
        return;
      }
      appendAssistantMessageContent(currentAssistant, t);
      const updated = getAssistantMessageContent(currentAssistant);
      console.log('[Renderer] After appendAssistantMessageContent:', {
        updatedLength: updated?.length,
        updatedPreview: updated?.substring(0, 100),
      });
      if (currentAssistantEventIndex == null) {
        const event: ChatMessageEvent = { type: 'message', content: updated, timestamp: Date.now() };
        currentAssistantEventIndex = appendEventToActiveChat(event);
      } else {
        const event = conversationHistory[currentAssistantEventIndex] as ChatMessageEvent | undefined;
        if (event) event.content = updated;
      }
      if (currentAssistantRawIndex != null) {
        const rawItem = conversationRaw[currentAssistantRawIndex];
        if (rawItem && rawItem.type === 'message') {
          let parts = Array.isArray(rawItem.content) ? rawItem.content : [];
          let textPart = parts.find(part => part?.type === 'output_text') as { type: 'output_text'; text: string } | undefined;
          if (!textPart) {
            textPart = { type: 'output_text', text: '' };
            parts = [...parts, textPart];
            rawItem.content = parts;
          }
          textPart.text = updated;
        }
      }
      markDirty();
      scrollToBottom();
      setProgress(true, 'Responding…');
    };
	    const onDone = () => {
	      const completedAssistantEl = currentAssistant;
	      finalizeCurrent();
	      awaitingNewSegment = false;
	      scrollToBottom();
	      setSendButton('send');
	      clearRunToken();
	      stopCurrent = null;
	      streamingSessionId = null;
	      flushHistory();
	      setProgress(false);
	      const host = completedAssistantEl || findLastAssistantContentEl();
	      if (host) {
		        void (async () => {
		          try {
			            const postSummary: WorkspaceChangesResponse = await (window as any).workspace?.changes?.({ sessionId, runId: runToken, limit: 0, offset: 0 });
		            if (!postSummary?.ok) {
		              if (postSummary && typeof postSummary.error === 'string' && postSummary.error.trim()) {
		                showToast(postSummary.error.trim(), 'error');
		              }
		              return;
		            }
		
		            const postFingerprint = typeof postSummary.fingerprint === 'string' && postSummary.fingerprint
		              ? postSummary.fingerprint
		              : fingerprintWorkspaceChangesFiles(postSummary.files);
		            const changed = preChangesFingerprint == null ? postFingerprint !== '' : postFingerprint !== preChangesFingerprint;
		            if (!changed) return;

		            const totals = postSummary.totals || { files: 0, additions: 0, deletions: 0 };
		            if (!totals.files) {
		              if (sessionId) await setSessionWorkspaceChanges(sessionId, undefined);
		              try {
		                const panels = Array.from(document.querySelectorAll('.workspace-changes'));
		                for (const el of panels) el.remove();
		              } catch { }
		              return;
		            }

			            const postPage: WorkspaceChangesResponse = await (window as any).workspace?.changes?.({ sessionId, runId: runToken, limit: DEFAULT_CHANGES_PAGE_LIMIT, offset: 0 });
		            if (!postPage?.ok) return;
		
		            const assistantCount = conversationHistory.filter(ev => ev && ev.type === 'message').length;
		            const anchorAssistantMessageIndex = Math.max(0, assistantCount - 1);
		            const snapshot = snapshotFromWorkspaceChangesResponse(postPage, { runId: runToken ?? undefined, anchorAssistantMessageIndex });
		            if (!snapshot) {
		              if (sessionId) await setSessionWorkspaceChanges(sessionId, undefined);
		              try {
		                const panels = Array.from(document.querySelectorAll('.workspace-changes'));
		                for (const el of panels) el.remove();
		              } catch { }
		              return;
		            }
		            if (sessionId) await setSessionWorkspaceChanges(sessionId, snapshot);
		            renderWorkspaceChangesPanel(host, snapshot, { sessionId });
		          } catch { }
		        })();
		      }
	      // Don't sync from store here - we already have the latest local state
	      // syncSessionFromStore would re-render and potentially overwrite the UI
	    };
    const onError = (err: unknown) => {
      const normalize = (value: unknown): { text: string; friendly: boolean } => {
        if (value && typeof value === 'object') {
          const friendlyMessage = typeof (value as any).friendlyMessage === 'string' ? (value as any).friendlyMessage : undefined;
          const friendly = friendlyMessage != null || (value as any).friendly === true;
          const text = friendlyMessage
            ?? (typeof (value as any).message === 'string' ? (value as any).message : undefined)
            ?? String(value ?? 'Unknown error');
          return { text, friendly };
        }
        if (typeof value === 'string' && value.trim()) {
          return { text: value, friendly: false };
        }
        return { text: String(value ?? 'Unknown error'), friendly: false };
      };

      const { text: rawText, friendly } = normalize(err);
      const text = rawText && rawText.trim() ? rawText.trim() : 'Something went wrong.';

      ensureAssistant();
      if (!currentAssistant) return;

      let updated: string;
      if (friendly) {
        setAssistantMessageContent(currentAssistant, text);
        updated = text;
      } else {
        const existing = getAssistantMessageContent(currentAssistant);
        const prefix = existing ? '\n' : '';
        updated = `${existing}${prefix}[Error] ${text}`;
        setAssistantMessageContent(currentAssistant, updated);
        // Offer a retry button after a hard failure. We do both: attach immediately and mark for re-attach after any re-render.
        const attachRetry = (host: HTMLElement | null) => {
          try {
            if (!host) return;
            if (host.querySelector('.retry-btn')) return;
            const retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'retry-btn';
            retryBtn.textContent = 'Retry request';
            retryBtn.addEventListener('click', () => {
              retryBtn.disabled = true;
              try {
                const lastUser = [...conversationHistory].slice().reverse().find(ev => ev && ev.type === 'user') as ChatUserEvent | undefined;
                if (lastUser) {
                  const newItems: OpenAIResponseItem[] = [{ role: 'user', content: blocksToUserContent(lastUser.content) }];
                  startStreamingSession({ sessionId, newItems });
                } else {
                  const inputEl = document.getElementById('ai-input') as HTMLTextAreaElement | null;
                  if (inputEl) inputEl.focus();
                }
              } catch { }
            });
            host.appendChild(document.createElement('br'));
            host.appendChild(retryBtn);
          } catch { }
        };
        // Try attaching immediately to the current assistant message
        attachRetry(currentAssistant);
        // Also mark for re-attach after the next render (since error handling may trigger a full re-render)
        try { (window as any).__retryAfterRenderForSession = sessionId; } catch { }
        // Best-effort delayed attempts to reattach if a re-render wipes the DOM
        try {
          let tries = 0;
          const attempt = () => {
            tries += 1;
            const nodes = Array.from(document.querySelectorAll('#chat-thread .msg.assistant .content')) as HTMLElement[];
            const host = nodes[nodes.length - 1] || null;
            attachRetry(host);
            if (tries < 10 && (window as any).__retryAfterRenderForSession === sessionId) {
              setTimeout(attempt, 200);
            } else {
              try { delete (window as any).__retryAfterRenderForSession; } catch { }
            }
          };
          setTimeout(attempt, 50);
        } catch { }

      }
      if (currentAssistantEventIndex == null) {
        const event: ChatMessageEvent = { type: 'message', content: updated, timestamp: Date.now() };
        currentAssistantEventIndex = appendEventToActiveChat(event);
      } else {
        const event = conversationHistory[currentAssistantEventIndex] as ChatMessageEvent | undefined;
        if (event) event.content = updated;
      }
      if (currentAssistantRawIndex != null) {
        const rawItem = conversationRaw[currentAssistantRawIndex];
        if (rawItem && rawItem.type === 'message') {
          rawItem.content = [{ type: 'output_text', text: updated }];
        }
      }
      markDirty();
      setSendButton('send');
      clearRunToken();
      stopCurrent = null;
      streamingSessionId = null;
      flushHistory();
      setProgress(false);
      if (activeChatId) {
        syncSessionFromStore(activeChatId).catch(() => { });
      }
    };

    // Tool-call visualization
    const prettyName = (name?: string): string => {
      switch (name) {
        case 'read_file': return 'Reading File';
        case 'grep_search': return 'Grep Search';
        case 'create_file': return 'Create File';
        case 'create_diff': return 'Diff';
        case 'terminal_input': return 'Terminal Input';
        case 'read_terminal': return 'Read Terminal';
        case 'summarize_terminal_output': return 'Summarize Terminal Output';
        case 'create_terminal': return 'Create Terminal';
        case 'close_terminal': return 'Close Terminal';
        case 'detect_dev_server': return 'Detect Dev Server';
        case 'generate_image_tool': return 'Generate Image';
        case 'add_todo_tool': return 'Add Todo';
        case 'update_todo_item_tool': return 'Update Todo';
        case 'update_todo_status_tool': return 'Update Todo Status';
        case 'clear_todos_tool': return 'Clear Todos';
        case 'list_todos_tool': return 'List Todos';
        default: return name ? `Tool: ${name}` : 'Tool';
      }
    };
    const todoToolNames = new Set(['add_todo_tool', 'update_todo_item_tool', 'update_todo_status_tool', 'clear_todos_tool', 'list_todos_tool']);
    // Track tool call rows so progress + results can update in place.
    const toolEls = new Map<string, { el: HTMLElement; roleEl: HTMLElement; spinner?: HTMLElement; contentEl: HTMLElement; filePath?: string }>();
    const toolEventIndex = new Map<string, number>();
    const clampText = (value: string, max = 600): string => {
      return value.length > max ? `${value.slice(0, max)}…` : value;
    };

    const formatMonitorExtra = (extra: any): string | undefined => {
      if (!extra || typeof extra !== 'object') return undefined;
      try {
        const text = JSON.stringify(extra, null, 2);
        return clampText(text, 1200);
      } catch {
        return undefined;
      }
    };

    const handleAgentMonitor = (payload: any) => {
      const levelRaw = typeof payload?.level === 'string' ? payload.level.toLowerCase() : '';
      const level = levelRaw === 'error' || levelRaw === 'warn' || levelRaw === 'info' ? levelRaw : 'info';
      const stage = String(payload?.stage || 'agent');
      const messageRaw = typeof payload?.message === 'string' ? payload.message : '';
      const message = messageRaw.trim();
      if (!message) return; // Skip empty/default messages (was showing debug noise)
      const extraText = formatMonitorExtra(payload?.extra);
      const metaParts: string[] = [];
      if (payload?.model) metaParts.push(`model=${payload.model}`);
      if (payload?.extra?.sessionId) metaParts.push(`session=${payload.extra.sessionId}`);
      if (payload?.timestamp) {
        try {
          const ts = new Date(Number(payload.timestamp));
          if (!Number.isNaN(ts.getTime())) metaParts.push(`time=${ts.toLocaleTimeString()}`);
        } catch { }
      }

      const el = document.createElement('div');
      el.className = `msg agent-monitor level-${level}`;
      const role = document.createElement('span');
      role.className = 'role';
      const label = level === 'error' ? 'Agent Error' : level === 'warn' ? 'Agent Warning' : 'Agent Info';
      role.textContent = `${label} · ${stage}`;
      const content = document.createElement('div');
      content.className = 'content';

      const baseMessage = clampText(message);
      const parts = [baseMessage].filter(Boolean);
      if (metaParts.length) parts.push(metaParts.join(' | '));
      if (extraText) parts.push(extraText);
      content.textContent = parts.join('\n\n');
      el.appendChild(role);
      el.appendChild(content);
      chatEl.appendChild(el);
      scrollToBottom();
      repositionAssistantWorkingIndicator();
    };

    const addToolLine = (id: string | undefined, title: string, detail?: string, toolKey?: string) => {
      const el = document.createElement('div');
      el.className = 'msg tool';
      // Add tool-specific class for visual distinction
      if (toolKey) el.classList.add(`tool-${toolKey}`);
      const role = document.createElement('span'); role.className = 'role';
      const spin = document.createElement('span'); spin.className = 'spinner'; role.appendChild(spin);
      role.appendChild(document.createTextNode(title));
      if (id && toolKey === 'grep_search') {
        const cancel = document.createElement('button');
        cancel.className = 'tool-cancel';
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
          if (!sessionId) return;
          try { window.ai.cancelTool(sessionId, id); } catch { }
        });
        cancel.style.marginLeft = 'auto';
        role.appendChild(cancel);
      }
      const content = document.createElement('div'); content.className = 'content'; content.textContent = detail || '';
      el.appendChild(role); el.appendChild(content); chatEl.appendChild(el); scrollToBottom();
      repositionAssistantWorkingIndicator();
      if (id) toolEls.set(id, { el, roleEl: role, spinner: spin, contentEl: content });
    };
    const onToolEvent = (type: 'start' | 'args' | 'exec' | 'result', payload: any) => {
      try {
        const name = prettyName(payload?.name);
        if (type === 'start') {
          awaitingNewSegment = true;
          addToolLine(payload?.id, name, undefined, payload?.name);
          setProgress(true, todoToolNames.has(payload?.name) ? 'Running todo tool…' : 'Running tool…');
          const callId = String(payload?.id || payload?.call_id || '');
          if (callId) {
            pendingToolCallsRaw.set(callId, { name: String(payload?.name || ''), args: '' });
          }
        } else if (type === 'args') {
          const callId = String(payload?.id || payload?.call_id || '');
          if (callId) {
            const rec = pendingToolCallsRaw.get(callId) ?? { name: String(payload?.name || ''), args: '' };
            const delta = String(payload?.delta || '');
            if (delta) rec.args = (rec.args || '') + delta;
            if (!rec.name) rec.name = String(payload?.name || '');
            pendingToolCallsRaw.set(callId, rec);
          }
        } else if (type === 'exec') {
          const isTodoTool = todoToolNames.has(payload?.name);
          setProgress(true, isTodoTool ? 'Managing todos…' : 'Working…');
          let args: any = {};
          try { args = JSON.parse(String(payload?.arguments ?? '{}')); } catch { }

          // Switch to terminal tab for terminal-related tools
          const terminalTools = new Set([
            'terminal_input',
            'read_terminal',
            'summarize_terminal_output',
            'create_terminal',
            'close_terminal',
            'detect_dev_server',
          ]);
          if (terminalTools.has(payload?.name)) {
            try { (window as any).child?.switchTab?.('terminal'); } catch { }
          }

          const callId = String(payload?.id || payload?.call_id || '');
          let detail = '';
          let fileForOpen: string | undefined;
          if (!isTodoTool) {
            switch (payload?.name) {
              case 'read_file': detail = args?.filePath ? `${formatScopedPathForDisplay(args.filePath)}` : ''; fileForOpen = args?.filePath; break;
              case 'grep_search': detail = [args?.pattern ? `pattern: ${args.pattern}` : '', args?.files ? `files: ${formatScopedPathForDisplay(args.files)}` : ''].filter(Boolean).join(' | '); break;
              case 'terminal_input': {
                const cmd = String(args?.text ?? '');
                const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
                const trimmed = cmd.trim();
                detail = trimmed ? `[${terminal}] ${trimmed}` : `[${terminal}]`;
                break;
              }
              case 'read_terminal': {
                const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
                const modeHint = typeof args?.bytes === 'number' ? `${args.bytes} bytes` : typeof args?.lines === 'number' ? `${args.lines} lines` : '';
                detail = `[${terminal}] ${modeHint}`.trim();
                break;
              }
              case 'summarize_terminal_output': {
                const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
                const modeHint = typeof args?.bytes === 'number' ? `${args.bytes} bytes` : typeof args?.lines === 'number' ? `${args.lines} lines` : '';
                const prompt = args?.prompt ? String(args.prompt).trim() : '';
                const promptShort = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
                detail = [`[${terminal}]`, modeHint, promptShort].filter(Boolean).join(' ').trim();
                break;
              }
              case 'create_terminal': {
                const terminalCwd = args?.cwd ? formatScopedPathForDisplay(String(args.cwd)) : ''; const dims = [] as string[];
                const colsVal = Number(args?.cols);
                const rowsVal = Number(args?.rows);
                if (Number.isFinite(colsVal) && colsVal > 0) dims.push(`${colsVal} cols`);
                if (Number.isFinite(rowsVal) && rowsVal > 0) dims.push(`${rowsVal} rows`);
                const parts = [terminalCwd ? `cwd: ${terminalCwd}` : '', dims.length ? dims.join(', ') : ''].filter(Boolean);
                detail = parts.join(' | ');
                break;
              }
              case 'close_terminal': {
                const terminal = args?.terminal_id ? String(args.terminal_id) : '';
                detail = terminal ? `[${terminal}]` : '';
                break;
              }
              case 'detect_dev_server': {
                const terminal = args?.terminal_id ? String(args.terminal_id) : 'default';
                const bytesVal = Number(args?.bytes);
                const bytesHint = Number.isFinite(bytesVal) && bytesVal > 0 ? `${bytesVal} bytes` : '';
                detail = `[${terminal}] ${bytesHint}`.trim();
                break;
              }
              case 'create_file': detail = args?.filePath ? formatScopedPathForDisplay(String(args.filePath)) : ''; fileForOpen = args?.filePath; break;
              case 'create_diff': detail = args?.filePath ? formatScopedPathForDisplay(String(args.filePath)) : ''; fileForOpen = args?.filePath; break;
              case 'generate_image_tool': fileForOpen = args?.outputPath; break;
              default: detail = String(payload?.arguments || '');
            }
          }
          let rec = toolEls.get(payload?.id);
          if (rec) {
            rec.contentEl.textContent = '';
            if (fileForOpen) {
              const a = document.createElement('span');
              a.className = 'file-link';
              a.textContent = formatScopedPathForDisplay(fileForOpen);
              a.title = fileForOpen;
              a.addEventListener('click', () => { try { window.viewer.openPath(fileForOpen!); } catch { } });
              rec.filePath = fileForOpen;
              rec.contentEl.appendChild(a);
            } else if (!isTodoTool) {
              rec.contentEl.textContent = detail || '';
            }
          } else {
            addToolLine(payload?.id, name, detail, payload?.name);
            rec = toolEls.get(payload?.id);
          }

          if (payload?.name === 'generate_image_tool') {
            const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
            const outputPath = typeof args?.outputPath === 'string' ? String(args.outputPath) : '';
            const resolution = typeof args?.size === 'string' && args.size.trim() ? String(args.size) : 'auto';
            const quality = typeof args?.quality === 'string' && args.quality.trim() ? String(args.quality) : 'high';
            if (rec) {
              rec.contentEl.textContent = '';
              const meta = document.createElement('div');
              meta.className = 'tool-image-meta';
              if (outputPath) {
                const pathEl = document.createElement('span');
                pathEl.className = 'file-link tool-image-path';
                pathEl.textContent = formatScopedPathForDisplay(outputPath);
                pathEl.title = outputPath;
                pathEl.addEventListener('click', () => { try { (window as any).files?.openExternal?.({ path: outputPath }); } catch { } });
                rec.filePath = outputPath;
                meta.appendChild(pathEl);
              }
              const jsonPayload = {
                prompt,
                resolution,
                quality,
              };
              const jsonEl = document.createElement('pre');
              jsonEl.className = 'tool-image-json';
              const jsonText = JSON.stringify(jsonPayload, null, 2).replace(/\s*\n\s*/g, ' ');
              jsonEl.textContent = jsonText;
              meta.appendChild(jsonEl);
              rec.contentEl.appendChild(meta);
            }
          }
          if (callId) {
            const storedArgs = typeof args === 'object' && args !== null ? args : (payload?.arguments ?? {});
            const event: ChatToolCallEvent = {
              type: 'tool_call',
              content: { tool_name: String(payload?.name || ''), call_id: callId, args: storedArgs },
              timestamp: Date.now(),
            };
            const idx = appendEventToActiveChat(event);
            toolEventIndex.set(callId, idx);
            markDirty();

            const pendingRecord = pendingToolCallsRaw.get(callId);
            const argsSerialized = (() => {
              if (typeof payload?.arguments === 'string' && payload.arguments) return payload.arguments;
              if (pendingRecord?.args) return pendingRecord.args;
              try { return JSON.stringify(storedArgs); } catch { return '{}'; }
            })();
            const rawCall: OpenAIResponseItem = {
              type: 'function_call',
              name: String(payload?.name || ''),
              call_id: callId,
              arguments: argsSerialized,
            };
            conversationRaw.push(rawCall);
            pendingToolCallsRaw.set(callId, { name: rawCall.name || '', args: argsSerialized });
            markDirty();
          }
        } else if (type === 'result') {
          const rec = toolEls.get(payload?.id);
          if (rec?.spinner) rec.roleEl.removeChild(rec.spinner);
          try { rec?.roleEl.querySelector('.tool-cancel')?.remove(); } catch { }
          const isTodoTool = todoToolNames.has(payload?.name);
          const data = payload?.data;
          const resultText = typeof payload?.result === 'string' ? payload.result : '';
          const normalizedResult = resultText.trim().toLowerCase();
          const isError = normalizedResult.startsWith('error');
          if (isTodoTool) {
            if (rec) {
              if (isError) {
                rec.contentEl.textContent = resultText;
              } else {
                rec.el.remove();
                toolEls.delete(payload?.id);
              }
            }
            todoPanel.updateFromTool(payload?.name, data, isError ? resultText : undefined);
            setProgress(true);
            return;
          }

          let text: string | undefined;
          let diffPreview: { filePath: string; oldText: string; newText: string } | null = null;
          if (payload?.name === 'read_file') { text = data?.content; if (data?.path && rec) rec.filePath = data.path; }
          else if (payload?.name === 'grep_search') text = data?.stdout;
          else if (payload?.name === 'create_file') { text = data?.content; if (data?.path && rec) rec.filePath = data.path; }
          else if (payload?.name === 'create_diff') {
            const p = data?.preview;
            if (p && typeof p === 'object') {
              const oldT = typeof p.oldText === 'string' ? p.oldText : '';
              const newT = typeof p.newText === 'string' ? p.newText : '';
              diffPreview = { filePath: String(data?.path || rec?.filePath || ''), oldText: oldT, newText: newT };
            }
            if (data?.path && rec) rec.filePath = data.path;
          }
          const hasTextPreview = typeof text === 'string' && text.trim();
          const hasDiffPreview = payload?.name === 'create_diff' && diffPreview;
          if (rec && (hasTextPreview || hasDiffPreview)) {
            const wrapper = document.createElement('div'); wrapper.className = 'preview';
            const details = document.createElement('details');
            // Only open by default for create_diff and create_file during live streaming
            const isFileModifyTool = payload?.name === 'create_diff' || payload?.name === 'create_file';
            if (isFileModifyTool) details.open = true;
            const summary = document.createElement('summary');
            const pre = document.createElement('pre');
            const codeEl = document.createElement('code');
            const ext = (rec?.filePath || '').split('.').pop()?.toLowerCase();
            let lang = ext === 'htm' ? 'xml' : (ext || '');
            const isDiffPreview = payload?.name === 'create_diff';

            // Truncate very long content for performance
            const MAX_PREVIEW_LINES = 100;
            const langLabel = isDiffPreview ? 'diff' : (lang || 'text');

            if (isDiffPreview && diffPreview) {
              const oldLines = diffPreview.oldText.replace(/\r\n/g, '\n').split('\n');
              const newLines = diffPreview.newText.replace(/\r\n/g, '\n').split('\n');
              const fullDiff = generateUnifiedDiff(oldLines, newLines);
              const meaningfulDiff = filterDiffContext(fullDiff, 3);

              const lineCount = meaningfulDiff.length;
              const isTruncated = lineCount > MAX_PREVIEW_LINES;
              const displayDiff = isTruncated ? meaningfulDiff.slice(0, MAX_PREVIEW_LINES) : meaningfulDiff;
              const truncatedHint = isTruncated ? ` (first ${MAX_PREVIEW_LINES} shown)` : '';

              summary.textContent = `Preview · DIFF · ${lineCount} lines${truncatedHint}`;
              details.appendChild(summary);
              renderUnifiedDiffIntoCode(codeEl, rec?.filePath || diffPreview.filePath || '', displayDiff);
              pre.appendChild(codeEl);

              if (isTruncated) {
                const showAllBtn = document.createElement('button');
                showAllBtn.className = 'preview-show-all';
                showAllBtn.textContent = `Show all ${lineCount} lines`;
                showAllBtn.addEventListener('click', () => {
                  renderUnifiedDiffIntoCode(codeEl, rec?.filePath || diffPreview.filePath || '', meaningfulDiff);
                  showAllBtn.remove();
                  summary.textContent = `Preview · DIFF · ${lineCount} lines`;
                });
                pre.appendChild(showAllBtn);
              }
            } else {
              const fullText = typeof text === 'string' ? text : '';
              const allLines = fullText.split('\n');
              const lineCount = allLines.length;
              const isTruncated = lineCount > MAX_PREVIEW_LINES;
              const displayText = isTruncated ? allLines.slice(0, MAX_PREVIEW_LINES).join('\n') : fullText;
              const truncatedHint = isTruncated ? ` (first ${MAX_PREVIEW_LINES} shown)` : '';

              summary.textContent = `Preview · ${langLabel.toUpperCase()} · ${lineCount} line${lineCount !== 1 ? 's' : ''}${truncatedHint}`;
              details.appendChild(summary);
              codeEl.removeAttribute('data-diff');
              try {
                if (lang && hljs.getLanguage(lang)) {
                  codeEl.innerHTML = hljs.highlight(displayText, { language: lang }).value;
                } else {
                  codeEl.innerHTML = hljs.highlightAuto(displayText).value;
                }
              } catch { codeEl.textContent = displayText; }
              pre.appendChild(codeEl);

              // Add "Show all" button if content was truncated
              if (isTruncated) {
                const showAllBtn = document.createElement('button');
                showAllBtn.className = 'preview-show-all';
                showAllBtn.textContent = `Show all ${lineCount} lines`;
                showAllBtn.addEventListener('click', () => {
                  try {
                    if (lang && hljs.getLanguage(lang)) {
                      codeEl.innerHTML = hljs.highlight(fullText, { language: lang }).value;
                    } else {
                      codeEl.innerHTML = hljs.highlightAuto(fullText).value;
                    }
                  } catch { codeEl.textContent = fullText; }
                  showAllBtn.remove();
                  summary.textContent = `Preview · ${langLabel.toUpperCase()} · ${lineCount} line${lineCount !== 1 ? 's' : ''}`;
                });
                pre.appendChild(showAllBtn);
              }
            }

            details.appendChild(pre);
            wrapper.appendChild(details);
            rec.contentEl.appendChild(wrapper);
          }
          if (payload?.name === 'generate_image_tool') {
            const mime = typeof data?.mime === 'string' && data.mime.trim() ? data.mime : 'image/png';
            const base64 = typeof data?.base64 === 'string' ? data.base64 : '';
            if (rec && base64) {
              const imgWrap = document.createElement('div');
              imgWrap.className = 'tool-image-preview';
              const img = document.createElement('img');
              img.src = `data:${mime};base64,${base64}`;
              img.alt = 'generated image';
              if (rec.filePath) {
                img.addEventListener('click', () => {
                  try { (window as any).files?.openExternal?.({ path: rec.filePath! }); } catch { }
                });
              }
              imgWrap.appendChild(img);
              rec.contentEl.appendChild(imgWrap);
            }
          }
          if (rec?.filePath) {
            rec.contentEl.addEventListener('dblclick', () => { try { window.viewer.openPath(rec.filePath!); } catch { } });
          }
          const resultCallId = String(payload?.id || payload?.call_id || '');
          if (resultCallId) {
            const outputText = typeof payload?.result === 'string' ? payload.result : (payload?.result == null ? '' : String(payload.result));
            appendEventToActiveChat({ type: 'tool_result', content: { call_id: resultCallId, output: outputText }, timestamp: Date.now() });
            markDirty();
            const rawResult: OpenAIResponseItem = {
              type: 'function_call_output',
              call_id: resultCallId,
              output: outputText,
            };
            conversationRaw.push(rawResult);
            markDirty();
            pendingToolCallsRaw.delete(resultCallId);
            if (payload?.name === 'screenshot_preview') {
              const mime = typeof data?.mime === 'string' ? data.mime : undefined;
              const base64 = typeof data?.data === 'string' ? data.data : undefined;
              if (mime && base64) {
                const screenshotItem: OpenAIResponseItem = {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: 'Here is the screenshot result' },
                    { type: 'input_image', image_url: `data:${mime};base64,${base64}` },
                  ],
                };
                conversationRaw.push(screenshotItem);
                markDirty();
              }
            }
          }
          setProgress(true);
        }
      } catch { }
    };

    // Render reasoning summaries on their own message row so the stream shows
    // a clear sequence of user → assistant → tools → reasoning.
    const onReasoningEvent = (type: 'reset' | 'summary_delta' | 'summary_done' | 'text_delta' | 'text_done', payload?: any) => {
      if (type === 'reset') {
        resetReasoning();
        return;
      }
      const reuse = type === 'text_delta' || type === 'text_done';
      const rn = ensureReasoning(reuse);
      const updateEncrypted = (value?: string | null) => {
        if (currentReasoningEventIndex == null) return;
        const event = conversationHistory[currentReasoningEventIndex] as ChatReasoningEvent | undefined;
        if (event) {
          event.encrypted_reasoning = value ?? undefined;
          markDirty();
        }
        if (currentReasoningRawIndex != null) {
          const rawItem = conversationRaw[currentReasoningRawIndex];
          if (rawItem && rawItem.type === 'reasoning') {
            rawItem.encrypted_content = value ?? undefined;
          }
        }
      };
      try {
        if (type === 'summary_delta') {
          const delta = String(payload?.delta ?? '');
          if (!delta) return;
          const next = (rn.summaryText || '') + delta;
          applySummaryText(rn, next);
          rn.completed = false;
        } else if (type === 'summary_done' && typeof payload?.text === 'string') {
          applySummaryText(rn, payload.text);
          const encrypted = payload?.encrypted_reasoning ?? payload?.event?.encrypted_reasoning ?? payload?.event?.item?.encrypted_reasoning;
          if (encrypted) updateEncrypted(String(encrypted));
          rn.completed = true;
        } else if (type === 'text_delta') {
          const delta = String(payload?.delta || '');
          if (!delta) return;
          rn.traceAccum = (rn.traceAccum || '') + delta;
          rn.sawText = true;
          rn.completed = false;
          renderTrace(rn);
        } else if (type === 'text_done') {
          if (typeof payload?.text === 'string') {
            rn.traceAccum = payload.text;
            rn.sawText = rn.sawText || Boolean(payload.text?.trim());
            renderTrace(rn);
          }
          const encrypted = payload?.encrypted_reasoning ?? payload?.event?.encrypted_reasoning ?? payload?.event?.item?.encrypted_reasoning;
          if (encrypted) updateEncrypted(String(encrypted));
          rn.completed = true;
          currentReasoning = null;
          currentReasoningRawIndex = null;
        }
      } catch { }
    };

    // Confirmation UI for chat mode
    const onConfirm = (message: any) => {
      try {
        const kind = typeof message?.kind === 'string' ? message.kind : undefined;
        const payload = kind ? message?.payload : message;
        if (!payload || typeof payload !== 'object') return;
        const id = String((payload as any)?.id ?? (payload as any)?.callId ?? '');
        if (!id) return;

        if (kind === 'resolved') {
          setProgress(true);
          return;
        }
        if (kind && kind !== 'request') return;

        const rec = toolEls.get(id);
        // If we cannot find an existing tool row, render a minimal one
        const ensureRow = () => {
          if (rec && rec.el && rec.contentEl) return rec;
          const title = payload?.name ? `Tool: ${String(payload.name)}` : 'Tool';
          addToolLine(id, title, '', payload?.name);
          return toolEls.get(id);
        };
        const row = ensureRow();
        if (!row) return;
        // Build preview block (reuse existing preview styles)
        const wrapper = document.createElement('div');
        wrapper.className = 'preview';
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        // Will update summary text after we know the content details
        details.appendChild(summary);

        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        const renderPreviewText = (): string => {
          const p = payload?.preview || {};
          const name = String(payload?.name || '');
          try {
            if (name === 'create_file') {
              const path = p?.path || JSON.parse(payload?.arguments || '{}')?.filePath || '';
              const content = p?.content ?? '';
              return `Create file: ${path}\n\n${content}`;
            }
            if (name === 'create_diff') {
              const path = p?.path || JSON.parse(payload?.arguments || '{}')?.filePath || '';
              const oldT = typeof p?.oldText === 'string' ? p.oldText : '';
              const newT = typeof p?.newText === 'string' ? p.newText : '';

              // Generate unified diff using simple LCS-based algorithm
              const oldLines = oldT.replace(/\r\n/g, '\n').split('\n');
              const newLines = newT.replace(/\r\n/g, '\n').split('\n');

              // Simple diff: find common prefix and suffix, show changes in between
              const computeUnifiedDiff = (oldArr: string[], newArr: string[]): string[] => {
                const result: string[] = [];

                // Find common prefix
                let prefixLen = 0;
                while (prefixLen < oldArr.length && prefixLen < newArr.length && oldArr[prefixLen] === newArr[prefixLen]) {
                  prefixLen++;
                }

                // Find common suffix (from the remaining lines)
                let suffixLen = 0;
                while (
                  suffixLen < oldArr.length - prefixLen &&
                  suffixLen < newArr.length - prefixLen &&
                  oldArr[oldArr.length - 1 - suffixLen] === newArr[newArr.length - 1 - suffixLen]
                ) {
                  suffixLen++;
                }

                // Context lines before changes (up to 3)
                const contextBefore = Math.min(prefixLen, 3);
                for (let i = prefixLen - contextBefore; i < prefixLen; i++) {
                  result.push(`  ${oldArr[i]}`);
                }

                // Changed lines - deletions first, then additions (unified style)
                const oldChanged = oldArr.slice(prefixLen, oldArr.length - suffixLen);
                const newChanged = newArr.slice(prefixLen, newArr.length - suffixLen);

                // Interleave deletions and additions for better readability
                for (const line of oldChanged) {
                  result.push(`- ${line}`);
                }
                for (const line of newChanged) {
                  result.push(`+ ${line}`);
                }

                // Context lines after changes (up to 3)
                const contextAfter = Math.min(suffixLen, 3);
                for (let i = oldArr.length - suffixLen; i < oldArr.length - suffixLen + contextAfter; i++) {
                  result.push(`  ${oldArr[i]}`);
                }

                return result;
              };

              const diffLines = computeUnifiedDiff(oldLines, newLines);
              const sections: string[] = [];
              sections.push(path ? `Apply diff to: ${path}` : 'Apply diff');
              if (diffLines.length > 0) {
                sections.push('');
                sections.push(...diffLines);
              }
              return sections.join('\n');
            }
            if (name === 'terminal_input') {
              const t = p?.text ?? '';
              const terminalId = p?.terminal_id ? String(p.terminal_id) : 'default';
              return `Write to terminal [${terminalId}]${p?.newline ? ' (with newline)' : ''}:\n${t}`;
            }
          } catch { }
          // Fallback to raw arguments
          return String(payload?.arguments || '');
        };
        const renderDiffIntoCode = (target: HTMLElement, text: string) => {
          target.textContent = '';
          target.setAttribute('data-diff', 'true');
          const classify = (line: string): string | undefined => {
            if (!line) return undefined;
            if (line.startsWith('+')) return 'hljs-addition';
            if (line.startsWith('-')) return 'hljs-deletion';
            if (line.startsWith('  ')) return 'hljs-context'; // Context lines (unchanged)
            if (
              line.startsWith('@@')
              || line.startsWith('diff ')
              || line.startsWith('index ')
              || line.startsWith('---')
              || line.startsWith('+++')
            ) {
              return 'hljs-meta';
            }
            if (line.startsWith('#') || line.startsWith('//') || line.startsWith('Apply diff')) return 'hljs-comment';
            return undefined;
          };
          const normalized = text.replace(/\r\n/g, '\n').split('\n');
          // Track line numbers for old (deletions) and new (additions) content
          let oldLineNum = 1;
          let newLineNum = 1;
          normalized.forEach((line, idx) => {
            const lineWrapper = document.createElement('span');
            lineWrapper.className = 'diff-line';
            const cls = classify(line);
            if (cls) lineWrapper.classList.add(cls);

            // Add line number gutter
            const lineNumEl = document.createElement('span');
            lineNumEl.className = 'diff-line-num';
            if (cls === 'hljs-deletion') {
              lineNumEl.textContent = String(oldLineNum++);
              lineNumEl.setAttribute('data-type', 'old');
            } else if (cls === 'hljs-addition') {
              lineNumEl.textContent = String(newLineNum++);
              lineNumEl.setAttribute('data-type', 'new');
            } else if (cls === 'hljs-meta' || cls === 'hljs-comment') {
              lineNumEl.textContent = '';
            } else {
              // Context lines (not expected in current format but handle gracefully)
              lineNumEl.textContent = '';
            }
            lineWrapper.appendChild(lineNumEl);

            // Add line content
            const contentEl = document.createElement('span');
            contentEl.className = 'diff-line-content';
            contentEl.textContent = line;
            lineWrapper.appendChild(contentEl);

            target.appendChild(lineWrapper);
          });
        };
        const previewText = renderPreviewText();
        const isDiffPreview = String(payload?.name || '') === 'create_diff';
        const isCreateFile = String(payload?.name || '') === 'create_file';

        // Build informative summary text
        const lineCount = previewText.split('\n').length;
        const p = payload?.preview || {};
        const filePath = p?.path || '';
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const langLabel = isDiffPreview ? 'DIFF' : (ext ? ext.toUpperCase() : 'TEXT');
        const actionLabel = isDiffPreview ? 'Review Changes' : (isCreateFile ? 'Review New File' : 'Review & Approve');
        summary.textContent = `${actionLabel} · ${langLabel} · ${lineCount} line${lineCount !== 1 ? 's' : ''}`;

        try {
          if (isDiffPreview) {
            renderDiffIntoCode(codeEl, previewText);
          } else {
            codeEl.removeAttribute('data-diff');
            const lang = ext === 'htm' ? 'xml' : ext;
            if (lang && hljs.getLanguage(lang)) {
              codeEl.innerHTML = hljs.highlight(previewText, { language: lang }).value;
            } else {
              codeEl.textContent = previewText;
            }
          }
        } catch {
          if (isDiffPreview) renderDiffIntoCode(codeEl, previewText);
          else {
            codeEl.removeAttribute('data-diff');
            codeEl.textContent = previewText;
          }
        }
        pre.appendChild(codeEl);
        details.appendChild(pre);

        // Controls
        const controls = document.createElement('div');
        controls.className = 'confirm-controls';

        const btnDeny = document.createElement('button');
        btnDeny.type = 'button';
        btnDeny.className = 'confirm-btn confirm-cancel';
        btnDeny.textContent = 'Cancel';
        const btnAllow = document.createElement('button');
        btnAllow.type = 'button';
        btnAllow.className = 'confirm-btn confirm-allow';
        btnAllow.textContent = 'Allow';

        const disable = () => { btnAllow.disabled = true; btnDeny.disabled = true; };
        btnDeny.addEventListener('click', () => {
          if (!sessionId) return;
          try { window.ai.confirmResponse({ sessionId, id, allow: false }); } catch { }
          disable();
        });
        btnAllow.addEventListener('click', () => {
          if (!sessionId) return;
          try { window.ai.confirmResponse({ sessionId, id, allow: true }); } catch { }
          disable();
        });

        controls.appendChild(btnDeny);
        controls.appendChild(btnAllow);
        details.appendChild(controls);
        wrapper.appendChild(details);

        // Clear any stale content text and append preview+controls
        row.contentEl.appendChild(wrapper);
        setProgress(true, 'Awaiting approval…');
        scrollToBottom();
      } catch { }
    };

    const onNotice = (payload: any) => {
      try {
        const text = String(payload?.text || '');
        if (!text) return;
        // Create notice without spinner (notices are informational, not ongoing operations)
        const el = document.createElement('div');
        el.className = 'msg tool notice';
        const role = document.createElement('span');
        role.className = 'role';
        // Info icon instead of spinner
        const icon = document.createElement('span');
        icon.className = 'notice-icon';
        icon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
        role.appendChild(icon);
        role.appendChild(document.createTextNode('Notice'));
        const content = document.createElement('div');
        content.className = 'content';
        content.textContent = text;
        el.appendChild(role);
        el.appendChild(content);
        chatEl.appendChild(el);
        scrollToBottom();
      } catch { }
    };

    const onMonitor = (payload: any) => {
      try {
        handleAgentMonitor(payload);
      } catch { }
    };

    if (!resume) {
      try { await (window as any).workspace?.captureBaseline?.({ sessionId, runId: runToken }); } catch { }
    }
    try {
      const preRes: WorkspaceChangesResponse = await (window as any).workspace?.changes?.({ sessionId, runId: runToken, limit: 0, offset: 0 });
      if (preRes?.ok) {
        preChangesFingerprint = typeof preRes.fingerprint === 'string' && preRes.fingerprint
          ? preRes.fingerprint
          : fingerprintWorkspaceChangesFiles(preRes.files);
      } else {
        const session = getActiveSession();
        if (session?.workspaceChanges?.files?.length) {
          preChangesFingerprint = fingerprintWorkspaceChangesFiles(session.workspaceChanges.files);
        }
      }
    } catch { }

    const cleanup = window.ai.chatStream(messageBatch, {
      model: uiState.model,
      reasoning_effort: uiState.reasoning,
      autoMode: uiState.mode !== 'chat',
      workingDir,
      additionalWorkingDir: additionalWorkingDir || undefined,
      sessionId,
      resume,
      runId: runToken ?? undefined,
    }, onToken, onError, onDone, onToolEvent, onReasoningEvent, onConfirm, onNotice, onMonitor);
    if (!resume) {
      pendingAttachments = [];
      updateAttachmentsUi();
    } else {
      setProgress(true);
    }
    setSendButton('stop');
    stopCurrent = () => {
      try { cleanup(); } catch { }
      flushHistory({ updateTimestamp: true });
      setSendButton('send');
      setProgress(false);
      clearRunToken();
      stopCurrent = null;
      streamingSessionId = null;
    };
      streamingSessionId = sessionId;
    } catch (error) {
      try { console.warn('startStreamingSession failed:', error); } catch { }
      try {
        setSendButton('send');
        setProgress(false);
      } catch { }
      const message = error instanceof Error ? error.message : String(error ?? 'Failed to start session');
      if (message && message.trim()) showToast(message.trim(), 'error');
    }
  };
  startStreamingSession = startStreamingSessionImpl;

  const send = async () => {
    const rawText = input.value || '';
    const displayText = rawText.trim();
    if (!displayText && pendingAttachments.length === 0) return;
    hideMentionMenu();
    await ensureActiveChat();
    if (!activeChatId) return;
    const sessionId = activeChatId;
    input.value = '';
    autoSize();

    const now = Date.now();
    const agentText = stripAtMentions(displayText);
    const displayBlocks: ChatContentBlock[] = [];
    const agentBlocks: ChatContentBlock[] = [];
    if (displayText) displayBlocks.push({ type: 'text', content: displayText });
    if (agentText) agentBlocks.push({ type: 'text', content: agentText });
    for (const att of pendingAttachments) {
      const filename = att.path || att.name;
      const imageBlock = { type: 'image', content: { mime_type: att.mime || 'image/png', data: att.base64, filename: filename || undefined } } as ChatContentBlock;
      displayBlocks.push(imageBlock);
      agentBlocks.push(imageBlock);
    }
    const userEvent: ChatUserEvent = { type: 'user', content: displayBlocks, timestamp: now };
    const userItem: OpenAIResponseItem = {
      role: 'user',
      content: blocksToUserContent(agentBlocks),
    };
    if (displayText) {
      (userItem as any).display_text = displayText;
    }
    appendEventToActiveChat(userEvent);
    conversationRaw.push(userItem);
    persistActiveChat({ updateTitle: true });
    enforceModelProviderLock();
    syncUiLabels();
    applyModelLockConstraints();
    const newItems: OpenAIResponseItem[] = [userItem];
    const displayLabel = displayText || (pendingAttachments.length ? '(attached images)' : '');
    const contentEl = addMessage('user', displayLabel);
    if (pendingAttachments.length) renderAttachmentChips(contentEl, pendingAttachments);
    awaitingNewSegment = false;
    currentReasoning = null;

    let billing = await fetchBillingState();
    if (billing && billing.authenticated && billing.ok && billing.hasActiveSubscription === false) {
      try {
        const refreshed = await window.billing?.refresh?.();
        const refreshedState = coerceBillingState(refreshed?.state);
        if (refreshedState) billing = refreshedState;
      } catch { }
    }

    const creditsOk = hasCredits(billing);
    if (billing && billing.authenticated && billing.ok && !creditsOk) {
      const assistantText = 'No credits remaining. Choose a plan to continue.';
      const assistantEvent: ChatMessageEvent = { type: 'message', content: assistantText, timestamp: Date.now() };
      const assistantItem: OpenAIResponseItem = { role: 'assistant', content: [{ type: 'output_text', text: assistantText }] };
      appendEventToActiveChat(assistantEvent);
      conversationRaw.push(assistantItem);
      persistActiveChat({ updateTimestamp: true, updateTitle: false });
      addMessage('assistant', assistantText);
      try { promptPaywall?.(); } catch {}
      pendingAttachments = [];
      updateAttachmentsUi();
      setProgress(false);
      setSendButton('send');
      return;
    }

    if (billing && billing.authenticated && billing.ok === false && billing.error) {
      showToast(billing.error, 'error');
    }

    setProgress(true);

    if (!startStreamingSession) {
      setProgress(false);
      setSendButton('send');
      return;
    }
    startStreamingSession({ sessionId, newItems });
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); void send(); });
  input.addEventListener('keydown', (e) => {
    if (handleMentionKey(e)) return;
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      void send();
      return;
    }
    if (!e.shiftKey && !e.altKey) {
      e.preventDefault();
      void send();
    }
  });

  // Auto-size the textarea up to a reasonable max height.
  // (Min/max are driven by CSS so design tweaks don't require code changes.)
  const autoSize = (): void => {
    if (!input) return;
    const styles = window.getComputedStyle(input);
    const min = Number.parseFloat(styles.minHeight) || 72;
    const max = Number.parseFloat(styles.maxHeight) || 280;

    // Reset first so scrollHeight reflects the full content height.
    input.style.height = 'auto';
    const scroll = input.scrollHeight;
    const next = Math.min(scroll, max);
    input.style.height = `${Math.max(next, min)}px`;

    // Only allow inner scrolling once we've hit the cap.
    input.style.overflowY = scroll > max ? 'auto' : 'hidden';
  };
  autoSize();
  input.addEventListener('input', () => {
    autoSize();
    scheduleMentionUpdate();
  });
  input.addEventListener('focus', () => {
    autoSize();
    scheduleMentionUpdate();
  });
  input.addEventListener('click', () => {
    scheduleMentionUpdate();
  });

}

// Divider and right-pane bounds sync
let setColumnsRef: ((ratio: number, persist?: boolean, immediatePersist?: boolean) => void) | null = null;
const DEFAULT_RIGHT_SPLIT = 0.45; // Right pane width when chat panel is visible (left 55%)
const COLLAPSED_RIGHT_SPLIT = 1;
const MIN_LEFT_FRACTION = 0.3;
const MIN_RIGHT_FRACTION = 0.2;
const DIVIDER_PX = 4; // matches CSS .divider width in px
const HAMBURGER_RESERVE_PX = 48; // Must align with padding applied when layout is collapsed

const clampRatio = (value: number): number => {
  const minRight = MIN_RIGHT_FRACTION;
  const maxRight = 1 - MIN_LEFT_FRACTION;
  return Math.max(minRight, Math.min(maxRight, value));
};

let currentSplit = clampRatio(DEFAULT_RIGHT_SPLIT);

const LEFT_COLLAPSE_KEY = 'bc.layout.leftCollapsed';
const layoutState = {
  collapsed: false,
  leftEl: document.querySelector('.left') as HTMLElement | null,
  dividerEl: document.getElementById('divider') as HTMLElement | null,
  leftParent: null as HTMLElement | null,
  dividerParent: null as HTMLElement | null,
  leftPlaceholder: null as Comment | null,
  dividerPlaceholder: null as Comment | null,
  titleBar: null as HTMLElement | null,
  prevSplit: clampRatio(DEFAULT_RIGHT_SPLIT),
  collapseFn: null as ((initial?: boolean, persistSetting?: boolean) => void) | null,
  expandFn: null as ((initial?: boolean) => void) | null,
};

type LayoutMode = 'split' | 'agent' | 'browser';
let currentLayoutMode: LayoutMode = 'split';

function setLayoutMode(mode: LayoutMode, origin: 'internal' | 'external' = 'internal'): void {
  if (mode === currentLayoutMode && origin === 'internal') {
    return;
  }

  const rightPane = document.querySelector('.right') as HTMLElement | null;
  const divider = document.getElementById('divider');

  if (mode === 'agent') {
    if (layoutState.collapsed) {
      layoutState.expandFn?.();
    }
    document.body.classList.remove('layout-browser-only');
    document.body.classList.add('layout-agent-only');
    if (rightPane) {
      rightPane.style.display = 'none';
      rightPane.setAttribute('aria-hidden', 'true');
    }
    if (divider) divider.style.display = 'none';
    document.body.style.gridTemplateColumns = '1fr 0px 0fr';
    try { window.layout?.setSplit?.(0); } catch { }
  } else if (mode === 'browser') {
    document.body.classList.remove('layout-agent-only');
    document.body.classList.add('layout-browser-only');
    document.body.style.removeProperty('gridTemplateColumns');
    if (rightPane) {
      rightPane.style.removeProperty('display');
      rightPane.removeAttribute('aria-hidden');
    }
    if (divider) divider.style.removeProperty('display');
    if (!layoutState.collapsed) {
      layoutState.collapseFn?.();
    } else {
      try { window.layout?.setSplit?.(1); } catch { }
    }
  } else {
    document.body.classList.remove('layout-agent-only', 'layout-browser-only');
    document.body.style.removeProperty('gridTemplateColumns');
    if (rightPane) {
      rightPane.style.removeProperty('display');
      rightPane.removeAttribute('aria-hidden');
    }
    if (divider) divider.style.removeProperty('display');
    if (layoutState.collapsed) {
      layoutState.expandFn?.();
    } else if (setColumnsRef) {
      setColumnsRef(layoutState.prevSplit, true, true);
    } else {
      document.body.style.gridTemplateColumns = `${(1 - DEFAULT_RIGHT_SPLIT)}fr ${DIVIDER_PX}px ${DEFAULT_RIGHT_SPLIT}fr`;
    }
    try { window.layout?.setSplit?.(layoutState.prevSplit); } catch { }
  }

  currentLayoutMode = mode;

  if (origin === 'internal') {
    try { window.layout?.notifyModeChange?.(mode); } catch { }
  }

  try { window.dispatchEvent(new Event('resize')); } catch { }
}

function setupDivider(): void {
  try {
    const divider = document.getElementById('divider');
    if (!divider) return;
    let dragging = false;
    let persistTimer: number | null = null;
    // Divider remains in the DOM for structure and interactive resizing when the
    // chat panel is visible. Collapse mode uses the hamburger exclusively.

    const persistRatio = (r: number, immediate = false) => {
      try {
        if (persistTimer) { window.clearTimeout(persistTimer); persistTimer = null; }
        const apply = () => {
          try { window.layout?.setSplit(r); } catch { }
          if (!layoutState.collapsed && r > 0 && r < 1) {
            layoutState.prevSplit = clampRatio(r);
          }
        };
        if (immediate) { apply(); return; }
        persistTimer = window.setTimeout(apply, 150);
      } catch { }
    };

    function setColumns(ratio: number, persist = false, immediatePersist = false): void {
      try {
        let r = layoutState.collapsed
          ? COLLAPSED_RIGHT_SPLIT
          : clampRatio(Number.isFinite(ratio) ? Number(ratio) : currentSplit);
        const dividerPx = (r === 0 || r === 1) ? 0 : DIVIDER_PX;
        document.body.style.gridTemplateColumns = `${(1 - r)}fr ${dividerPx}px ${r}fr`;
        currentSplit = r;
        if (!layoutState.collapsed && r > 0 && r < 1) {
          layoutState.prevSplit = clampRatio(r);
        }
        if (persist) persistRatio(r, immediatePersist);
      } catch { }
    }

    // Expose setter to other parts (e.g., main -> renderer apply split)
    setColumnsRef = setColumns;

    divider.style.pointerEvents = 'auto';
    divider.style.cursor = 'col-resize';
    divider.removeAttribute('aria-hidden');
    divider.setAttribute('tabindex', '0');

    // Ensure initial layout uses the fixed split.
    setColumns(DEFAULT_RIGHT_SPLIT, true, true);

    divider.addEventListener('mousedown', () => {
      if (layoutState.collapsed) return;
      dragging = true;
      divider.classList.add('dragging');
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      if (!layoutState.collapsed) {
        persistRatio(currentSplit, true);
      }
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!dragging || layoutState.collapsed) return;
      const rect = document.body.getBoundingClientRect();
      const offsetX = Math.max(rect.left, Math.min(e.clientX, rect.right));
      const right = rect.right - offsetX;
      const total = rect.width;
      const ratio = total <= 0 ? currentSplit : right / total;
      setColumns(ratio);
    });

    divider.addEventListener('keydown', (e: KeyboardEvent) => {
      if (layoutState.collapsed) return;
      const step = 0.02;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setColumns(currentSplit + step, true);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setColumns(currentSplit - step, true);
      }
    });
  } catch { }
}

function setupBoundsSync(): void {
  const terminalPane = document.querySelector('.terminal') as HTMLElement | null;
  const rightPane = document.querySelector('.right') as HTMLElement | null;
  // Keep the main process informed about the right-pane position so the
  // WebContents view lines up with the DOM overlay even as the layout resizes.
  let rafPending = false;
  let latest: { x: number; y: number; width: number; height: number } | null = null;
  const queueUpdate = () => {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      if (!latest) return;
      try { window.layout?.setRightBounds(latest); } catch { }
    });
  };
  const measure = () => {
    try {
      const r = rightPane?.getBoundingClientRect();
      if (!r) return;
      latest = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      queueUpdate();
    } catch { }
  };
  const ro = new ResizeObserver(() => { measure(); });
  if (terminalPane) ro.observe(terminalPane);
  if (rightPane) ro.observe(rightPane);
  window.addEventListener('resize', measure);
  measure();
}

function setupLeftToggle(): void {
  const btn = document.getElementById('btn-toggle-left') as HTMLButtonElement | null;
  if (!btn || !layoutState.leftEl || !layoutState.dividerEl) return;

  layoutState.titleBar = layoutState.leftEl.querySelector('.title-bar') as HTMLElement | null;

  const updateButton = (collapsed: boolean) => {
    btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    btn.setAttribute('aria-label', collapsed ? 'Show chat panel' : 'Switch to browser only mode');
    btn.dataset.tooltip = collapsed ? 'Show chat panel (⌘\\)' : 'Browser only (⌘\\)';
    btn.title = collapsed ? 'Show chat panel (⌘\\)' : 'Toggle browser only (⌘\\)';
    btn.classList.toggle('title-toggle-floating', collapsed);
  };

  const persistFlag = (collapsed: boolean, initial: boolean, shouldPersist = true) => {
    if (initial || !shouldPersist) return;
    try { localStorage.setItem(LEFT_COLLAPSE_KEY, collapsed ? 'true' : 'false'); } catch { }
  };

  const ensureButtonInsideTitleBar = () => {
    if (!layoutState.leftEl) return;
    const titleBar = layoutState.leftEl.querySelector('.title-bar') as HTMLElement | null;
    layoutState.titleBar = titleBar;
    if (!titleBar) return;
    if (!titleBar.contains(btn)) {
      titleBar.insertBefore(btn, titleBar.firstChild || null);
    }
  };

  const collapse = (initial = false, persistSetting = true) => {
    if (layoutState.collapsed) return;
    const left = layoutState.leftEl;
    const divider = layoutState.dividerEl;
    if (!left || !divider) return;

    if (!layoutState.leftPlaceholder) layoutState.leftPlaceholder = document.createComment('left-placeholder');
    if (!layoutState.dividerPlaceholder) layoutState.dividerPlaceholder = document.createComment('divider-placeholder');

    if (!layoutState.leftParent && left.parentElement) {
      layoutState.leftParent = left.parentElement as HTMLElement;
    }
    if (!layoutState.dividerParent && divider.parentElement) {
      layoutState.dividerParent = divider.parentElement as HTMLElement;
    }

    // Move toggle button out so it remains clickable when the left pane is hidden
    if (btn.parentElement && btn.parentElement !== document.body) {
      btn.parentElement.removeChild(btn);
      document.body.appendChild(btn);
    }

    if (left.parentElement) {
      left.parentElement.replaceChild(layoutState.leftPlaceholder!, left);
    }
    if (divider.parentElement) {
      divider.parentElement.replaceChild(layoutState.dividerPlaceholder!, divider);
    }

    const previous = clampRatio(currentSplit);
    layoutState.prevSplit = previous;

    document.body.classList.add('layout-collapsed');
    document.body.style.setProperty('--collapse-padding-left', `${HAMBURGER_RESERVE_PX}px`);
    layoutState.collapsed = true;

    if (setColumnsRef) {
      setColumnsRef(COLLAPSED_RIGHT_SPLIT);
    } else {
      document.body.style.gridTemplateColumns = '0fr 0px 1fr';
    }
    try { window.layout?.setSplit?.(1); } catch { }

    updateButton(true);
    persistFlag(true, initial, persistSetting);
    try { window.dispatchEvent(new Event('resize')); } catch { }
  };

  const expand = (initial = false) => {
    if (!layoutState.collapsed) return;
    const left = layoutState.leftEl;
    const divider = layoutState.dividerEl;
    if (!left || !divider) return;

    if (layoutState.leftParent && layoutState.leftPlaceholder && layoutState.leftPlaceholder.parentNode === layoutState.leftParent) {
      layoutState.leftParent.replaceChild(left, layoutState.leftPlaceholder);
    } else if (!left.parentElement && layoutState.leftParent) {
      layoutState.leftParent.insertBefore(left, layoutState.leftParent.firstChild || null);
    }

    if (layoutState.dividerParent && layoutState.dividerPlaceholder && layoutState.dividerPlaceholder.parentNode === layoutState.dividerParent) {
      layoutState.dividerParent.replaceChild(divider, layoutState.dividerPlaceholder);
    } else if (!divider.parentElement && layoutState.dividerParent) {
      if (left.nextSibling) {
        layoutState.dividerParent.insertBefore(divider, left.nextSibling);
      } else {
        layoutState.dividerParent.appendChild(divider);
      }
    }

    ensureButtonInsideTitleBar();

    document.body.classList.remove('layout-collapsed');
    document.body.style.removeProperty('--collapse-padding-left');
    layoutState.collapsed = false;

    const target = clampRatio(layoutState.prevSplit > 0 && layoutState.prevSplit < 1 ? layoutState.prevSplit : DEFAULT_RIGHT_SPLIT);
    if (setColumnsRef) {
      setColumnsRef(target, true, true);
    } else {
      document.body.style.gridTemplateColumns = `${(1 - target)}fr ${DIVIDER_PX}px ${target}fr`;
    }
    try { window.layout?.setSplit?.(target); } catch { }

    layoutState.prevSplit = target;

    updateButton(false);
    persistFlag(false, initial);
    try { window.dispatchEvent(new Event('resize')); } catch { }
  };

  btn.addEventListener('click', () => {
    const targetMode: LayoutMode = layoutState.collapsed ? 'split' : 'browser';
    setLayoutMode(targetMode);
  });

  layoutState.collapseFn = collapse;
  layoutState.expandFn = expand;

  const stored = (() => {
    try { return localStorage.getItem(LEFT_COLLAPSE_KEY); }
    catch { return null; }
  })();

  if (stored === 'true') {
    collapse(true);
  } else {
    ensureButtonInsideTitleBar();
    updateButton(false);
  }

  currentLayoutMode = layoutState.collapsed ? 'browser' : 'split';
}

function setupLayoutModeBridge(): void {
  const applyIncomingMode = (mode: unknown) => {
    if (mode === 'split' || mode === 'agent' || mode === 'browser') {
      setLayoutMode(mode, 'external');
    }
  };

  try { window.layout?.onMode?.((mode: 'split' | 'agent' | 'browser') => applyIncomingMode(mode)); } catch { }

  if (document.body.classList.contains('layout-agent-only')) {
    currentLayoutMode = 'agent';
  } else if (layoutState.collapsed) {
    currentLayoutMode = 'browser';
  } else {
    currentLayoutMode = 'split';
  }

  setLayoutMode(currentLayoutMode, 'external');
  try { window.layout?.notifyModeChange?.(currentLayoutMode); } catch { }
}

// Setup global keyboard shortcuts
function setupGlobalKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl + \ to toggle split/browser-only mode
    if (isMod && !e.shiftKey && !e.altKey && e.key === '\\') {
      e.preventDefault();
      const targetMode: LayoutMode = layoutState.collapsed ? 'split' : 'browser';
      setLayoutMode(targetMode);
    }

    // Cmd/Ctrl + 1/2/3 to switch child view tabs
    if (isMod && !e.shiftKey && !e.altKey) {
      switch (e.key) {
        case '1':
          e.preventDefault();
          try { (window as any).child?.switchTab?.('terminal'); } catch { }
          break;
        case '2':
          e.preventDefault();
          try { (window as any).child?.switchTab?.('preview'); } catch { }
          break;
        case '3':
          e.preventDefault();
          try { (window as any).child?.switchTab?.('code'); } catch { }
          break;
      }
    }
  });
}

// Bootstraps the renderer once the DOM is ready.
async function init(): Promise<void> {
  setupDivider();
  await setupUiControls();
  setupProjectOverlay();
  setupNoticeToasts();
  setupAiInput();
  if (window.billing) {
    setupPaywall();
  }
  await setupChatUi();
  setupLeftToggle();
  setupLayoutModeBridge();
  setupBoundsSync();
  setupUpdateCheck();
  setupGlobalKeyboardShortcuts();
  try {
    const res = await window.workspace.get();
    setWorkspace(res.cwd || '', !!res.persisted);
    // Reflect external workspace changes
    window.workspace.onChanged((cwd) => setWorkspace(cwd, true));
  } catch {
    showCta();
  }
}

// Diff utilities
function computeLCS(oldLines: string[], newLines: string[]) {
  const N = oldLines.length;
  const M = newLines.length;
  let start = 0;
  while (start < N && start < M && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = N - 1;
  let endNew = M - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }

  const trimOld = oldLines.slice(start, endOld + 1);
  const trimNew = newLines.slice(start, endNew + 1);

  const n = trimOld.length;
  const m = trimNew.length;
  const dp: number[][] = Array(n + 1).fill(0).map(() => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (trimOld[i - 1] === trimNew[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = n, j = m;
  const commonTmp = [];
  while (i > 0 && j > 0) {
    if (trimOld[i - 1] === trimNew[j - 1]) {
      commonTmp.push({ oldIdx: start + i - 1, newIdx: start + j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  commonTmp.reverse();

  const common = [];
  for (let k = 0; k < start; k++) common.push({ oldIdx: k, newIdx: k });
  common.push(...commonTmp);
  for (let k = 1; k <= (N - 1 - endOld); k++) common.push({ oldIdx: endOld + k, newIdx: endNew + k });

  return common;
}

type DiffLine =
  | { type: 'equal', content: string, oldLine: number, newLine: number }
  | { type: 'delete', content: string, oldLine: number }
  | { type: 'insert', content: string, newLine: number }
  | { type: 'gap' };

function generateUnifiedDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const common = computeLCS(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const match of common) {
    while (oldIdx < match.oldIdx) {
      result.push({ type: 'delete', content: oldLines[oldIdx], oldLine: oldIdx + 1 });
      oldIdx++;
    }
    while (newIdx < match.newIdx) {
      result.push({ type: 'insert', content: newLines[newIdx], newLine: newIdx + 1 });
      newIdx++;
    }
    result.push({ type: 'equal', content: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
    oldIdx++;
    newIdx++;
  }
  while (oldIdx < oldLines.length) {
    result.push({ type: 'delete', content: oldLines[oldIdx], oldLine: oldIdx + 1 });
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    result.push({ type: 'insert', content: newLines[newIdx], newLine: newIdx + 1 });
    newIdx++;
  }
  return result;
}

function filterDiffContext(diff: DiffLine[], contextLines = 3): DiffLine[] {
  const result: DiffLine[] = [];
  const keepIndices = new Set<number>();

  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type === 'insert' || diff[i].type === 'delete') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(diff.length - 1, i + contextLines); j++) {
        keepIndices.add(j);
      }
    }
  }

  let lastIdx = -1;
  const sortedIndices = Array.from(keepIndices).sort((a, b) => a - b);

  for (const idx of sortedIndices) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      result.push({ type: 'gap' });
    }
    result.push(diff[idx]);
    lastIdx = idx;
  }

  if (result.length === 0 && diff.length > 0) {
    return diff.slice(0, 50); // Show first 50 lines if no changes detected (shouldn't happen for a diff tool) or just return empty
  }

  return result;
}

function renderUnifiedDiffIntoCode(target: HTMLElement, filePath: string, diff: DiffLine[]): void {
  target.textContent = '';
  target.setAttribute('data-diff', 'true');

  const lang = detectLanguageFromPath(filePath || '');
  const hasLang = lang && hljs.getLanguage(lang);

  diff.forEach((item, idx) => {
    const lineWrapper = document.createElement('span');
    lineWrapper.className = 'diff-line';

    const lineNumEl = document.createElement('span');
    lineNumEl.className = 'diff-line-num';

    const contentEl = document.createElement('span');
    contentEl.className = 'diff-line-content';

    if (item.type === 'gap') {
      lineWrapper.classList.add('hljs-meta');
      lineNumEl.textContent = '...';
      contentEl.textContent = '...';
    } else {
      if (item.type === 'equal') {
        lineWrapper.classList.add('hljs-context');
        lineNumEl.textContent = String(item.newLine);
      } else if (item.type === 'delete') {
        lineWrapper.classList.add('hljs-deletion');
        lineNumEl.textContent = String(item.oldLine);
      } else if (item.type === 'insert') {
        lineWrapper.classList.add('hljs-addition');
        lineNumEl.textContent = String(item.newLine);
      }

      let html = item.content;
      if (hasLang && item.content.trim()) {
        try {
          html = hljs.highlight(item.content, { language: lang, ignoreIllegals: true }).value;
        } catch { }
      } else {
        html = escapeHtml(item.content);
      }

      if (item.type === 'delete') html = `- ${html}`;
      else if (item.type === 'insert') html = `+ ${html}`;
      else html = `  ${html}`;

      contentEl.innerHTML = html;
    }

    lineWrapper.appendChild(lineNumEl);
    lineWrapper.appendChild(contentEl);
    target.appendChild(lineWrapper);
    if (idx < diff.length - 1) target.appendChild(document.createTextNode('\n'));
  });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { init(); }, { once: true });
} else {
  init();
}
