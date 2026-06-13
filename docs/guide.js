// Unicorn Pocket — dependency-free markdown renderer for the docs viewer.
// Used by guide.html to render .md files in-browser on mobile.
// Rewrites X.md href targets to guide.html?doc=X so cross-links stay in-app.
// Escapes HTML in text nodes to prevent injection.
'use strict';

(function (global) {
  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Rewrite X.md links to guide.html?doc=X (strips the .md extension for the doc param)
  function rewriteDocLink(href) {
    // Match bare .md links (relative, no protocol)
    const m = href.match(/^([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\.md(#.*)?$/);
    if (m) {
      // Extract just the filename without path and extension
      const parts = m[1].split('/');
      const docName = parts[parts.length - 1];
      return 'guide.html?doc=' + encodeURIComponent(docName) + (m[2] || '');
    }
    return null;
  }

  // Parse inline elements: bold, italic, code, links
  function inlineRender(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      // Inline code: `...`
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          out += '<code>' + escHtml(text.slice(i + 1, end)) + '</code>';
          i = end + 1;
          continue;
        }
      }
      // Bold: **...**
      if (text.slice(i, i + 2) === '**') {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) {
          out += '<strong>' + inlineRender(text.slice(i + 2, end)) + '</strong>';
          i = end + 2;
          continue;
        }
      }
      // Italic: *...* (single asterisk, not double)
      if (text[i] === '*' && text[i + 1] !== '*') {
        const end = text.indexOf('*', i + 1);
        if (end !== -1 && text[end + 1] !== '*') {
          out += '<em>' + inlineRender(text.slice(i + 1, end)) + '</em>';
          i = end + 1;
          continue;
        }
      }
      // Link: [text](url)
      if (text[i] === '[') {
        const closeBracket = text.indexOf(']', i);
        if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
          const closeParens = text.indexOf(')', closeBracket + 2);
          if (closeParens !== -1) {
            const linkText = text.slice(i + 1, closeBracket);
            const href = text.slice(closeBracket + 2, closeParens);
            const rewritten = rewriteDocLink(href);
            const finalHref = rewritten !== null ? rewritten : href;
            const isExternal = /^https?:\/\//.test(finalHref);
            const rel = isExternal ? ' rel="noopener noreferrer"' : '';
            const target = isExternal ? ' target="_blank"' : '';
            out += '<a href="' + escHtml(finalHref) + '"' + target + rel + '>' + inlineRender(linkText) + '</a>';
            i = closeParens + 1;
            continue;
          }
        }
      }
      // Plain character — escape HTML
      out += escHtml(text[i]);
      i++;
    }
    return out;
  }

  // Render a markdown string to an HTML string.
  function renderMarkdown(md) {
    const lines = md.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block: ```
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        let code = '';
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code += escHtml(lines[i]) + '\n';
          i++;
        }
        const classAttr = lang ? ' class="language-' + escHtml(lang) + '"' : '';
        html += '<pre><code' + classAttr + '>' + code + '</code></pre>\n';
        i++; // skip closing ```
        continue;
      }

      // Heading: # through ######
      const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        html += '<h' + level + '>' + inlineRender(headingMatch[2]) + '</h' + level + '>\n';
        i++;
        continue;
      }

      // Horizontal rule: ---
      if (/^---+$/.test(line.trim())) {
        html += '<hr>\n';
        i++;
        continue;
      }

      // Table: detect | headers | and | --- | separators |
      if (/^\|/.test(line) && i + 1 < lines.length && /^\|[-| :]+\|/.test(lines[i + 1])) {
        const headerCells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        html += '<table>\n<thead><tr>';
        for (const cell of headerCells) {
          html += '<th>' + inlineRender(cell.trim()) + '</th>';
        }
        html += '</tr></thead>\n<tbody>\n';
        i += 2; // skip header + separator
        while (i < lines.length && /^\|/.test(lines[i])) {
          const cells = lines[i].split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
          html += '<tr>';
          for (const cell of cells) {
            html += '<td>' + inlineRender(cell.trim()) + '</td>';
          }
          html += '</tr>\n';
          i++;
        }
        html += '</tbody></table>\n';
        continue;
      }

      // Unordered list item: - or *
      if (/^(\s*)[-*]\s+/.test(line)) {
        html += '<ul>\n';
        while (i < lines.length && /^(\s*)[-*]\s+/.test(lines[i])) {
          const content = lines[i].replace(/^\s*[-*]\s+/, '');
          html += '<li>' + inlineRender(content) + '</li>\n';
          i++;
        }
        html += '</ul>\n';
        continue;
      }

      // Ordered list item: 1. 2. etc.
      if (/^\d+\.\s+/.test(line)) {
        html += '<ol>\n';
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          const content = lines[i].replace(/^\d+\.\s+/, '');
          html += '<li>' + inlineRender(content) + '</li>\n';
          i++;
        }
        html += '</ol>\n';
        continue;
      }

      // Blockquote: >
      if (/^>\s?/.test(line)) {
        html += '<blockquote>\n';
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          html += '<p>' + inlineRender(lines[i].replace(/^>\s?/, '')) + '</p>\n';
          i++;
        }
        html += '</blockquote>\n';
        continue;
      }

      // Blank line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph: gather consecutive non-special lines
      let para = '';
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') break;
        if (/^(#{1,6}\s|```|---+$|\||[-*]\s|\d+\.\s|>\s?)/.test(l)) break;
        para += (para ? ' ' : '') + l.trim();
        i++;
      }
      if (para) {
        html += '<p>' + inlineRender(para) + '</p>\n';
      }
    }

    return html;
  }

  global.GuideRenderer = { renderMarkdown };
})(typeof window !== 'undefined' ? window : global);
