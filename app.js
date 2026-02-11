const state = {
  reportName: '',
  chunks: [],
  objects: [],
  selectedObject: null,
  filters: { search: '', risk: 'all' },
};

const el = {
  fileInput: document.getElementById('fileInput'),
  searchInput: document.getElementById('searchInput'),
  riskFilter: document.getElementById('riskFilter'),
  objectList: document.getElementById('objectList'),
  details: document.getElementById('details'),
  detailsPlaceholder: document.getElementById('detailsPlaceholder'),
  summary: document.getElementById('summary'),
  exportBtn: document.getElementById('exportBtn'),
  saveSessionBtn: document.getElementById('saveSessionBtn'),
  loadSessionBtn: document.getElementById('loadSessionBtn'),
  sessionInput: document.getElementById('sessionInput'),
};

const headerRe = /^(Изменено:\s*\d+\s*-\s*\d+|Объект присутствует только в основной конфигурации:\s*\d+\s*-\s*\d+|Объект присутствует только в файле:\s*\d+\s*-\s*\d+)/;

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

function parseReport(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stack = [];
  const chunks = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const tabs = (raw.match(/^\t*/) || [''])[0].length;
    const trimmed = raw.trim();

    if (/^\t*-\s+/.test(raw)) {
      const nodeText = raw.replace(/^\t*-\s+/, '');
      stack[tabs] = cleanNode(nodeText);
      stack.length = tabs + 1;
      continue;
    }

    if (!headerRe.test(trimmed)) continue;

    const currentPath = stack.filter(Boolean).join(' / ') || 'Без привязки';
    const type = trimmed.startsWith('Изменено:') ? 'changed' : trimmed.includes('основной конфигурации') ? 'mainOnly' : 'fileOnly';

    const block = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const row = (lines[j] ?? '').trimStart();
      if (headerRe.test(row)) break;
      if (/^-\s+|^\t*-\s+/.test(lines[j])) break;
      if (row === '' && j + 1 < lines.length) {
        const next = (lines[j + 1] ?? '').trimStart();
        if (!next.startsWith('"') && !next.startsWith('< ') && !next.startsWith('> ')) break;
      }
      if (row.startsWith('"') || row.startsWith('< ') || row.startsWith('> ') || row === '') {
        block.push(lines[j]);
      } else {
        break;
      }
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

    const riskScore =
      (type === 'changed' ? 6 : 2)
      + Math.min(4, Math.max(left.length, right.length) / 5)
      + (left.length > 0 && right.length > 0 ? 3 : 0)
      + (neutral.length > 5 ? 1 : 0);

    const risk = riskScore >= 10 ? 'high' : riskScore >= 6 ? 'medium' : 'low';

    chunks.push({
      id: `c_${chunks.length + 1}`,
      objectPath: currentPath,
      header: trimmed,
      type,
      block,
      left,
      right,
      neutral,
      risk,
      resolution: type === 'fileOnly' ? 'right' : 'left',
      customText: '',
    });

    i = j - 1;
  }

  const byObject = new Map();
  for (const c of chunks) {
    if (!byObject.has(c.objectPath)) byObject.set(c.objectPath, { name: c.objectPath, chunks: [], high: 0, medium: 0, low: 0 });
    const obj = byObject.get(c.objectPath);
    obj.chunks.push(c);
    obj[c.risk] += 1;
  }

  const objects = [...byObject.values()].map((obj) => {
    const risk = obj.high ? 'high' : obj.medium ? 'medium' : 'low';
    return { ...obj, risk };
  }).sort((a, b) => b.chunks.length - a.chunks.length);

  return { chunks, objects, totalLines: lines.length };
}

function render() {
  const filtered = state.objects.filter((o) => {
    const txt = `${o.name} ${o.chunks.map((c) => `${c.header} ${c.block.join(' ')}`).join(' ')}`.toLowerCase();
    if (state.filters.search && !txt.includes(state.filters.search.toLowerCase())) return false;
    if (state.filters.risk !== 'all' && o.risk !== state.filters.risk) return false;
    return true;
  });

  el.objectList.innerHTML = filtered.map((o) => `
    <button class="list-group-item list-group-item-action ${state.selectedObject === o.name ? 'active' : ''}" data-object="${escapeHtml(o.name)}">
      <div class="d-flex justify-content-between align-items-start">
        <div class="text-start">
          <div>${escapeHtml(o.name)}</div>
          <small class="text-secondary">Конфликтов: ${o.chunks.length}</small>
        </div>
        <span class="badge badge-risk-${o.risk}">${riskLabel(o.risk)}</span>
      </div>
    </button>
  `).join('');

  const total = state.chunks.length;
  const unresolved = state.chunks.filter(c => c.resolution === 'pending').length;
  el.summary.textContent = `Файл: ${state.reportName || '—'} · Конфликтов: ${total} · Неразрешённых: ${unresolved}`;

  if (!state.selectedObject && filtered.length) state.selectedObject = filtered[0].name;
  const obj = state.objects.find((o) => o.name === state.selectedObject);

  if (!obj) {
    el.detailsPlaceholder.style.display = '';
    el.details.innerHTML = '';
  } else {
    el.detailsPlaceholder.style.display = 'none';
    el.details.innerHTML = `
      <h2 class="h5 mb-3">${escapeHtml(obj.name)}</h2>
      ${obj.chunks.map(renderChunk).join('')}
    `;
  }

  el.exportBtn.disabled = state.chunks.length === 0;
}

function renderChunk(c) {
  return `
    <section class="chunk p-3 mb-3" id="${c.id}">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <strong>${escapeHtml(c.header)}</strong>
        <span class="badge badge-risk-${c.risk}">${riskLabel(c.risk)}</span>
      </div>
      <div class="row g-2">
        <div class="col-md-6">
          <div class="small text-secondary mb-1">Основная конфигурация</div>
          <pre class="code">${escapeHtml((c.left.length ? c.left : c.neutral).join('\n')) || '—'}</pre>
        </div>
        <div class="col-md-6">
          <div class="small text-secondary mb-1">Файл</div>
          <pre class="code">${escapeHtml((c.right.length ? c.right : c.neutral).join('\n')) || '—'}</pre>
        </div>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-2">
        <button class="btn btn-sm ${c.resolution === 'left' ? 'btn-primary' : 'btn-outline-primary'}" data-act="resolve" data-id="${c.id}" data-value="left">Оставить левую</button>
        <button class="btn btn-sm ${c.resolution === 'right' ? 'btn-primary' : 'btn-outline-primary'}" data-act="resolve" data-id="${c.id}" data-value="right">Оставить правую</button>
        <button class="btn btn-sm ${c.resolution === 'both' ? 'btn-primary' : 'btn-outline-primary'}" data-act="resolve" data-id="${c.id}" data-value="both">Склеить</button>
        <button class="btn btn-sm ${c.resolution === 'pending' ? 'btn-warning' : 'btn-outline-warning'}" data-act="resolve" data-id="${c.id}" data-value="pending">Отложить</button>
      </div>
    </section>
  `;
}

function riskLabel(r) { return r === 'high' ? 'Высокий' : r === 'medium' ? 'Средний' : 'Низкий'; }
function escapeHtml(s = '') { return s.replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch])); }

function exportResolved() {
  const out = [];
  out.push(`# RESOLVED: ${state.reportName}`);
  out.push(`# chunks: ${state.chunks.length}`);
  state.objects.forEach((obj) => {
    out.push(`\n## ${obj.name}`);
    obj.chunks.forEach((c, idx) => {
      out.push(`\n### ${idx + 1}. ${c.header}`);
      const left = c.left.length ? c.left : c.neutral;
      const right = c.right.length ? c.right : c.neutral;
      let lines = [];
      if (c.resolution === 'left') lines = left;
      else if (c.resolution === 'right') lines = right;
      else if (c.resolution === 'both') lines = [...left, ...right];
      else lines = ['[НЕ РАЗРЕШЕНО]'];
      out.push(...(lines.length ? lines : ['[ПУСТО]']));
    });
  });

  const blob = new Blob([out.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.reportName || 'report').replace(/\.txt$/i, '')}.resolved.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const text = decodeTextFromBuffer(buffer);
  const parsed = parseReport(text);
  state.reportName = file.name;
  state.chunks = parsed.chunks;
  state.objects = parsed.objects;
  state.selectedObject = state.objects[0]?.name || null;
  render();
});

el.objectList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-object]');
  if (!btn) return;
  state.selectedObject = btn.dataset.object;
  render();
});

el.details.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="resolve"]');
  if (!btn) return;
  const c = state.chunks.find((x) => x.id === btn.dataset.id);
  if (!c) return;
  c.resolution = btn.dataset.value;
  render();
});

el.searchInput.addEventListener('input', (e) => { state.filters.search = e.target.value; render(); });
el.riskFilter.addEventListener('change', (e) => { state.filters.risk = e.target.value; render(); });
el.exportBtn.addEventListener('click', exportResolved);

el.saveSessionBtn.addEventListener('click', () => {
  const payload = JSON.stringify({ reportName: state.reportName, chunks: state.chunks, objects: state.objects }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.reportName || 'session').replace(/\.txt$/i, '')}.session.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

el.loadSessionBtn.addEventListener('click', () => el.sessionInput.click());
el.sessionInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const payload = JSON.parse(await file.text());
  state.reportName = payload.reportName || file.name;
  state.chunks = payload.chunks || [];
  state.objects = payload.objects || [];
  state.selectedObject = state.objects[0]?.name || null;
  render();
});

render();
