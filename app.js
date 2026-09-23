// A4 Draw — folders > notebooks > A4 pages with pen/eraser
// Storage: localStorage, coordinates normalized 0..1 for resolution independence

const LS_KEY = 'a4-draw-v1';
const CANVAS_W = 794;  // ~96dpi A4 width
const CANVAS_H = 1123; // ~96dpi A4 height
const COLORS = ['#111827', '#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b'];

let state = load() || { folders: [], selectedFolderId: null, selectedNotebookId: null, pageIndex: 0 };
let tool = 'pen';
let color = COLORS[0];
let brushSize = 3;
let pressureEnabled = true;
let zoom = 1;
const ZOOM_MIN = 0.4, ZOOM_MAX = 3, ZOOM_BASE_W = 680;
let drawing = false;
let activePointerId = null;
let currentStroke = null;
let redoStack = []; // per page session

// ---- helpers ----
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function load() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }
function getFolder() { return state.folders.find(f => f.id === state.selectedFolderId) || null; }
function getNotebook() {
  const f = getFolder(); if (!f) return null;
  return f.notebooks.find(n => n.id === state.selectedNotebookId) || null;
}
function getRuling(nb) {
  if (!nb) return 'ruled';
  if (!['blank', 'ruled', 'grid', 'dotted'].includes(nb.ruling)) nb.ruling = 'ruled';
  return nb.ruling;
}
function getPage() {
  const nb = getNotebook(); if (!nb || !nb.pages.length) return null;
  state.pageIndex = Math.min(Math.max(0, state.pageIndex), nb.pages.length - 1);
  return nb.pages[state.pageIndex];
}

// ---- sidebar rendering ----
function renderSidebar() {
  const fl = $('folderList'); fl.innerHTML = '';
  state.folders.forEach(f => {
    const div = document.createElement('div');
    div.className = 'item' + (f.id === state.selectedFolderId ? ' active' : '');
    div.innerHTML = `<span>📁</span><span class="name"></span><span class="count">${f.notebooks.length} 📓</span>`;
    div.querySelector('.name').textContent = f.name;
    div.onclick = () => {
      state.selectedFolderId = f.id;
      state.selectedNotebookId = f.notebooks[0]?.id || null;
      state.pageIndex = 0; redoStack = [];
      save(); renderAll();
    };
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'Delete folder';
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete folder "${f.name}" and all its notebooks?`)) return;
      state.folders = state.folders.filter(x => x.id !== f.id);
      if (state.selectedFolderId === f.id) { state.selectedFolderId = null; state.selectedNotebookId = null; }
      save(); renderAll();
    };
    div.appendChild(del);
    div.ondblclick = () => {
      const name = prompt('Rename folder:', f.name);
      if (name?.trim()) { f.name = name.trim(); save(); renderAll(); }
    };
    fl.appendChild(div);
  });

  const nl = $('notebookList'); nl.innerHTML = '';
  const folder = getFolder();
  $('noFolderHint').style.display = folder ? 'none' : 'block';
  $('notebookSectionTitle').textContent = folder ? `📓 ${folder.name}` : '📓 Notebooks';
  (folder?.notebooks || []).forEach(n => {
    const div = document.createElement('div');
    div.className = 'item' + (n.id === state.selectedNotebookId ? ' active' : '');
    div.innerHTML = `<span>📓</span><span class="name"></span><span class="count">${n.pages.length} pg</span>`;
    div.querySelector('.name').textContent = n.name;
    div.onclick = () => { state.selectedNotebookId = n.id; state.pageIndex = 0; redoStack = []; save(); renderAll(); };
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'Delete notebook';
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete notebook "${n.name}"?`)) return;
      folder.notebooks = folder.notebooks.filter(x => x.id !== n.id);
      if (state.selectedNotebookId === n.id) { state.selectedNotebookId = null; state.pageIndex = 0; }
      save(); renderAll();
    };
    div.appendChild(del);
    div.ondblclick = () => {
      const name = prompt('Rename notebook:', n.name);
      if (name?.trim()) { n.name = name.trim(); save(); renderAll(); }
    };
    nl.appendChild(div);
  });
}

// ---- board rendering ----
function renderBoard() {
  const nb = getNotebook();
  const folder = getFolder();
  const has = !!(folder && nb);
  $('emptyState').classList.toggle('hidden', has);
  $('boardView').classList.toggle('hidden', !has);
  if (!has) return;

  $('crumb').textContent = `${folder.name} / ${nb.pages.length} page(s)`;
  if (document.activeElement !== $('notebookName')) $('notebookName').value = nb.name;
  $('pageIndicator').textContent = `Page ${state.pageIndex + 1} / ${nb.pages.length}`;

  // page strip
  const strip = $('pageStrip'); strip.innerHTML = '';
  const ruling = getRuling(nb);
  if ($('rulingSelect').value !== ruling) $('rulingSelect').value = ruling;
  nb.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === state.pageIndex ? ' active' : '');
    const c = document.createElement('canvas');
    c.width = 120; c.height = 170;
    drawComposite(c, p.strokes, ruling);
    t.appendChild(c);
    const lbl = document.createElement('span'); lbl.textContent = i + 1;
    t.appendChild(lbl);
    t.onclick = () => { state.pageIndex = i; redoStack = []; save(); renderBoard(); };
    strip.appendChild(t);
  });

  resizeCanvasToA4();
  applyZoom();
  redraw();
}

function renderAll() { renderSidebar(); renderBoard(); }

// ---- canvas (two layers: ruling bg + transparent stroke layer so eraser preserves lines) ----
const canvas = $('board');
const bgCanvas = $('ruledBg');

function resizeCanvasToA4() {
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  bgCanvas.width = CANVAS_W; bgCanvas.height = CANVAS_H;
}

function applyZoom() {
  const w = Math.round(ZOOM_BASE_W * zoom);
  $('a4page').style.width = w + 'px';
  // keep A4 ratio: height follows from aspect-ratio CSS
  $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
}
function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  applyZoom();
}

function toNorm(e) {
  const r = canvas.getBoundingClientRect();
  // pressure: pen/stylus gives 0..1, mouse usually 0.5 while down, touch may give 0/1
  let p = 0.5;
  if (typeof e.pressure === 'number' && e.pressure > 0) p = e.pressure;
  else if (e.pointerType === 'mouse') p = 0.5;
  else p = 0.6;
  if (!pressureEnabled) p = 0.5;
  // force 0..1
  p = Math.min(1, Math.max(0.05, p));
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, p };
}

function pointPressure(pt) {
  if (!pressureEnabled) return 0.5;
  return (typeof pt.p === 'number' && pt.p > 0) ? Math.min(1, Math.max(0.05, pt.p)) : 0.5;
}

function drawRuling(targetCanvas, ruling) {
  // paints white paper + ruled/grid/dotted background at full canvas res
  const c = targetCanvas.getContext('2d');
  const W = targetCanvas.width, H = targetCanvas.height;
  c.save();
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
  if (ruling === 'blank') { c.restore(); return; }
  if (ruling === 'ruled') {
    // classic notebook: blue horizontal lines + red margin
    const topMargin = H * 0.09, bottomMargin = H * 0.05;
    const gap = H * 0.032; // ~30 lines per page
    c.strokeStyle = '#a9c7ec'; c.lineWidth = Math.max(1, W * 0.0015);
    c.beginPath();
    for (let y = topMargin; y <= H - bottomMargin; y += gap) {
      c.moveTo(0, y); c.lineTo(W, y);
    }
    c.stroke();
    // red margin line
    c.strokeStyle = '#f0a3a3'; c.lineWidth = Math.max(1.5, W * 0.0025);
    c.beginPath();
    const mx = W * 0.11;
    c.moveTo(mx, 0); c.lineTo(mx, H);
    c.stroke();
  } else if (ruling === 'grid') {
    const step = W * 0.035; // square grid
    c.strokeStyle = '#bcd3f0'; c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= W; x += step) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = 0; y <= H; y += step) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
  } else if (ruling === 'dotted') {
    const stepX = W * 0.045, stepY = H * 0.032;
    c.fillStyle = '#9db8d8';
    const r = Math.max(1.2, W * 0.002);
    for (let y = stepY; y < H; y += stepY) {
      for (let x = stepX; x < W; x += stepX) {
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
    }
  }
  c.restore();
}

function paintStroke(c, s, W, H, scale, eraseMode) {
  // eraseMode: 'white' (legacy composite) or 'destination-out' (transparent layer)
  const pts = s.points || [];
  if (!pts.length) return;
  const base = s.size * scale * (s.tool === 'eraser' ? 2.5 : 1);
  if (eraseMode === 'destination-out') {
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = 'rgba(0,0,0,1)'; c.fillStyle = 'rgba(0,0,0,1)';
  } else {
    const col = s.tool === 'eraser' ? '#ffffff' : s.color;
    c.strokeStyle = col; c.fillStyle = col;
  }
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (pts.length === 1) {
    const w = base * (0.35 + 0.65 * pointPressure(pts[0]));
    c.beginPath();
    c.arc(pts[0].x * W, pts[0].y * H, w / 2, 0, Math.PI * 2);
    c.fill();
  } else {
    for (let i = 1; i < pts.length; i++) {
      const avgP = (pointPressure(pts[i - 1]) + pointPressure(pts[i])) / 2;
      c.lineWidth = Math.max(0.5, base * (0.35 + 0.65 * avgP));
      c.beginPath();
      c.moveTo(pts[i - 1].x * W, pts[i - 1].y * H);
      c.lineTo(pts[i].x * W, pts[i].y * H);
      c.stroke();
    }
  }
  if (eraseMode === 'destination-out') c.restore();
}

function drawStrokeLayer(targetCanvas, strokes) {
  // transparent layer: pens paint, erasers destination-out (preserves ruling behind)
  const c = targetCanvas.getContext('2d');
  const W = targetCanvas.width, H = targetCanvas.height;
  const scale = W / CANVAS_W;
  c.clearRect(0, 0, W, H);
  c.lineCap = 'round'; c.lineJoin = 'round';
  (strokes || []).forEach(s => {
    if (s.tool === 'eraser') paintStroke(c, s, W, H, scale, 'destination-out');
    else paintStroke(c, s, W, H, scale, 'source-over');
  });
}

function drawComposite(targetCanvas, strokes, ruling) {
  // single-canvas composite for thumbnails / PNG / PDF: white + ruling + strokes
  const W = targetCanvas.width, H = targetCanvas.height;
  drawRuling(targetCanvas, ruling || 'ruled');
  // render strokes to offscreen transparent layer, then overlay (keeps ruling intact under eraser)
  const layer = document.createElement('canvas');
  layer.width = W; layer.height = H;
  drawStrokeLayer(layer, strokes);
  targetCanvas.getContext('2d').drawImage(layer, 0, 0);
}

// backward-compat alias (old calls without ruling default to ruled)
function drawStrokes(targetCanvas, strokes, ruling) {
  drawComposite(targetCanvas, strokes, ruling || 'ruled');
}

function redraw() {
  const page = getPage();
  const nb = getNotebook();
  const ruling = getRuling(nb);
  drawRuling(bgCanvas, ruling);
  drawStrokeLayer(canvas, page?.strokes || []);
  renderDots();
}

// tools UI
function renderDots() {
  const wrap = $('colorDots'); if (wrap.dataset.built) {
    wrap.querySelectorAll('.dot').forEach(d => d.classList.toggle('active', d.dataset.c === color));
    return;
  }
  wrap.dataset.built = '1';
  COLORS.forEach(c => {
    const d = document.createElement('span');
    d.className = 'dot' + (c === color ? ' active' : '');
    d.dataset.c = c; d.style.background = c; d.title = c;
    d.onclick = () => { color = c; tool = 'pen'; syncToolUI(); redraw(); };
    wrap.appendChild(d);
  });
}
function syncToolUI() {
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}

// pointer drawing — single active pointer (basic touch + stylus pressure support)
canvas.addEventListener('pointerdown', (e) => {
  const page = getPage(); if (!page) return;
  if (drawing) return; // ignore second finger while drawing
  e.preventDefault();
  drawing = true; activePointerId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  currentStroke = { tool, color, size: brushSize, points: [toNorm(e)] };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drawing || !currentStroke || e.pointerId !== activePointerId) return;
  e.preventDefault();
  // use coalesced events for smoother lines on high-refresh touch/stylus
  const evts = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
    ? e.getCoalescedEvents() : [e];
  evts.forEach(ev => currentStroke.points.push(toNorm(ev)));
  // live draw incrementally (stroke layer only — ruling stays on bg canvas)
  const page = getPage();
  drawStrokeLayer(canvas, [...(page.strokes || []), currentStroke]);
});
function endStroke(e) {
  if (!drawing || !currentStroke) return;
  if (e && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
  drawing = false; activePointerId = null;
  const page = getPage();
  // drop accidental single taps with no movement? keep them as dots — useful for touch
  if (currentStroke.points.length) { page.strokes.push(currentStroke); redoStack = []; }
  currentStroke = null;
  save(); renderBoard();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
// prevent touch scrolling / pinch interfering while drawing
canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// ---- actions ----
function requireNotebook() {
  if (!getNotebook()) { alert('Create/select a folder + notebook first.'); return false; }
  return true;
}

$('btnNewFolder').onclick = $('btnEmptyFolder').onclick = () => {
  const name = prompt('Folder name:', `Folder ${state.folders.length + 1}`);
  if (!name?.trim()) return;
  const f = { id: uid(), name: name.trim(), createdAt: Date.now(), notebooks: [] };
  state.folders.push(f);
  state.selectedFolderId = f.id; state.selectedNotebookId = null;
  save(); renderAll();
};

$('btnNewNotebook').onclick = () => {
  const folder = getFolder();
  if (!folder) { alert('Create a folder first.'); return; }
  const name = prompt('Notebook name:', `Notebook ${folder.notebooks.length + 1}`);
  if (!name?.trim()) return;
  const nb = { id: uid(), name: name.trim(), createdAt: Date.now(), ruling: 'ruled', pages: [{ id: uid(), strokes: [] }] };
  folder.notebooks.push(nb);
  state.selectedNotebookId = nb.id; state.pageIndex = 0; redoStack = [];
  save(); renderAll();
};

$('notebookName').addEventListener('change', (e) => {
  const nb = getNotebook(); if (!nb) return;
  nb.name = e.target.value.trim() || 'Untitled';
  save(); renderAll();
});

$('btnAddPage').onclick = () => {
  if (!requireNotebook()) return;
  const nb = getNotebook();
  nb.pages.push({ id: uid(), strokes: [] });
  state.pageIndex = nb.pages.length - 1; redoStack = [];
  save(); renderBoard();
};
$('btnDeletePage').onclick = () => {
  const nb = getNotebook(); if (!nb) return;
  if (nb.pages.length <= 1) { alert('A notebook needs at least 1 page. Use Clear instead.'); return; }
  if (!confirm(`Delete page ${state.pageIndex + 1}?`)) return;
  nb.pages.splice(state.pageIndex, 1);
  state.pageIndex = Math.max(0, state.pageIndex - 1); redoStack = [];
  save(); renderBoard();
};
$('btnPrevPage').onclick = () => { const nb = getNotebook(); if (!nb) return; state.pageIndex = (state.pageIndex - 1 + nb.pages.length) % nb.pages.length; redoStack = []; save(); renderBoard(); };
$('btnNextPage').onclick = () => { const nb = getNotebook(); if (!nb) return; state.pageIndex = (state.pageIndex + 1) % nb.pages.length; redoStack = []; save(); renderBoard(); };

document.querySelectorAll('.tool').forEach(b => b.onclick = () => { tool = b.dataset.tool; syncToolUI(); });
$('colorPicker').oninput = (e) => { color = e.target.value; tool = 'pen'; syncToolUI(); redraw(); };
$('brushSize').oninput = (e) => { brushSize = +e.target.value; $('brushSizeVal').textContent = brushSize + 'px'; };
$('pressureToggle').onchange = (e) => { pressureEnabled = e.target.checked; };
$('rulingSelect').onchange = (e) => {
  const nb = getNotebook(); if (!nb) return;
  nb.ruling = e.target.value;
  save(); renderBoard();
};
// zoom: buttons + ctrl/cmd+wheel (pinch on trackpads sends wheel with ctrlKey)
$('btnZoomIn').onclick = () => setZoom(zoom * 1.2);
$('btnZoomOut').onclick = () => setZoom(zoom / 1.2);
$('btnZoomFit').onclick = () => {
  const wrap = $('canvasWrap');
  const fitW = wrap.clientWidth - 48;
  setZoom(fitW / ZOOM_BASE_W);
};
$('canvasWrap').addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

$('btnUndo').onclick = () => {
  const page = getPage(); if (!page?.strokes.length) return;
  redoStack.push(page.strokes.pop());
  save(); renderBoard();
};
$('btnRedo').onclick = () => {
  const page = getPage(); if (!redoStack.length) return;
  page.strokes.push(redoStack.pop());
  save(); renderBoard();
};
$('btnClear').onclick = () => {
  const page = getPage(); if (!page) return;
  if (!page.strokes.length) return;
  if (!confirm('Clear all drawings on this page?')) return;
  page.strokes = []; redoStack = [];
  save(); renderBoard();
};

$('btnPng').onclick = () => {
  const nb = getNotebook(); if (!nb) return;
  const tmp = document.createElement('canvas');
  tmp.width = CANVAS_W; tmp.height = CANVAS_H;
  drawComposite(tmp, getPage()?.strokes || [], getRuling(nb));
  const a = document.createElement('a');
  a.download = `${nb.name}-p${state.pageIndex + 1}.png`;
  a.href = tmp.toDataURL('image/png');
  a.click();
};
$('btnPdf').onclick = exportPdfNotebook;
$('btnPrint').onclick = () => window.print();

function exportPdfNotebook() {
  const nb = getNotebook(); if (!nb) return;
  // local-only: render each A4 page to image, pack into one A4 PDF via jsPDF (CDN)
  if (!window.jspdf) {
    alert('PDF library not loaded (are you offline?). Falling back to Print → Save as PDF.');
    window.print();
    return;
  }
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const tmp = document.createElement('canvas');
    tmp.width = CANVAS_W; tmp.height = CANVAS_H;
    nb.pages.forEach((p, i) => {
      drawComposite(tmp, p.strokes, getRuling(nb));
      const img = tmp.toDataURL('image/jpeg', 0.92);
      if (i > 0) pdf.addPage('a4', 'portrait');
      pdf.addImage(img, 'JPEG', 0, 0, 210, 297);
    });
    pdf.save(`${(nb.name || 'notebook').replace(/[\\/:*?"<>|]/g, '_')}.pdf`);
  } catch (err) {
    console.error(err);
    alert('PDF export failed. Try Print → Save as PDF instead.');
  }
}

$('btnExportData').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'a4-draw-backup.json'; a.click();
};
$('btnImportData').onclick = () => $('importFile').click();
$('importFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      state = JSON.parse(r.result);
      save(); renderAll();
    } catch { alert('Invalid backup file.'); }
  };
  r.readAsText(f);
});

$('btnDemo').onclick = () => {
  const f = { id: uid(), name: 'Demo Folder', createdAt: Date.now(), notebooks: [] };
  const nb = { id: uid(), name: 'My First Notebook', createdAt: Date.now(), ruling: 'ruled', pages: [{ id: uid(), strokes: [] }, { id: uid(), strokes: [] }] };
  // sample scribble on page 1
  nb.pages[0].strokes = [{
    tool: 'pen', color: '#4f46e5', size: 4,
    points: Array.from({ length: 40 }, (_, i) => ({ x: 0.15 + i * 0.015, y: 0.3 + Math.sin(i / 3) * 0.05, p: 0.4 + Math.abs(Math.sin(i / 5)) * 0.6 }))
  }];
  f.notebooks.push(nb);
  state.folders.push(f);
  state.selectedFolderId = f.id; state.selectedNotebookId = nb.id; state.pageIndex = 0;
  save(); renderAll();
};

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? $('btnRedo').click() : $('btnUndo').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); $('btnRedo').click(); }
  else if (e.key.toLowerCase() === 'p') { tool = 'pen'; syncToolUI(); }
  else if (e.key.toLowerCase() === 'e') { tool = 'eraser'; syncToolUI(); }
  else if (e.key === '+' || e.key === '=') { if (getNotebook()) setZoom(zoom * 1.2); }
  else if (e.key === '-' || e.key === '_') { if (getNotebook()) setZoom(zoom / 1.2); }
  else if (e.key === '0') { if (getNotebook()) setZoom(1); }
});

window.addEventListener('resize', () => { /* canvas is CSS-scaled, internal res fixed */ });

syncToolUI();
renderAll();
