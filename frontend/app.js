const API_BASE = window.BACKEND_URL || 'http://localhost:8080';

const state = {
  reportName: '', chunks: [], objects: [], selectedObject: null,
  expandedNodes: { root: true },
  filters: { search: '', risk: 'all', type: 'all', group: 'all', sortBy: 'countDesc', excludeMainOnly: false },
  notes: {}, currentJobId: null, objectDiffCache: new Map(),
};

const el = {
  leftInput: document.getElementById('leftFileInput'), rightInput: document.getElementById('rightFileInput'),
  compareBtn: document.getElementById('compareBtn'), uploadStatus: document.getElementById('uploadStatus'),
  searchInput: document.getElementById('searchInput'), groupFilter: document.getElementById('groupFilter'), typeFilter: document.getElementById('typeFilter'),
  riskFilter: document.getElementById('riskFilter'), sortBy: document.getElementById('sortBy'), hideMainOnlyToggle: document.getElementById('hideMainOnlyToggle'),
  treeList: document.getElementById('treeList'), details: document.getElementById('details'), detailsPlaceholder: document.getElementById('detailsPlaceholder'), summary: document.getElementById('summary'),
};

const riskLabel = (r) => r === 'high' ? 'Высокий' : r === 'medium' ? 'Средний' : 'Низкий';
const typeLabel = (type) => ({ changed: 'Изменено', mainOnly: 'Только в основной', fileOnly: 'Только в файле', meta: 'Параметры/мета' }[type] || type);
const escapeHtml = (s = '') => s.replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
const escapeHtmlAttr = (s = '') => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function parsePathInfo(path = '') {
  const seg = path.split('/').filter(Boolean);
  return { configRoot: 'Конфигурация', configName: 'Сравнение', objectType: seg[0] || 'Прочее', objectName: seg[1] || path, objectLabel: path.replaceAll('/', ' / '), treeSegments: seg };
}

function mapChangeType(changeType) { return changeType === 'REMOVED' ? 'mainOnly' : changeType === 'ADDED' ? 'fileOnly' : 'changed'; }
function mapRisk(changeType, isBinary) { if (isBinary || changeType === 'CHANGED') return 'high'; if (changeType === 'ADDED' || changeType === 'REMOVED') return 'medium'; return 'low'; }

async function callApi(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, options);
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
  return resp.json();
}

async function startCompare() {
  const left = el.leftInput.files[0]; const right = el.rightInput.files[0];
  if (!left || !right) { el.uploadStatus.textContent = 'Выберите оба файла .cf'; return; }
  const fd = new FormData(); fd.append('leftFile', left); fd.append('rightFile', right);
  el.compareBtn.disabled = true;
  try {
    const { jobId } = await callApi('/api/compare', { method: 'POST', body: fd });
    state.currentJobId = jobId; el.uploadStatus.textContent = 'Задача запущена...';
    await pollJob(jobId);
    await loadObjects(jobId);
  } catch (e) { el.uploadStatus.textContent = `Ошибка: ${e.message}`; }
  finally { el.compareBtn.disabled = false; }
}

async function pollJob(jobId) {
  for (;;) {
    const j = await callApi(`/api/compare/${jobId}`);
    el.uploadStatus.textContent = `${j.status}: ${j.progress}% — ${j.stage}`;
    if (j.status === 'DONE') { state.reportName = `job:${jobId}`; return; }
    if (j.status === 'FAILED') throw new Error(j.error || 'Compare job failed');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function loadObjects(jobId) {
  const data = await callApi(`/api/compare/${jobId}/objects?page=0&size=5000`);
  state.objects = data.content.map((o, idx) => {
    const chunks = o.changedFiles.map((f, i) => ({ id: `c_${idx}_${i}`, objectId: o.id, objectPath: o.path, header: `${f.changeType}: ${f.path}`,
      type: mapChangeType(f.changeType), baseType: mapChangeType(f.changeType), left: [], right: [], neutral: [f.path], block: [f.path], metaRows: [], risk: mapRisk(f.changeType, f.isBinary), diffPath: f.path, isBinary: f.isBinary }));
    const stat = { high: chunks.filter(c=>c.risk==='high').length, medium: chunks.filter(c=>c.risk==='medium').length, low: chunks.filter(c=>c.risk==='low').length };
    return { id: o.id, path: o.path, pathInfo: parsePathInfo(o.path), chunks, count: chunks.length, ...stat, risk: stat.high ? 'high' : stat.medium ? 'medium' : 'low' };
  });
  state.selectedObject = state.objects[0]?.path || null;
  fillGroupFilter(); render();
}

function nodeKey(level, configName = '') { return level === 'root' ? 'root' : `config:${configName}`; }
function buildTree(objects) { return { key:'root', name:'Конфигурация', count:objects.reduce((a,o)=>a+o.count,0), children:[{ key:'config:Сравнение', name:'Сравнение', count:objects.reduce((a,o)=>a+o.count,0), children:[], objects }] , objects:[]}; }
function isExpanded(key){ return state.expandedNodes[key] !== false; }
function setExpanded(key,v){ state.expandedNodes[key]=v; }

function filteredObjects() {
  return state.objects.filter((o) => {
    const nameOk = !state.filters.search || `${o.path} ${o.chunks.map(c=>c.header).join(' ')}`.toLowerCase().includes(state.filters.search.toLowerCase());
    const groupOk = state.filters.group === 'all' || o.pathInfo.objectType === state.filters.group;
    return nameOk && groupOk;
  }).map((o)=> ({...o, chunks:o.chunks.filter(c => (state.filters.risk==='all'||c.risk===state.filters.risk) && (state.filters.type==='all'||c.type===state.filters.type) && (!state.filters.excludeMainOnly||c.baseType!=='mainOnly'))})).filter(o=>o.chunks.length);
}

function renderTreeNode(node, selectedPath) {
  const expanded = isExpanded(node.key); const hasChildren = node.children?.length || node.objects?.length;
  return `<div class="tree-node mt-1"><button type="button" class="tree-line tree-toggle ${node.key==='root'?'fw-semibold':''}" ${hasChildren?`data-toggle-key="${encodeURIComponent(node.key)}"`:''}><span class="tree-caret">${hasChildren?(expanded?'▾':'▸'):'·'}</span><span class="tree-label">${escapeHtml(node.name)}</span><span class="badge text-bg-light ms-1">${node.count}</span></button><div class="tree-children ${expanded?'':'d-none'}">${(node.children||[]).map((ch)=>renderTreeNode(ch,selectedPath)).join('')}${(node.objects||[]).map((obj)=>`<button class="btn btn-sm w-100 text-start tree-object ${obj.path===selectedPath?'active':''}" data-object-path="${escapeHtml(obj.path)}"><div class="d-flex justify-content-between"><span>${escapeHtml(obj.pathInfo.objectName)}</span><span class="badge badge-risk-${obj.risk}">${obj.count}</span></div></button>`).join('')}</div></div>`;
}
function renderTree(tree){ el.treeList.innerHTML = renderTreeNode(tree,state.selectedObject); }

function diffFragments(a='',b=''){ return {a: escapeHtml(a), b: escapeHtml(b)}; }
function renderDiffColumns(chunk){ const left=chunk.left.length?chunk.left:['']; const right=chunk.right.length?chunk.right:['']; const max=Math.max(left.length,right.length,1); const l=[]; const r=[]; for(let i=0;i<max;i++){ const f=diffFragments(left[i]||'',right[i]||''); l.push(f.a||'&nbsp;'); r.push(f.b||'&nbsp;'); } return `<div class="row g-2"><div class="col-md-6"><div class="small text-secondary mb-1">Основная конфигурация</div><pre class="code mono">${l.join('\n')}</pre></div><div class="col-md-6"><div class="small text-secondary mb-1">Файл</div><pre class="code mono">${r.join('\n')}</pre></div></div>`; }
function renderChunk(chunk, idx){ const content = chunk.isBinary ? `<div class="alert alert-secondary">Binary changed: ${escapeHtml(chunk.diffPath)}</div>` : renderDiffColumns(chunk); return `<div class="accordion-item"><h2 class="accordion-header" id="h_${chunk.id}"><button class="accordion-button ${idx===0?'':'collapsed'}" type="button" data-bs-toggle="collapse" data-bs-target="#b_${chunk.id}"><span class="me-2">#${idx+1}</span><span class="me-2">${escapeHtml(chunk.header)}</span><span class="badge ms-auto me-2 badge-risk-${chunk.risk}">${riskLabel(chunk.risk)}</span><span class="badge text-bg-secondary">${typeLabel(chunk.type)}</span></button></h2><div id="b_${chunk.id}" class="accordion-collapse collapse ${idx===0?'show':''}"><div class="accordion-body">${content}</div></div></div>`; }

async function hydrateObjectDiffs(obj) {
  if (state.objectDiffCache.has(obj.id) || !state.currentJobId) return;
  for (const chunk of obj.chunks) {
    if (chunk.isBinary) continue;
    try {
      const d = await callApi(`/api/compare/${state.currentJobId}/diff?path=${encodeURIComponent(chunk.diffPath)}`);
      const lines = (d.diff || '').split('\n');
      chunk.left = lines.filter((x) => x.startsWith('-') && !x.startsWith('---')).map((x) => x.slice(1));
      chunk.right = lines.filter((x) => x.startsWith('+') && !x.startsWith('+++')).map((x) => x.slice(1));
    } catch { chunk.left = ['<error loading diff>']; chunk.right = ['<error loading diff>']; }
  }
  state.objectDiffCache.set(obj.id, true);
}

async function renderDetails(objects) {
  const object = objects.find((o) => o.path === state.selectedObject) || objects[0];
  if (!object) { el.detailsPlaceholder.style.display=''; el.details.innerHTML=''; return; }
  state.selectedObject = object.path; el.detailsPlaceholder.style.display='none';
  await hydrateObjectDiffs(object);
  el.details.innerHTML = `<div class="d-flex flex-wrap gap-2 align-items-center mb-3"><h2 class="h5 m-0">${escapeHtml(object.pathInfo.objectLabel)}</h2><span class="badge text-bg-secondary">${object.count} изменений</span></div><div class="small text-secondary mb-3">${escapeHtml(object.path)}</div><div class="accordion" id="acc_${escapeHtmlAttr(object.path)}">${object.chunks.map((c,i)=>renderChunk(c,i)).join('')}</div>`;
}

function fillGroupFilter(){ const types=[...new Set(state.objects.map((o)=>o.pathInfo.objectType))].sort(); el.groupFilter.innerHTML=['<option value="all">Все типы объектов</option>',...types.map((t)=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>` )].join(''); }
async function render(){ const objects=filteredObjects(); const tree=buildTree(objects); const total=objects.reduce((a,o)=>a+o.count,0); el.summary.textContent=`Файл: ${state.reportName||'—'} · Конфигураций: ${tree.children.length} · Объектов: ${objects.length} · Конфликтов: ${total}`; renderTree(tree); await renderDetails(objects); }

el.compareBtn.addEventListener('click', startCompare);
el.treeList.addEventListener('click', async (e)=>{ const t=e.target.closest('[data-toggle-key]'); if(t){ const key=decodeURIComponent(t.dataset.toggleKey); setExpanded(key,!isExpanded(key)); await render(); return; } const b=e.target.closest('[data-object-path]'); if(!b) return; state.selectedObject=b.dataset.objectPath; await render(); });
el.searchInput.addEventListener('input', async (e)=>{ state.filters.search=e.target.value; await render(); });
el.groupFilter.addEventListener('change', async (e)=>{ state.filters.group=e.target.value; await render(); });
el.typeFilter.addEventListener('change', async (e)=>{ state.filters.type=e.target.value; await render(); });
el.riskFilter.addEventListener('change', async (e)=>{ state.filters.risk=e.target.value; await render(); });
el.sortBy.addEventListener('change', async (e)=>{ state.filters.sortBy=e.target.value; await render(); });
el.hideMainOnlyToggle.addEventListener('change', async (e)=>{ state.filters.excludeMainOnly=e.target.checked; await render(); });
render();
