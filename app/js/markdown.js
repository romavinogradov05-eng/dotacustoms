/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — крошечный markdown для гайдов и сообщений
   Поддерживает: заголовки, жирный/курсив, код, списки, цитаты,
   ссылки, таблицы, переносы строк. HTML из пользователей не trusted:
   перед вставкой всё экранируется.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Инлайновое форматирование поверх уже экранированного текста. */
  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      // только http(s) — иначе это не ссылка
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_, label, href) => `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`);
  }

  /**
   * Единственная точка, где строка пользователя превращается в HTML.
   * Сначала экранируем, потом форматируем: иначе `<img onerror=…>` в тексте
   * или кавычка внутри ссылки вырвались бы в разметку.
   */
  function fmt(raw) {
    return inline(esc(raw));
  }

  function render(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let inCode = false, codeLang = '', codeBuf = [];
    let listType = null;      // 'ul' | 'ol'
    let inQuote = false;
    let paragraph = [];

    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
    const flushPara = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.join('<br>')}</p>`);
        paragraph = [];
      }
    };
    const closeBlocks = () => { flushPara(); closeList(); closeQuote(); };

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].replace(/\s+$/, '');

      // блок кода
      if (/^```/.test(line)) {
        if (inCode) {
          out.push(`<pre><code data-lang="${esc(codeLang)}">${esc(codeBuf.join('\n'))}</code></pre>`);
          inCode = false; codeBuf = []; codeLang = '';
        } else {
          closeBlocks();
          inCode = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }
      if (inCode) { codeBuf.push(lines[n]); continue; }

      if (!line.trim()) { closeBlocks(); continue; }

      // заголовки
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        closeBlocks();
        const level = head[1].length;
        out.push(`<h${level}>${fmt(head[2].trim())}</h${level}>`);
        continue;
      }

      // горизонтальная линия
      if (/^([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        closeBlocks();
        out.push('<hr />');
        continue;
      }

      // таблица: | a | b |  +  | --- | --- |
      // сравниваем по индексу, а не по значению строки: одинаковых строк
      // в гайде может быть несколько, и indexOf() смотрел бы не туда
      const sep = /^\s*\|[\s:|-]+\|\s*$/.test(lines[n + 1] || '');
      if (/^\s*\|/.test(line) && sep) {
        closeBlocks();
        const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const headCells = cells(line);
        const align = cells(lines[n + 1]).map(c => (/^:.*:$/.test(c) ? 'center' : ''));
        out.push('<table><thead><tr>' + headCells
          .map((c, i) => `<th style="text-align:${align[i] || 'left'}">${fmt(c)}</th>`).join('') + '</tr></thead><tbody>');
        for (let r = n + 2; r < lines.length && /^\s*\|/.test(lines[r]); r++) {
          const row = cells(lines[r]);
          out.push('<tr>' + headCells.map((_, j) =>
            `<td style="text-align:${align[j] || 'left'}">${fmt(row[j] || '')}</td>`).join('') + '</tr>');
          n = r;
        }
        out.push('</tbody></table>');
        continue;
      }

      // цитата
      if (/^>\s?/.test(line)) {
        flushPara(); closeList();
        if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
        out.push(`<p>${fmt(line.replace(/^>\s?/, ''))}</p>`);
        continue;
      }
      closeQuote();

      // списки
      const ul = /^[-*+]\s+(.*)$/.exec(line);
      const ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (listType !== want) { closeList(); out.push(`<${want}>`); listType = want; }
        out.push(`<li>${fmt((ul || ol)[1])}</li>`);
        continue;
      }
      closeList();

      paragraph.push(fmt(line));
    }

    if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
    closeBlocks();
    return out.join('\n');
  }

  /** Разбирает YAML-подобный front matter: `key: value` до первой пустой строки. */
  function frontMatter(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    if (!src.startsWith('---')) return { data: {}, body: src };
    const end = src.indexOf('\n---', 3);
    if (end < 0) return { data: {}, body: src };
    const head = src.slice(3, end).trim();
    const body = src.slice(end + 4).replace(/^\n+/, '');
    const data = {};
    for (const line of head.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
      data[key] = val;
    }
    return { data, body };
  }

  window.md = { render, esc, inline, fmt, frontMatter };
})();
