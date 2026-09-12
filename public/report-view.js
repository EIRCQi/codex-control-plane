const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// A deliberately small Markdown subset. Raw HTML and images remain text.
// Every source fragment is escaped, including link labels and code fences.
function inline(source) {
  const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]{1,300}\]\(https?:\/\/[^)\s]{1,2000}\)/g;
  let html = '', cursor = 0;
  for (const match of source.matchAll(pattern)) {
    html += escape(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) html += `<code>${escape(token.slice(1,-1))}</code>`;
    else if (token.startsWith('**') || token.startsWith('__')) html += `<strong>${escape(token.slice(2,-2))}</strong>`;
    else {
      const boundary = token.lastIndexOf(']('), label = token.slice(1,boundary), target = token.slice(boundary+2,-1);
      let url;
      try { url = new URL(target); } catch {}
      html += url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password
        ? `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(label)}</a>` : escape(token);
    }
    cursor = match.index + token.length;
  }
  return html + escape(source.slice(cursor));
}

const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g,'|'));
const tableRule = line => line.includes('|') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));
const listItem = line => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
const blockStart = (lines, i) => /^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|(?:[-*_]\s*){3,}$)/.test(lines[i]) || listItem(lines[i]) || (i+1<lines.length && tableRule(lines[i+1]));

export function renderReport(source = '') {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {i++; continue;}
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const code = [], end = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      i++;
      while (i<lines.length && !end.test(lines[i])) code.push(lines[i++]);
      if (i<lines.length) i++;
      blocks.push(`<div class="report-code"><span>${escape(fence[2].trim() || '代码')}</span><pre tabindex="0"><code>${escape(code.join('\n'))}</code></pre></div>`);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {const level = Math.min(heading[1].length + 1, 6); blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue;}
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {blocks.push('<hr>'); i++; continue;}
    if (i+1<lines.length && line.includes('|') && tableRule(lines[i+1])) {
      const header = cells(line), rows = [];
      i+=2;
      while (i<lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      blocks.push(`<div class="report-table" tabindex="0" role="region" aria-label="报告表格"><table><thead><tr>${header.map(cell=>`<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i<lines.length && /^\s*>/.test(lines[i])) quote.push(inline(lines[i++].replace(/^\s*>\s?/,'')));
      blocks.push(`<blockquote>${quote.join('<br>')}</blockquote>`); continue;
    }
    const item = listItem(line);
    if (item) {
      // Keep indentation visible, even for list forms outside this subset.
      const ordered = /^\d/.test(item[2]), tag = ordered ? 'ol' : 'ul', items = [];
      const start = ordered ? ` start="${Math.min(Number.parseInt(item[2],10) || 1,1000000)}"` : '';
      while (i<lines.length) {
        const next = listItem(lines[i]);
        if (!next || /^\d/.test(next[2]) !== ordered || next[1].length !== item[1].length) break;
        items.push(`<li>${inline(next[3])}</li>`); i++;
      }
      blocks.push(`<${tag}${start} class="report-list" style="margin-inline-start:${Math.min(item[1].length,12)}ch">${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [inline(line)]; i++;
    while (i<lines.length && lines[i].trim() && !blockStart(lines,i)) paragraph.push(inline(lines[i++]));
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('\n');
}

export function setupReportView(root, {readMode = () => 'reading', saveMode = () => {}} = {}) {
  const reading = root.querySelector('[data-report-reading]');
  const source = root.querySelector('[data-execution-report]');
  const buttons = [...root.querySelectorAll('[data-report-mode]')];
  let mode = readMode() === 'source' ? 'source' : 'reading', text = '', rendered = null, key = null;
  function render() {
    if (source.textContent !== text) source.textContent = text;
    if (mode === 'reading' && text !== rendered) {
      const top = reading.scrollTop;
      reading.innerHTML = renderReport(text); reading.scrollTop = top; rendered = text;
    }
    reading.hidden = !text || mode !== 'reading'; source.hidden = !text || mode !== 'source';
    for (const button of buttons) {button.setAttribute('aria-pressed', String(button.dataset.reportMode === mode)); button.disabled = !text;}
  }
  for (const button of buttons) button.addEventListener('click', () => {
    mode = button.dataset.reportMode === 'source' ? 'source' : 'reading'; saveMode(mode); render();
  });
  return {update(value, nextKey) {
    if (key !== nextKey) {reading.scrollTop = 0; source.scrollTop = 0; key = nextKey;}
    text = String(value || ''); render();
  }};
}
