function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeMarkdownUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function renderInlineMarkdown(source) {
  const preserved = [];
  const hold = (markup) => {
    const token = `\uE000${preserved.length}\uE001`;
    preserved.push([token, markup]);
    return token;
  };
  const prepared = String(source)
    .replace(/`([^`\n]+)`/g, (_match, code) => hold(`<code class="inline-code">${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi, (match, label, href) => {
      const safeHref = safeMarkdownUrl(href);
      if (!safeHref) return match;
      return hold(`<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(label)}</a>`);
    });
  let html = escapeHtml(prepared)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
  for (const [token, markup] of preserved) html = html.replaceAll(token, markup);
  return html;
}

function renderCodeBlock(lines, language, copyDisabled) {
  const label = language.trim().split(/\s+/, 1)[0].slice(0, 32) || '코드';
  return `<div class="code-block">
    <div class="code-block-header"><span>${escapeHtml(label)}</span><button class="copy-code-button" type="button" aria-label="코드 블록 복사"${copyDisabled ? ' disabled' : ''}>복사</button></div>
    <pre><code>${escapeHtml(lines.join('\n'))}</code></pre>
  </div>`;
}

export function renderMarkdown(source, { copyDisabled = false } = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(`<blockquote><p>${renderInlineMarkdown(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };
  const finishCode = () => {
    blocks.push(renderCodeBlock(code.lines, code.language, copyDisabled));
    code = null;
  };

  for (const line of lines) {
    if (code) {
      const closingFence = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (closingFence && closingFence[1][0] === code.marker && closingFence[1].length >= code.length) finishCode();
      else code.lines.push(line);
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (openingFence) {
      flushTextBlocks();
      code = {
        marker: openingFence[1][0],
        length: openingFence[1].length,
        language: openingFence[2],
        lines: [],
      };
      continue;
    }

    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flushTextBlocks();
      blocks.push('<hr>');
      continue;
    }

    const quoteMatch = line.match(/^ {0,3}>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const listMatch = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const type = /^\d/.test(listMatch[1]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push(listMatch[2]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  if (code) finishCode();
  flushTextBlocks();
  return blocks.join('\n');
}
