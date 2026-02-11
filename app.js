const state = {
  reportName: '',
  chunks: [],
  groups: [],
  selectedGroup: null,
  selectedObject: null,
  filters: { search: '', risk: 'all', type: 'all', group: 'all', sortBy: 'countDesc' },
};

const el = {
  fileInput: document.getElementById('fileInput'),
  searchInput: document.getElementById('searchInput'),
  groupFilter: document.getElementById('groupFilter'),
  typeFilter: document.getElementById('typeFilter'),
  riskFilter: document.getElementById('riskFilter'),
  sortBy: document.getElementById('sortBy'),
  groupList: document.getElementById('groupList'),
  details: document.getElementById('details'),
  detailsPlaceholder: document.getElementById('detailsPlaceholder'),
  summary: document.getElementById('summary'),
};

const headerRe = /^(Изменено:\s*\d+\s*-\s*\d+|Объект присутствует только в основной конфигурации:\s*\d+\s*-\s*\d+|Объект присутствует только в файле:\s*\d+\s*-\s*\d+)/;

function countTabs(raw = '') {
  return (raw.match(/^\t*/) || [''])[0].length;
}

const cleanNode = (text) => text
  .replace(/^[-\s]*/, '')
  .replace(/^\*\*\*\s?/, '')
  .replace(/^-->/, '→ ')
  .replace(/^<--/, '← ')
  .replace(/^\^-/, '↕ ')
  .trim();

function decodeTextFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  try { return new TextDecoder('utf-8').decode(bytes); } catch { return new TextDecoder('utf-16le').decode(bytes); }
}

function extractGroupName(objectPath) {
  const segments = objectPath.split(' / ').map((s) => s.replace(/^[→←↕]\s*/, '').trim());
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const m = seg.match(/^([A-Za-zА-Яа-я_]+)\./);
    if (m) return m[1];
  }
  return 'Прочее';
}

function classifyChunkType(type, neutral) {
  const joined = neutral.join(' ');
  const looksMeta =
    /Основная\s+конфигурация/i.test(joined)
    && /Файл/i.test(joined)
    && /Значение\s*:/i.test(joined);
  if (looksMeta) return 'meta';
  return type;
}

function parseMetaPairs(neutral) {
  const lines = neutral.map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
  if (!lines.length) return [];

  const rows = [];
  let current = null;
  for (const line of lines) {
    if (/^Основная\s+конфигурация/i.test(line)) {
      current = { parameter: 'Параметр', oldValue: '', newValue: '' };
      rows.push(current);
      continue;
    }
    if (/^Файл/i.test(line)) continue;
    const m = line.match(/^Значение\s*:\s*(.+)$/i);
    if (m) {
      if (!current) {
        current = { parameter: 'Параметр', oldValue: m[1], newValue: '' };
        rows.push(current);
      } else if (!current.oldValue) {
        current.oldValue = m[1];
      } else {
        current.newValue = m[1];
      }
    }
  }
  return rows.filter((r) => r.oldValue || r.newValue);
}

function parseValueMetaFromContext(lines, startIndex, parentTabs) {
  const ctx = [];
  let j = startIndex + 1;

  for (; j < lines.length; j++) {
    const raw = lines[j] ?? '';
    const trimmed = raw.trim();
    const tabs = countTabs(raw);

    if (/^\t*-\s+/.test(raw) && tabs <= parentTabs) break;
    if (headerRe.test(trimmed) && tabs <= parentTabs + 1) break;
    if (trimmed) ctx.push(trimmed);
  }

  if (!ctx.length) return null;
  const joined = ctx.join(' ');
  const looksLikeValueMeta = /Основная\s+конфигурация/i.test(joined)
    && /Файл/i.test(joined)
    && /Значение\s*:/i.test(joined);

  if (!looksLikeValueMeta) return null;

  const normalized = ctx.map((line) => line.startsWith('"') ? line : `"${line}"`);
  const rows = parseMetaPairs(normalized);
  return { rows, nextIndex: j - 1 };
}

function parseReport(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stack = [];
  const chunks = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const tabs = countTabs(raw);
    const trimmed = raw.trim();

    if (/^\t*-\s+/.test(raw)) {
      const nodeText = raw.replace(/^\t*-\s+/, '');
      stack[tabs] = cleanNode(nodeText);
      stack.length = tabs + 1;

      if (/Различаются\s+значения/i.test(nodeText)) {
        const parsedMeta = parseValueMetaFromContext(lines, i, tabs);
        if (parsedMeta?.rows?.length) {
          chunks.push({
            id: `c_${chunks.length + 1}`,
            objectPath: stack.filter(Boolean).join(' / ') || 'Без привязки',
            group: extractGroupName(stack.filter(Boolean).join(' / ') || 'Без привязки'),
            header: cleanNode(nodeText),
            type: 'meta',
            baseType: 'changed',
            block: parsedMeta.rows.map((r) => `"Основная конфигурация: ${r.oldValue}; Файл: ${r.newValue}"`),
            left: [],
            right: [],
            neutral: [],
            metaRows: parsedMeta.rows,
            risk: 'medium',
          });
          i = parsedMeta.nextIndex;
        }
      }
      continue;
    }

    if (!headerRe.test(trimmed)) continue;

    const objectPath = stack.filter(Boolean).join(' / ') || 'Без привязки';
    const baseType = trimmed.startsWith('Изменено:') ? 'changed' : trimmed.includes('основной конфигурации') ? 'mainOnly' : 'fileOnly';

    const block = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const row = (lines[j] ?? '').trimStart();
      if (headerRe.test(row)) break;
      if (/^\t*-\s+/.test(lines[j])) break;
      if (row.startsWith('"') || row.startsWith('< ') || row.startsWith('> ') || row === '') block.push(lines[j]);
      else break;
    }

    const left = [];
    const right = [];
    const neutral = [];
    block.forEach((line) => {
      const t = line.trimStart();
      if (t.startsWith('< ')) left.push(t.slice(2));
      else if (t.startsWith('> ')) right.push(t.slice(2));
      else if (t.startsWith('"')) neutral.push(t);
    });

    const type = classifyChunkType(baseType, neutral);
    const metaRows = type === 'meta' ? parseMetaPairs(neutral) : [];

    const riskScore =
      (baseType === 'changed' ? 6 : 2)
      + Math.min(4, Math.max(left.length, right.length) / 5)
      + (left.length > 0 && right.length > 0 ? 3 : 0)
      + (metaRows.length > 0 ? 1 : 0);

    chunks.push({
      id: `c_${chunks.length + 1}`,
      objectPath,
      group: extractGroupName(objectPath),
      header: trimmed,
      type,
      baseType,
      block,
      left,
      right,
      neutral,
      metaRows,
      risk: riskScore >= 10 ? 'high' : riskScore >= 6 ? 'medium' : 'low',
    });

    i = j - 1;
  }

  return buildGroups(chunks);
}

function buildGroups(chunks) {
  const groupMap = new Map();
  for (const c of chunks) {
    if (!groupMap.has(c.group)) groupMap.set(c.group, new Map());
    const objMap = groupMap.get(c.group);
    if (!objMap.has(c.objectPath)) objMap.set(c.objectPath, []);
    objMap.get(c.objectPath).push(c);
  }

  const groups = [...groupMap.entries()].map(([groupName, objMap]) => {
    const objects = [...objMap.entries()].map(([name, chunksList]) => {
      const stat = { high: 0, medium: 0, low: 0 };
      chunksList.forEach((c) => stat[c.risk] += 1);
      const risk = stat.high ? 'high' : stat.medium ? 'medium' : 'low';
      return { name, chunks: chunksList, ...stat, risk };
    });
    const count = objects.reduce((acc, o) => acc + o.chunks.length, 0);
    return { name: groupName, objects, count };
  });

  return { chunks, groups };
}

function typeLabel(type) {
  if (type === 'changed') return 'Изменено';
  if (type === 'mainOnly') return 'Только в основной';
  if (type === 'fileOnly') return 'Только в файле';
  if (type === 'meta') return 'Параметры/мета';
  return type;
}

function riskLabel(r) { return r === 'high' ? 'Высокий' : r === 'medium' ? 'Средний' : 'Низкий'; }
function escapeHtml(s = '') { return s.replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch])); }

function diffFragments(a = '', b = '') {
  const min = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < min && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const aMid = a.slice(prefix, a.length - suffix || a.length);
  const bMid = b.slice(prefix, b.length - suffix || b.length);
  return {
    a: `${escapeHtml(a.slice(0, prefix))}<span class="diff-del">${escapeHtml(aMid)}</span>${escapeHtml(a.slice(a.length - suffix))}`,
    b: `${escapeHtml(b.slice(0, prefix))}<span class="diff-add">${escapeHtml(bMid)}</span>${escapeHtml(b.slice(b.length - suffix))}`,
  };
}

function renderDiffColumns(chunk) {
  const left = chunk.left.length ? chunk.left : chunk.neutral;
  const right = chunk.right.length ? chunk.right : chunk.neutral;
  const max = Math.max(left.length, right.length);
  const leftRows = [];
  const rightRows = [];

  for (let i = 0; i < max; i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';
    const frag = diffFragments(l, r);
    leftRows.push(frag.a || '&nbsp;');
    rightRows.push(frag.b || '&nbsp;');
  }

  return `
    <div class="row g-2">
      <div class="col-md-6">
        <div class="small text-secondary mb-1">Основная конфигурация</div>
        <pre class="code mono">${leftRows.join('\n')}</pre>
      </div>
      <div class="col-md-6">
        <div class="small text-secondary mb-1">Файл</div>
        <pre class="code mono">${rightRows.join('\n')}</pre>
      </div>
    </div>
  `;
}

function renderMetaTable(chunk) {
  const rows = chunk.metaRows.length ? chunk.metaRows : [{ parameter: 'Параметр', oldValue: '—', newValue: '—' }];
  return `
    <div class="table-responsive">
      <table class="table table-sm table-bordered align-middle mb-0 meta-table">
        <thead class="table-light">
          <tr><th>Параметр</th><th>Было (основная)</th><th>Стало (файл)</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.parameter)}</td>
              <td class="mono"><span class="diff-del">${escapeHtml(r.oldValue || '—')}</span></td>
              <td class="mono"><span class="diff-add">${escapeHtml(r.newValue || '—')}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderChunk(chunk, idx) {
  const content = chunk.type === 'meta' ? renderMetaTable(chunk) : renderDiffColumns(chunk);
  return `
    <div class="accordion-item">
      <h2 class="accordion-header" id="h_${chunk.id}">
        <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#b_${chunk.id}">
          <span class="me-2">#${idx + 1}</span>
          <span class="me-2">${escapeHtml(chunk.header)}</span>
          <span class="badge ms-auto me-2 badge-risk-${chunk.risk}">${riskLabel(chunk.risk)}</span>
          <span class="badge text-bg-secondary">${typeLabel(chunk.type)}</span>
        </button>
      </h2>
      <div id="b_${chunk.id}" class="accordion-collapse collapse" data-bs-parent="#acc_${escapeHtmlAttr(chunk.objectPath)}">
        <div class="accordion-body">${content}</div>
      </div>
    </div>
  `;
}

function escapeHtmlAttr(s = '') { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

function filteredGroups() {
  let groups = state.groups.map((g) => ({ ...g, objects: [...g.objects] }));

  groups = groups.map((g) => ({
    ...g,
    objects: g.objects.map((o) => ({
      ...o,
      chunks: o.chunks.filter((c) => {
        if (state.filters.risk !== 'all' && c.risk !== state.filters.risk) return false;
        if (state.filters.type !== 'all' && c.type !== state.filters.type) return false;
        const hay = `${g.name} ${o.name} ${c.header} ${c.block.join(' ')}`.toLowerCase();
        if (state.filters.search && !hay.includes(state.filters.search.toLowerCase())) return false;
        return true;
      }),
    })).filter((o) => o.chunks.length),
  })).filter((g) => g.objects.length);

  if (state.filters.group !== 'all') groups = groups.filter((g) => g.name === state.filters.group);

  groups.forEach((g) => {
    g.count = g.objects.reduce((acc, o) => acc + o.chunks.length, 0);
    g.objects.forEach((o) => {
      o.high = o.chunks.filter((c) => c.risk === 'high').length;
      o.medium = o.chunks.filter((c) => c.risk === 'medium').length;
      o.low = o.chunks.filter((c) => c.risk === 'low').length;
      o.risk = o.high ? 'high' : o.medium ? 'medium' : 'low';
    });

    if (state.filters.sortBy === 'countAsc') g.objects.sort((a, b) => a.chunks.length - b.chunks.length);
    if (state.filters.sortBy === 'countDesc') g.objects.sort((a, b) => b.chunks.length - a.chunks.length);
    if (state.filters.sortBy === 'nameAsc') g.objects.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  });

  if (state.filters.sortBy === 'countAsc') groups.sort((a, b) => a.count - b.count);
  if (state.filters.sortBy === 'countDesc') groups.sort((a, b) => b.count - a.count);
  if (state.filters.sortBy === 'nameAsc') groups.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return groups;
}

function renderGroupList(groups) {
  el.groupList.innerHTML = groups.map((g) => {
    const active = state.selectedGroup === g.name;
    return `
      <button class="btn w-100 text-start group-item mb-2 ${active ? 'active' : ''}" data-group="${escapeHtml(g.name)}">
        <div class="d-flex justify-content-between">
          <strong>${escapeHtml(g.name)}</strong>
          <span class="badge text-bg-light">${g.count}</span>
        </div>
        <small>${g.objects.length} объектов</small>
      </button>
    `;
  }).join('');
}

function renderDetails(groups) {
  const group = groups.find((g) => g.name === state.selectedGroup) || groups[0];
  if (!group) {
    el.detailsPlaceholder.style.display = '';
    el.details.innerHTML = '';
    return;
  }
  state.selectedGroup = group.name;

  const object = group.objects.find((o) => o.name === state.selectedObject) || group.objects[0];
  if (!object) {
    el.detailsPlaceholder.style.display = '';
    el.details.innerHTML = '';
    return;
  }
  state.selectedObject = object.name;

  el.detailsPlaceholder.style.display = 'none';
  el.details.innerHTML = `
    <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
      <h2 class="h5 m-0">${escapeHtml(group.name)}</h2>
      <span class="badge text-bg-secondary">${group.count} конфликтов</span>
    </div>

    <div class="list-group mb-3">
      ${group.objects.map((o) => `
        <button class="list-group-item list-group-item-action ${o.name === object.name ? 'active' : ''}" data-object="${escapeHtml(o.name)}">
          <div class="d-flex justify-content-between">
            <span>${escapeHtml(o.name)}</span>
            <span class="badge badge-risk-${o.risk}">${o.chunks.length}</span>
          </div>
        </button>
      `).join('')}
    </div>

    <h3 class="h6">${escapeHtml(object.name)}</h3>
    <div class="accordion" id="acc_${escapeHtmlAttr(object.name)}">
      ${object.chunks.map((c, i) => renderChunk(c, i)).join('')}
    </div>
  `;
}

function fillGroupFilter() {
  const opts = ['<option value="all">Все группы</option>']
    .concat(state.groups.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`));
  el.groupFilter.innerHTML = opts.join('');
}

function render() {
  const groups = filteredGroups();
  const total = groups.reduce((acc, g) => acc + g.count, 0);
  el.summary.textContent = `Файл: ${state.reportName || '—'} · Групп: ${groups.length} · Конфликтов: ${total}`;
  renderGroupList(groups);
  renderDetails(groups);
}

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = decodeTextFromBuffer(await file.arrayBuffer());
  const parsed = parseReport(text);
  state.reportName = file.name;
  state.chunks = parsed.chunks;
  state.groups = parsed.groups;
  state.selectedGroup = state.groups[0]?.name || null;
  state.selectedObject = state.groups[0]?.objects[0]?.name || null;
  fillGroupFilter();
  render();
});

el.groupList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-group]');
  if (!btn) return;
  state.selectedGroup = btn.dataset.group;
  state.selectedObject = null;
  render();
});

el.details.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-object]');
  if (!btn) return;
  state.selectedObject = btn.dataset.object;
  render();
});

el.searchInput.addEventListener('input', (e) => { state.filters.search = e.target.value; render(); });
el.groupFilter.addEventListener('change', (e) => { state.filters.group = e.target.value; render(); });
el.typeFilter.addEventListener('change', (e) => { state.filters.type = e.target.value; render(); });
el.riskFilter.addEventListener('change', (e) => { state.filters.risk = e.target.value; render(); });
el.sortBy.addEventListener('change', (e) => { state.filters.sortBy = e.target.value; render(); });

render();
