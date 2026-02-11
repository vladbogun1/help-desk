const state = {
  reportName: '',
  chunks: [],
  objects: [],
  selectedObject: null,
  expandedNodes: { root: true },
  filters: { search: '', risk: 'all', type: 'all', group: 'all', sortBy: 'countDesc', excludeMainOnly: false },
};

const el = {
  fileInput: document.getElementById('fileInput'),
  searchInput: document.getElementById('searchInput'),
  groupFilter: document.getElementById('groupFilter'),
  typeFilter: document.getElementById('typeFilter'),
  riskFilter: document.getElementById('riskFilter'),
  sortBy: document.getElementById('sortBy'),
  hideMainOnlyToggle: document.getElementById('hideMainOnlyToggle'),
  treeList: document.getElementById('treeList'),
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

function parsePathInfo(objectPath = '') {
  const segments = objectPath
    .split(' / ')
    .map((s) => s.replace(/^[→←↕]\s*/, '').trim())
    .filter(Boolean);

  const configSegment = segments.find((s) => /^Конфигурация\./i.test(s));
  const configName = configSegment?.replace(/^Конфигурация\./i, '').trim() || 'Без имени';

  const dataSegments = segments.filter((s) => !/^Конфигурация\./i.test(s));
  const treeSegments = [];

  dataSegments.forEach((segment) => {
    const dottedParts = segment.split('.').map((x) => x.trim()).filter(Boolean);
    if (dottedParts.length) treeSegments.push(...dottedParts);
    else treeSegments.push(segment);
  });

  const objectType = treeSegments[0] || extractGroupName(objectPath);
  const objectName = treeSegments[treeSegments.length - 1] || dataSegments[0] || 'Без объекта';

  return {
    configRoot: 'Конфигурация',
    configName,
    objectType,
    objectName,
    objectLabel: treeSegments.join(' / ') || `${objectType}.${objectName}`,
    treeSegments,
  };
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
          const objectPath = stack.filter(Boolean).join(' / ') || 'Без привязки';
          chunks.push({
            id: `c_${chunks.length + 1}`,
            objectPath,
            group: extractGroupName(objectPath),
            pathInfo: parsePathInfo(objectPath),
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
      pathInfo: parsePathInfo(objectPath),
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

  return buildObjects(chunks);
}

function buildObjects(chunks) {
  const objectMap = new Map();

  for (const chunk of chunks) {
    const key = chunk.objectPath;
    if (!objectMap.has(key)) {
      objectMap.set(key, {
        id: `o_${objectMap.size + 1}`,
        path: key,
        pathInfo: chunk.pathInfo,
        chunks: [],
      });
    }
    objectMap.get(key).chunks.push(chunk);
  }

  const objects = [...objectMap.values()].map((obj) => {
    const stat = { high: 0, medium: 0, low: 0 };
    obj.chunks.forEach((c) => { stat[c.risk] += 1; });
    return {
      ...obj,
      high: stat.high,
      medium: stat.medium,
      low: stat.low,
      risk: stat.high ? 'high' : stat.medium ? 'medium' : 'low',
      count: obj.chunks.length,
    };
  });

  return { chunks, objects };
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
function escapeHtmlAttr(s = '') { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }

function nodeKey(level, configName = '', objectType = '') {
  if (level === 'root') return 'root';
  if (level === 'config') return `config:${configName}`;
  if (level === 'type') return `type:${configName}:${objectType}`;
  return '';
}

function isExpanded(key) {
  return Boolean(state.expandedNodes[key]);
}

function setExpanded(key, value) {
  state.expandedNodes[key] = value;
}

function collapseNodeWithDescendants(key) {
  state.expandedNodes[key] = false;
  Object.keys(state.expandedNodes)
    .filter((k) => k.startsWith(`${key}/`))
    .forEach((k) => { state.expandedNodes[k] = false; });
}

function initExpandedState(objects) {
  const expanded = { root: true };
  const configNames = [...new Set((objects || []).map((o) => o.pathInfo?.configName).filter(Boolean))];
  configNames.forEach((name) => {
    expanded[nodeKey('config', name)] = true;
  });
  state.expandedNodes = expanded;
}

function ensureObjectPathExpanded(objectItem) {
  if (!objectItem) return;
  setExpanded(nodeKey('root'), true);
  setExpanded(nodeKey('config', objectItem.pathInfo.configName), true);

  const segments = objectItem.pathInfo.treeSegments || [];
  let currentKey = nodeKey('config', objectItem.pathInfo.configName);
  for (let i = 0; i < segments.length; i++) {
    currentKey = `${currentKey}/${segments[i]}`;
    setExpanded(currentKey, true);
  }
}

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
  let left = [];
  let right = [];

  if (chunk.baseType === 'mainOnly') {
    left = chunk.neutral.length ? chunk.neutral : chunk.left;
    right = [];
  } else if (chunk.baseType === 'fileOnly') {
    left = [];
    right = chunk.neutral.length ? chunk.neutral : chunk.right;
  } else {
    left = chunk.left.length ? chunk.left : chunk.neutral;
    right = chunk.right.length ? chunk.right : chunk.neutral;
  }

  const max = Math.max(left.length, right.length, 1);
  const leftRows = [];
  const rightRows = [];

  for (let i = 0; i < max; i++) {
    const l = left[i] ?? '';
    const r = right[i] ?? '';

    if (chunk.baseType === 'mainOnly') {
      leftRows.push(escapeHtml(l) || '&nbsp;');
      rightRows.push('&nbsp;');
      continue;
    }

    if (chunk.baseType === 'fileOnly') {
      leftRows.push('&nbsp;');
      rightRows.push(escapeHtml(r) || '&nbsp;');
      continue;
    }

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
  const isOpen = idx === 0;
  return `
    <div class="accordion-item">
      <h2 class="accordion-header" id="h_${chunk.id}">
        <button class="accordion-button ${isOpen ? '' : 'collapsed'}" type="button" data-bs-toggle="collapse" data-bs-target="#b_${chunk.id}">
          <span class="me-2">#${idx + 1}</span>
          <span class="me-2">${escapeHtml(chunk.header)}</span>
          <span class="badge ms-auto me-2 badge-risk-${chunk.risk}">${riskLabel(chunk.risk)}</span>
          <span class="badge text-bg-secondary">${typeLabel(chunk.type)}</span>
        </button>
      </h2>
      <div id="b_${chunk.id}" class="accordion-collapse collapse ${isOpen ? 'show' : ''}">
        <div class="accordion-body">${content}</div>
      </div>
    </div>
  `;
}

function filteredObjects() {
  let objects = state.objects.map((o) => ({ ...o, chunks: [...o.chunks] }));

  objects = objects.map((o) => ({
    ...o,
    chunks: o.chunks.filter((c) => {
      if (state.filters.risk !== 'all' && c.risk !== state.filters.risk) return false;
      if (state.filters.type !== 'all' && c.type !== state.filters.type) return false;
      if (state.filters.excludeMainOnly && c.baseType === 'mainOnly') return false;
      if (state.filters.group !== 'all' && o.pathInfo.objectType !== state.filters.group) return false;
      const hay = `${o.pathInfo.configName} ${o.pathInfo.objectType} ${o.pathInfo.objectName} ${o.path} ${c.header} ${c.block.join(' ')}`.toLowerCase();
      if (state.filters.search && !hay.includes(state.filters.search.toLowerCase())) return false;
      return true;
    }),
  })).filter((o) => o.chunks.length);

  objects.forEach((o) => {
    o.count = o.chunks.length;
    o.high = o.chunks.filter((c) => c.risk === 'high').length;
    o.medium = o.chunks.filter((c) => c.risk === 'medium').length;
    o.low = o.chunks.filter((c) => c.risk === 'low').length;
    o.risk = o.high ? 'high' : o.medium ? 'medium' : 'low';
  });

  if (state.filters.sortBy === 'countAsc') objects.sort((a, b) => a.count - b.count);
  if (state.filters.sortBy === 'countDesc') objects.sort((a, b) => b.count - a.count);
  if (state.filters.sortBy === 'nameAsc') objects.sort((a, b) => a.pathInfo.objectName.localeCompare(b.pathInfo.objectName, 'ru'));

  return objects;
}

function buildTree(objects) {
  const root = { key: nodeKey('root'), name: 'Конфигурация', count: 0, children: [], objects: [] };
  const configMap = new Map();

  for (const obj of objects) {
    const configName = obj.pathInfo.configName || 'Без имени';

    if (!configMap.has(configName)) {
      const cfgNode = {
        key: nodeKey('config', configName),
        name: configName,
        count: 0,
        children: [],
        childMap: new Map(),
        objects: [],
      };
      configMap.set(configName, cfgNode);
      root.children.push(cfgNode);
    }

    const cfgNode = configMap.get(configName);
    cfgNode.count += obj.count;
    root.count += obj.count;

    let currentNode = cfgNode;
    const segments = obj.pathInfo.treeSegments || [];

    segments.forEach((segment) => {
      if (!currentNode.childMap.has(segment)) {
        const childNode = {
          key: `${currentNode.key}/${segment}`,
          name: segment,
          count: 0,
          children: [],
          childMap: new Map(),
          objects: [],
        };
        currentNode.childMap.set(segment, childNode);
        currentNode.children.push(childNode);
      }

      currentNode = currentNode.childMap.get(segment);
      currentNode.count += obj.count;
    });

    currentNode.objects.push(obj);
  }

  const sortNodes = (nodes) => {
    nodes.forEach((node) => {
      node.objects.sort((a, b) => {
        if (state.filters.sortBy === 'countAsc') return a.count - b.count;
        if (state.filters.sortBy === 'countDesc') return b.count - a.count;
        return a.pathInfo.objectName.localeCompare(b.pathInfo.objectName, 'ru');
      });

      node.children = node.children.filter((child) => child.count > 0);
      sortNodes(node.children);

      if (state.filters.sortBy === 'countAsc') node.children.sort((a, b) => a.count - b.count);
      if (state.filters.sortBy === 'countDesc') node.children.sort((a, b) => b.count - a.count);
      if (state.filters.sortBy === 'nameAsc') node.children.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      delete node.childMap;
    });
  };

  sortNodes(root.children);
  return root;
}

function renderTreeNode(node, selectedPath) {
  const expanded = isExpanded(node.key);
  const hasNested = node.children.length > 0;
  const hasObjects = node.objects.length > 0;

  const keyAttr = encodeURIComponent(node.key);
  const singleLeafObject = !hasNested
    && node.objects.length === 1
    && node.objects[0].pathInfo.objectName === node.name;
  const hasChildren = hasNested || (hasObjects && !singleLeafObject);

  const lineClasses = ['tree-line', 'tree-toggle'];
  if (node.key === nodeKey('root')) lineClasses.push('fw-semibold');
  if (singleLeafObject && node.objects[0].path === selectedPath) lineClasses.push('tree-line-active');

  return `
    <div class="tree-node mt-1">
      <button
        type="button"
        class="${lineClasses.join(' ')}"
        ${hasChildren ? `data-toggle-key="${keyAttr}"` : ''}
        ${singleLeafObject ? `data-object-path="${escapeHtml(node.objects[0].path)}"` : ''}
      >
        <span class="tree-caret">${hasChildren ? (expanded ? '▾' : '▸') : '·'}</span>
        <span class="tree-label">${escapeHtml(node.name)}</span>
        <span class="badge text-bg-light ms-1">${node.count}</span>
      </button>
      <div class="tree-children ${expanded ? '' : 'd-none'}">
        ${node.children.map((child) => renderTreeNode(child, selectedPath)).join('')}
        ${node.objects.length && !singleLeafObject ? `
          <div class="tree-leaf-list mt-1">
            ${node.objects.map((obj) => `
              <button class="btn btn-sm w-100 text-start tree-object ${obj.path === selectedPath ? 'active' : ''}" data-object-path="${escapeHtml(obj.path)}">
                <div class="d-flex justify-content-between align-items-center gap-2">
                  <span class="tree-object-label">${escapeHtml(obj.pathInfo.objectName)}</span>
                  <span class="badge badge-risk-${obj.risk}">${obj.count}</span>
                </div>
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderTree(tree) {
  const selectedPath = state.selectedObject;
  el.treeList.innerHTML = renderTreeNode(tree, selectedPath);
}

function renderDetails(objects) {
  const object = objects.find((o) => o.path === state.selectedObject) || objects[0];
  if (!object) {
    el.detailsPlaceholder.style.display = '';
    el.details.innerHTML = '';
    return;
  }

  state.selectedObject = object.path;
  el.detailsPlaceholder.style.display = 'none';

  el.details.innerHTML = `
    <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
      <h2 class="h5 m-0">${escapeHtml(object.pathInfo.objectLabel)}</h2>
      <span class="badge text-bg-secondary">${object.count} конфликтов</span>
    </div>

    <div class="small text-secondary mb-3">
      ${escapeHtml(object.pathInfo.configRoot)} / ${escapeHtml(object.pathInfo.configName)} / ${escapeHtml(object.pathInfo.objectType)} / ${escapeHtml(object.pathInfo.objectName)}
    </div>

    <div class="accordion" id="acc_${escapeHtmlAttr(object.path)}">
      ${object.chunks.map((c, i) => renderChunk(c, i)).join('')}
    </div>
  `;
}

function fillGroupFilter() {
  const types = [...new Set(state.objects.map((o) => o.pathInfo.objectType))].sort((a, b) => a.localeCompare(b, 'ru'));
  const opts = ['<option value="all">Все типы объектов</option>']
    .concat(types.map((typeName) => `<option value="${escapeHtml(typeName)}">${escapeHtml(typeName)}</option>`));
  el.groupFilter.innerHTML = opts.join('');
}

function render() {
  const objects = filteredObjects();
  const tree = buildTree(objects);
  const total = objects.reduce((acc, o) => acc + o.count, 0);

  el.summary.textContent = `Файл: ${state.reportName || '—'} · Конфигураций: ${tree.children.length} · Объектов: ${objects.length} · Конфликтов: ${total}`;

  renderTree(tree);
  renderDetails(objects);
}

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const text = decodeTextFromBuffer(await file.arrayBuffer());
  const parsed = parseReport(text);
  state.reportName = file.name;
  state.chunks = parsed.chunks;
  state.objects = parsed.objects;
  state.selectedObject = state.objects[0]?.path || null;
  initExpandedState(state.objects);
  fillGroupFilter();
  render();
});

el.treeList.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-toggle-key]');
  if (toggleBtn) {
    const key = decodeURIComponent(toggleBtn.dataset.toggleKey);
    if (isExpanded(key)) collapseNodeWithDescendants(key);
    else setExpanded(key, true);
    render();
    return;
  }

  const btn = e.target.closest('[data-object-path]');
  if (!btn) return;
  state.selectedObject = btn.dataset.objectPath;
  const selected = state.objects.find((o) => o.path === state.selectedObject);
  ensureObjectPathExpanded(selected);
  render();
});

el.searchInput.addEventListener('input', (e) => { state.filters.search = e.target.value; render(); });
el.groupFilter.addEventListener('change', (e) => { state.filters.group = e.target.value; render(); });
el.typeFilter.addEventListener('change', (e) => { state.filters.type = e.target.value; render(); });
el.riskFilter.addEventListener('change', (e) => { state.filters.risk = e.target.value; render(); });
el.sortBy.addEventListener('change', (e) => { state.filters.sortBy = e.target.value; render(); });
el.hideMainOnlyToggle.addEventListener('change', (e) => { state.filters.excludeMainOnly = e.target.checked; render(); });

render();
