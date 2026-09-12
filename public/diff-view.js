const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Git quotes paths with C escapes, including octal UTF-8 bytes.
function pathText(value) {
  if (!value.startsWith('"')) return value.split('\t')[0];
  const bytes = [], encoder = new TextEncoder();
  for (let i=1; i<value.length && value[i] !== '"'; i++) {
    if (value[i] === '\\') {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i+1));
      if (octal) {bytes.push(Number.parseInt(octal[0],8)); i+=octal[0].length; continue;}
      i++; const controls = {a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v'};
      bytes.push(...encoder.encode(controls[value[i]] ?? value[i] ?? ''));
    } else {
      const point = String.fromCodePoint(value.codePointAt(i)); bytes.push(...encoder.encode(point)); i+=point.length-1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const repositoryPath = value => {const path = pathText(value); return path === '/dev/null' ? '' : path.replace(/^[ab]\//,'');};

export function parseDiff(source = '') {
  if (!source) return [];
  const chunks = String(source).split(/(?=^diff --git )/m).filter(Boolean);
  return chunks.map((text, index) => {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let oldPath = '', newPath = '', renamed = '', kind = '修改', oldLine = null, newLine = null, inHunk = false, added = 0, removed = 0;
    const rows = lines.map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return {line,kind:'hunk'};}
      if (!inHunk) {
        if (line.startsWith('--- ')) oldPath = repositoryPath(line.slice(4));
        if (line.startsWith('+++ ')) newPath = repositoryPath(line.slice(4));
        if (line.startsWith('rename to ')) {renamed = pathText(line.slice(10)); kind = '重命名';}
        if (line.startsWith('new file mode ')) kind = '新增';
        if (line.startsWith('deleted file mode ')) kind = '删除';
        if (line.startsWith('Binary files ') || line === 'GIT binary patch') kind = kind === '修改' ? '二进制' : `${kind} · 二进制`;
        return {line,kind:'meta'};
      }
      if (line.startsWith('+')) {added++; return {line,kind:'add',newLine:newLine++};}
      if (line.startsWith('-')) {removed++; return {line,kind:'remove',oldLine:oldLine++};}
      if (line.startsWith(' ')) return {line,kind:'context',oldLine:oldLine++,newLine:newLine++};
      return {line,kind:'meta'};
    });
    const header = lines[0] || '补丁内容';
    let fallback = '';
    const quoted = /^diff --git ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/.exec(header);
    const plain = /^diff --git a\/(.*?) b\/(.+)$/.exec(header);
    if (quoted) fallback = repositoryPath(quoted[2]);
    else if (plain) fallback = plain[2];
    return {id:`${index}:${header}`,path:renamed || newPath || oldPath || fallback || '补丁内容',kind,added,removed,rows,text};
  });
}

export function setupDiffView(root) {
  const get = name => root.querySelector(`[data-diff-${name}]`);
  const workspace = get('workspace'), empty = get('empty'), search = get('search'), list = get('files');
  const lines = get('lines'), more = get('more'), wrap = get('wrap');
  let runId = null, diff = null, files = [], selected = null, limit = 500, rendered = '', fileMarkup = '';
  const visibleFiles = () => files.filter(file => file.path.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
  function renderLines(file) {
    const key = file ? `${file.id}:${limit}` : '';
    if (key !== rendered) {
      const previousTop = lines.scrollTop;
      lines.innerHTML = file ? file.rows.slice(0,limit).map(row => `<div class="diff-row diff-${row.kind}"><span class="diff-number" aria-hidden="true">${row.oldLine ?? ''}</span><span class="diff-number" aria-hidden="true">${row.newLine ?? ''}</span><code>${escape(row.line)}</code></div>`).join('') : '<p class="tab-empty">没有匹配的文件，请调整搜索条件。</p>';
      lines.scrollTop = previousTop; rendered = key;
    }
    get('title').textContent = file?.path || '没有匹配的文件';
    get('meta').textContent = file ? `${file.kind} · +${file.added} / −${file.removed}` : '';
    get('progress').textContent = file ? `已显示 ${Math.min(limit,file.rows.length)} / ${file.rows.length} 行` : '';
    more.hidden = !file || limit >= file.rows.length;
  }
  function render() {
    const visible = visibleFiles();
    if (visible.length && !visible.some(file => file.id === selected)) {selected = visible[0].id; limit = 500; lines.scrollTop = 0;}
    const markup = visible.map(file => `<button type="button" class="diff-file" data-diff-file="${escape(file.id)}" aria-pressed="${file.id === selected}"><span class="diff-file-kind">${escape(file.kind)}</span><span class="diff-file-path">${escape(file.path)}</span><span class="diff-file-counts"><b>+${file.added}</b><em>−${file.removed}</em></span></button>`).join('');
    if (fileMarkup !== markup) {list.innerHTML = markup; fileMarkup = markup;}
    get('count').textContent = `${visible.length} / ${files.length} 个文件`;
    renderLines(visible.find(file => file.id === selected));
  }
  search.addEventListener('input', render);
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-diff-file]');
    if (!button || button.dataset.diffFile === selected || !files.some(file => file.id === button.dataset.diffFile)) return;
    selected = button.dataset.diffFile; limit = 500; lines.scrollTop = 0; lines.scrollLeft = 0; render();
    // Updating the pressed state replaces file buttons; restore keyboard focus.
    [...list.querySelectorAll('[data-diff-file]')].find(node => node.dataset.diffFile === selected)?.focus({preventScroll:true});
  });
  more.addEventListener('click', () => {limit += 500; render();});
  wrap.addEventListener('change', () => {lines.classList.toggle('is-wrapped', wrap.checked);});
  return {update(run) {
    const next = run?.diff || '';
    if (runId === run?.id && diff === next) return;
    if (runId !== run?.id) {search.value = ''; selected = null;}
    runId = run?.id; diff = next; files = parseDiff(next); limit = 500; rendered = null;
    lines.scrollTop = 0; lines.scrollLeft = 0;
    workspace.hidden = !files.length; empty.hidden = Boolean(files.length);
    empty.textContent = run?.mode === 'review' ? '只读审查不会生成修改补丁。' : '批准实施并产生文件修改后，这里会显示代码变更。';
    get('summary').textContent = `${files.length} 个文件 · 新增 ${files.reduce((sum,file)=>sum+file.added,0)} 行 · 删除 ${files.reduce((sum,file)=>sum+file.removed,0)} 行`;
    render();
  }};
}
