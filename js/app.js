import { state, CONTAINERS, makeCargoUnit, getSku, saveLocal, loadLocal, exportSkuJSON, importSkuJSON, fmt, fmt1 } from './state.js';
import { pushSkus, pullSkus } from './cloud.js';
import { analyzePallet, packContainer, checkConstraints, packMultiContainer, checkMultiConstraints, IMDG, checkDGCompatibility, partitionDG, mergeMultiResults, checkDGSegregation3m } from './algorithms.js';
import { Scene3D } from './viz.js';
import { recognizeImage, parseOcrText } from './ocr.js';

// ---------- 工具 ----------
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// localStorage 安全封装：沙箱/隐私模式/iframe 中可能抛 SecurityError，必须吞掉，绝不让它中断脚本
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

// ---------- 3D 场景（懒加载） ----------
let vizCarton, vizPallet, vizContainer;

// ---------- Tab 切换 ----------
$$('.step').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
function switchTab(tab) {
  $$('.step').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  // 初始化对应 3D
  setTimeout(() => {
    if (tab === 'design') { if (!vizCarton) vizCarton = new Scene3D($('#viz-carton')); previewCarton(); }
    if (tab === 'pallet') { if (!vizPallet) vizPallet = new Scene3D($('#viz-pallet')); refreshPalletSkuSelect(); }
    if (tab === 'container') { if (!vizContainer) vizContainer = new Scene3D($('#viz-container')); refreshContSkuSelect(); syncCargoMode(); }
    if (tab === 'report') renderReport();
  }, 30);
}

// ==================== 1. 包装设计 ====================
function readCartonForm() {
  return makeCargoUnit({
    id: state.activeSkuId,
    sku: $('#f-sku').value.trim(),
    name: $('#f-name').value.trim(),
    L: $('#f-l').value, W: $('#f-w').value, H: $('#f-h').value,
    weight: $('#f-weight').value, maxStack: $('#f-maxstack').value,
    qty: $('#f-qty').value,
    fragile: $('#f-fragile').checked,
    orient: $('#f-orient').value,
    dg: {
      isDg: $('#f-dg').checked,
      imdgClass: $('#f-dg').checked ? $('#f-dgclass').value : '',
      unNo: $('#f-dgun').value.trim(),
      psn: $('#f-dgpsn').value.trim(),
      packingGroup: $('#f-dgpg').value,
    },
  });
}
function fillCartonForm(s) {
  $('#f-sku').value = s.sku; $('#f-name').value = s.name;
  $('#f-l').value = s.L; $('#f-w').value = s.W; $('#f-h').value = s.H;
  $('#f-weight').value = s.weight; $('#f-maxstack').value = s.maxStack;
  $('#f-qty').value = s.qty; $('#f-fragile').checked = s.fragile;
  $('#f-orient').value = s.orient;
  $('#f-dg').checked = !!s.dg?.isDg;
  $('#f-dgclass').value = s.dg?.imdgClass || '';
  $('#f-dgun').value = s.dg?.unNo || '';
  $('#f-dgpsn').value = s.dg?.psn || '';
  $('#f-dgpg').value = s.dg?.packingGroup || '';
}
function previewCarton() {
  const s = readCartonForm();
  if (vizCarton) vizCarton.showCarton(s);
  const vol = (s.L * s.W * s.H) / 1e9;
  $('#carton-summary').innerHTML =
    `外箱体积 <b>${fmt1(vol * 1000)}</b> L　|　单箱毛重 <b>${s.weight}</b> kg　|　
     订单总量 <b>${fmt(s.qty)}</b> 箱　|　总毛重 <b>${fmt(s.qty * s.weight)}</b> kg
     <br>抗压强度 ${s.maxStack} kg　|　${s.fragile ? '⚠ 易碎/禁止倒置' : '常规货'}　|　
     ${s.orient === 'flip' ? '可翻转堆叠' : '仅正立'}`;
}
$('#carton-form').addEventListener('input', () => { if (vizCarton) previewCarton(); });
$('#btn-preview').addEventListener('click', previewCarton);

$('#btn-save-sku').addEventListener('click', () => {
  const s = readCartonForm();
  if (!s.sku && !s.name) { toast('请填写 SKU 编号或名称'); return; }
  const existing = getSku(state.activeSkuId);
  if (existing) Object.assign(existing, s);
  else { s.id = undefined; const nu = makeCargoUnit(s); state.skus.push(nu); state.activeSkuId = nu.id; }
  const ok = saveLocal();
  renderSkuList();
  if (ok) toast('SKU 已保存到本浏览器');
  else toast('本浏览器禁止本地存储（预览沙箱），请改用「导出 JSON」保存');
});
$('#btn-add-sku').addEventListener('click', () => {
  state.activeSkuId = null;
  fillCartonForm(makeCargoUnit({ sku: '', name: '' }));
  renderSkuList(); previewCarton();
});

// SKU 导出 / 导入 JSON（文件级保存，任何环境可用，可跨设备）
$('#btn-export-sku').addEventListener('click', () => {
  if (!state.skus.length) { toast('没有可导出的 SKU'); return; }
  const blob = new Blob([exportSkuJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'packflow_skus_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${state.skus.length} 个 SKU 到 JSON 文件`);
});
$('#btn-import-sku').addEventListener('click', () => $('#sku-file-input').click());
$('#sku-file-input').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importSkuJSON(reader.result);
      saveLocal();
      renderSkuList();
      const cur = getSku(state.activeSkuId); if (cur) fillCartonForm(cur);
      toast(`已导入 ${state.skus.length} 个 SKU`);
    } catch (err) { toast('导入失败：' + err.message); }
    e.target.value = '';
  };
  reader.readAsText(f, 'utf-8');
});

// ==================== 云端同步（GitHub 共享存储） ====================
const GH_TOKEN_KEY = 'packflow_gh_token';
function setGhStatus(msg, lvl) {
  $('#gh-status').innerHTML = msg ? `<span class="${lvl || ''}">${msg}</span>` : '';
}
$('#gh-token').value = lsGet(GH_TOKEN_KEY) || '';
$('#btn-gh-connect').addEventListener('click', () => {
  const t = $('#gh-token').value.trim();
  if (!t) { lsDel(GH_TOKEN_KEY); setGhStatus('已清除令牌', 'warn'); return; }
  lsSet(GH_TOKEN_KEY, t);
  setGhStatus('令牌已保存（仅存于本浏览器，请使用 Fine-grained PAT 并仅授权本仓库 Contents 读写）', 'pass');
  // 顺带验证：尝试拉取一次
  doPull(true);
});
$('#btn-gh-push').addEventListener('click', async () => {
  const t = lsGet(GH_TOKEN_KEY);
  if (!t) { toast('请先填写并保存 GitHub PAT'); return; }
  setGhStatus('上传中…');
  try {
    await pushSkus(t, exportSkuJSON());
    setGhStatus('已上传到云端 ✓ ' + new Date().toLocaleTimeString('zh-CN'), 'pass');
    toast('SKU 已上传到云端');
  } catch (e) { setGhStatus('上传失败：' + e.message, 'fail'); toast('上传失败：' + e.message); }
});
$('#btn-gh-pull').addEventListener('click', () => doPull());
async function doPull(silent) {
  const t = lsGet(GH_TOKEN_KEY);
  if (!t) { if (!silent) toast('请先填写并保存 GitHub PAT'); return; }
  if (!silent) setGhStatus('拉取中…');
  try {
    await pullAndMerge(t);
  } catch (e) {
    if (!silent) { setGhStatus('拉取失败：' + e.message, 'fail'); toast('拉取失败：' + e.message); }
    else console.warn('自动拉取云端失败:', e.message);
  }
}
async function pullAndMerge(token) {
  const txt = await pullSkus(token);
  if (!txt) { setGhStatus('云端暂无数据（首次「上传到云端」将自动创建）', 'warn'); return; }
  importSkuJSON(txt); saveLocal(); renderSkuList();
  const cur = getSku(state.activeSkuId); if (cur) fillCartonForm(cur);
  setGhStatus('已从云端拉取 ' + state.skus.length + ' 个 SKU ✓', 'pass');
  toast('已从云端拉取 ' + state.skus.length + ' 个 SKU');
}
function renderSkuList() {
  const el = $('#sku-list');
  if (!state.skus.length) { el.innerHTML = '<div class="empty">暂无 SKU，点击下方新增</div>'; return; }
  el.innerHTML = '';
  state.skus.forEach(s => {
    const d = document.createElement('div');
    d.className = 'sku-item' + (s.id === state.activeSkuId ? ' active' : '');
    const dgBadge = s.dg?.isDg ? `<span class="dg-badge">⚠ ${s.dg.imdgClass || 'DG'}类</span>` : '';
    d.innerHTML = `<span class="s-del" data-del="${s.id}">删除</span>
      <div class="s-title">${s.sku || '(未命名)'} ${s.name ? '· ' + s.name : ''} ${dgBadge}</div>
      <div class="s-meta">${s.L}×${s.W}×${s.H}mm · ${s.weight}kg · ${fmt(s.qty)}箱</div>`;
    d.addEventListener('click', e => {
      if (e.target.dataset.del) return;
      state.activeSkuId = s.id; fillCartonForm(s); renderSkuList(); previewCarton();
    });
    el.appendChild(d);
  });
  $$('[data-del]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    state.skus = state.skus.filter(x => x.id !== b.dataset.del);
    if (state.activeSkuId === b.dataset.del) state.activeSkuId = state.skus[0]?.id ?? null;
    saveLocal(); renderSkuList();
    const cur = getSku(state.activeSkuId);
    if (cur) fillCartonForm(cur);
  }));
}

// ==================== 2. 托盘码放 ====================
function refreshPalletSkuSelect() {
  const sel = $('#pallet-sku');
  sel.innerHTML = state.skus.map(s => `<option value="${s.id}">${s.sku || s.name || s.id}</option>`).join('');
  if (state.activeSkuId) sel.value = state.activeSkuId;
}
// 统一从 DOM 读取托盘参数（含模式：标准托盘 / 无托盘落地码放 + 常用规格预设）
function readPalletCfg() {
  const usePallet = document.querySelector('input[name=pmode]:checked').value === 'pallet';
  return {
    PL: +$('#p-l').value || 1200,
    PW: +$('#p-w').value || 1000,
    PH: usePallet ? (+$('#p-ph').value || 0) : 0,
    maxH: +$('#p-maxh').value || 1800,
    maxW: +$('#p-maxw').value || 1000,
    corner: $('#p-corner').checked,
    strap: $('#p-strap').checked,
    usePallet,
  };
}
// 切换托盘模式：无托盘时禁用“托盘高”输入并同步 UI
function applyPalletMode() {
  const usePallet = document.querySelector('input[name=pmode]:checked').value === 'pallet';
  const ph = $('#p-ph'), phWrap = $('#p-ph-wrap');
  ph.disabled = !usePallet;
  phWrap.style.opacity = usePallet ? '1' : '0.45';
  phWrap.style.pointerEvents = usePallet ? '' : 'none';
}
// 托盘规格预设下拉：选择后自动填入 长/宽/高
$('#p-preset').addEventListener('change', e => {
  const v = e.target.value;
  if (v === 'custom') return;
  const [l, w, h] = v.split('x').map(Number);
  if (l && w && h) { $('#p-l').value = l; $('#p-w').value = w; $('#p-ph').value = h; }
});
document.querySelectorAll('input[name=pmode]').forEach(r => r.addEventListener('change', applyPalletMode));
applyPalletMode();

$('#btn-calc-pallet').addEventListener('click', () => {
  const sku = getSku($('#pallet-sku').value);
  if (!sku) { toast('请先在包装设计中创建 SKU'); return; }
  const cfg = readPalletCfg();
  const res = analyzePallet(sku, cfg);
  state.palletResult = res;
  $('#pallet-title').textContent = res.usePallet
    ? '托盘码放分析（Pallet Analysis）'
    : '落地码放分析（Floor Stacking）';
  renderPalletStats(res);
  if (vizPallet) vizPallet.showPallet(res);
  toast(res.usePallet ? `码放完成：每托 ${res.totalBoxes} 箱` : `落地码放完成：每堆 ${res.totalBoxes} 箱`);
});
function renderPalletStats(r) {
  const stab = r.stability >= 75 ? 'good' : r.stability >= 55 ? 'warn' : 'bad';
  const pal = r.usePallet; // 托盘模式文案 vs 落地模式文案
  const boxWord = pal ? '整托' : '整堆';
  const stackWord = pal ? '整托' : '堆码';
  $('#pallet-stats').innerHTML = `
    <div class="stat"><div class="v">${r.perLayer}</div><div class="k">每层箱数</div></div>
    <div class="stat"><div class="v">${r.layers}</div><div class="k">码放层数</div></div>
    <div class="stat"><div class="v good">${r.totalBoxes}</div><div class="k">${boxWord}总箱数</div></div>
    <div class="stat"><div class="v">${(r.footprintUtil*100).toFixed(0)}%</div><div class="k">底面利用率</div></div>
    <div class="stat"><div class="v ${stab}">${r.stability}</div><div class="k">稳定性评分</div></div>
    <div class="stat"><div class="v">${fmt(r.loadHeight)}<span style="font-size:12px">mm</span></div><div class="k">${stackWord}总高</div></div>
    <div class="stat"><div class="v">${fmt(r.loadWeight)}<span style="font-size:12px">kg</span></div><div class="k">${pal ? '整托毛重' : '货物总重'}</div></div>
    <div class="stat"><div class="v warn" style="font-size:15px">${r.limitBy}</div><div class="k">层数瓶颈</div></div>`;
}
$('#pallet-reset-cam').addEventListener('click', () => { if (state.palletResult && vizPallet) vizPallet.showPallet(state.palletResult); });

// ==================== 3. 集装箱装载 ====================
function refreshContSkuSelect() {
  const sel = $('#cont-sku');
  sel.innerHTML = state.skus.map(s => `<option value="${s.id}">${s.sku || s.name || s.id}</option>`).join('');
  if (state.activeSkuId) sel.value = state.activeSkuId;
}
$('#btn-calc-container').addEventListener('click', () => {
  const src = document.querySelector('input[name=src]:checked').value;
  if (src === 'mix') { runMix(); return; }
  state.multiResult = null; $('#mix-containers').innerHTML = '';
  $('#imdg-report').style.display = 'none'; $('#imdg-report').innerHTML = '';
  const sku = getSku($('#cont-sku').value);
  if (!sku) { toast('请先创建 SKU'); return; }
  const container = { ...CONTAINERS[$('#cont-type').value] };
  container.maxW = +$('#c-maxw').value || container.maxW;

  let unit, needCount, mode;
  if (src === 'pallet') {
    if (!state.palletResult || state.palletResult.sku.id !== sku.id) {
      // 自动按当前托盘参数算一遍（含托盘/落地模式）
      const cfg = readPalletCfg();
      state.palletResult = analyzePallet(sku, cfg);
    }
    unit = state.palletResult.unit;
    needCount = Math.ceil(sku.qty / state.palletResult.totalBoxes);
    mode = '托盘';
  } else {
    unit = { L: sku.L, W: sku.W, H: sku.H, weight: sku.weight, stackable: !sku.fragile };
    needCount = sku.qty;
    mode = '散箱';
  }

  const opts = { cog: $('#c-cog').checked, stack: $('#c-stack').checked };
  const res = packContainer(unit, container, needCount, opts);
  res.mode = mode; res.needCount = needCount; res.sku = sku;
  state.containerResult = res;

  renderContainerStats(res);
  $('#constraint-report').innerHTML = checkConstraints(res, opts).map(c => {
    const ic = c.level === 'pass' ? '✓' : c.level === 'warn' ? '!' : '✕';
    return `<div class="cst ${c.level}"><span class="ic">${ic}</span>${c.text}</div>`;
  }).join('');
  $('#load-progress').value = 100;
  if (vizContainer) vizContainer.showContainer(res, 1);
  toast(`装柜完成：需 ${res.containersNeeded} 个 ${container.name}`);
});
function renderContainerStats(r) {
  const fill = r.fillRate >= 0.7 ? 'good' : r.fillRate >= 0.5 ? 'warn' : 'bad';
  $('#container-stats').innerHTML = `
    <div class="stat"><div class="v good">${r.containersNeeded}</div><div class="k">所需柜量 (${r.container.name})</div></div>
    <div class="stat"><div class="v">${r.perContainer}</div><div class="k">单柜可装 (${r.mode})</div></div>
    <div class="stat"><div class="v">${r.perFloor} × ${r.byHeight}</div><div class="k">地面 × 层数</div></div>
    <div class="stat"><div class="v ${fill}">${(r.fillRate*100).toFixed(1)}%</div><div class="k">体积装载率</div></div>
    <div class="stat"><div class="v">${fmt(r.totalWeight)}<span style="font-size:12px">kg</span></div><div class="k">单柜载重</div></div>
    <div class="stat"><div class="v">${(r.cog.offset*100).toFixed(1)}%</div><div class="k">重心偏移</div></div>`;
}
$('#load-progress').addEventListener('input', e => {
  if (state.containerResult && vizContainer)
    vizContainer.showContainer(state.containerResult, e.target.value / 100);
});
$('#cont-reset-cam').addEventListener('click', () => {
  if (state.containerResult && vizContainer)
    vizContainer.showContainer(state.containerResult, $('#load-progress').value / 100);
});

// ==================== 4. 报告 ====================
// 注：renderReport 的统一实现（支持单货与多货多柜）见文件后部「报告支持多柜」节，此处不再重复定义。
$('#btn-print').addEventListener('click', () => window.print());

// ==================== 数据导入/保存 ====================
$('#btn-import').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { importCSV(reader.result); e.target.value = ''; };
  reader.readAsText(f, 'utf-8');
});
function importCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) { toast('文件为空'); return; }
  // 支持表头：sku,name,L,W,H,weight,maxStack,qty
  const header = lines[0].toLowerCase();
  const hasHeader = /sku|name|长|l\b/.test(header);
  const rows = hasHeader ? lines.slice(1) : lines;
  let n = 0;
  rows.forEach(line => {
    const c = line.split(/[,\t;]/).map(x => x.trim());
    if (c.length < 4) return;
    state.skus.push(makeCargoUnit({
      sku: c[0], name: c[1], L: c[2], W: c[3], H: c[4],
      weight: c[5], maxStack: c[6], qty: c[7],
    }));
    n++;
  });
  state.activeSkuId = state.skus[state.skus.length - 1]?.id ?? null;
  saveLocal(); renderSkuList();
  const cur = getSku(state.activeSkuId); if (cur) fillCartonForm(cur);
  toast(`成功导入 ${n} 个 SKU`);
}
$('#btn-save').addEventListener('click', () => {
  const ok = saveLocal();
  if (ok) toast('方案已保存到本浏览器');
  else toast('本浏览器禁止本地存储，请改用「导出 JSON」保存');
});
$('#btn-load').addEventListener('click', () => {
  if (loadLocal()) { renderSkuList(); const c = getSku(state.activeSkuId); if (c) fillCartonForm(c); toast('已读取本地方案'); }
  else toast('没有找到已保存的方案');
});

// ==================== 0. 识别装柜（OCR 自动建单） ====================
let ocrItems = [];
let ocrFiles = [];
const ocrFile = $('#ocr-file'), ocrDrop = $('#ocr-drop');
const ocrRun = $('#btn-ocr-run'), ocrClear = $('#btn-ocr-clear');
const ocrStatus = $('#ocr-status'), ocrProgress = $('#ocr-progress');
const ocrFill = $('#ocr-fill'), ocrProgLabel = $('#ocr-progress-label');
const ocrRaw = $('#ocr-raw-text'), ocrResultCard = $('#ocr-result-card');
const ocrPreview = $('#ocr-preview');

function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function setOcrStatus(msg, cls) { ocrStatus.textContent = msg; ocrStatus.className = 'ocr-status' + (cls ? ' ' + cls : ''); }
function ocrRenderThumbs() {
  let box = $('#ocr-thumbs');
  if (!box) { box = document.createElement('div'); box.id = 'ocr-thumbs'; box.className = 'ocr-thumbs'; ocrDrop.after(box); }
  box.innerHTML = ocrFiles.map(f => `<img src="${URL.createObjectURL(f)}" title="${escAttr(f.name)}">`).join('');
}
function ocrCollect(files) {
  for (const f of files) if (f && f.type && f.type.startsWith('image/')) ocrFiles.push(f);
  ocrRun.disabled = ocrFiles.length === 0;
  ocrClear.disabled = ocrFiles.length === 0;
  setOcrStatus(`已选择 ${ocrFiles.length} 张图片，点击「开始识别」`, '');
  ocrRenderThumbs();
}
ocrFile.addEventListener('change', e => ocrCollect([...e.target.files]));
['dragover', 'dragenter'].forEach(ev => ocrDrop.addEventListener(ev, e => { e.preventDefault(); ocrDrop.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => ocrDrop.addEventListener(ev, e => { e.preventDefault(); ocrDrop.classList.remove('drag'); }));
ocrDrop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files) ocrCollect([...e.dataTransfer.files]); });
ocrDrop.addEventListener('click', () => ocrFile.click());

ocrClear.addEventListener('click', () => {
  ocrFiles = []; ocrItems = [];
  ocrRun.disabled = true; ocrClear.disabled = true;
  ocrResultCard.style.display = 'none'; ocrRaw.textContent = ''; ocrProgress.style.display = 'none';
  setOcrStatus('');
  const box = $('#ocr-thumbs'); if (box) box.remove();
});

ocrRun.addEventListener('click', async () => {
  if (!ocrFiles.length) return;
  ocrRun.disabled = true; ocrClear.disabled = true;
  ocrProgress.style.display = 'block'; ocrFill.style.width = '0%';
  setOcrStatus('正在识别…', '');
  let allText = '';
  try {
    for (let i = 0; i < ocrFiles.length; i++) {
      ocrProgLabel.textContent = `识别第 ${i + 1}/${ocrFiles.length} 张…`;
      const txt = await recognizeImage(ocrFiles[i], (label, pct) => {
        ocrProgLabel.textContent = `第${i + 1}张 ${label} ${pct}%`;
        const base = ocrFiles.length > 1 ? (i / ocrFiles.length * 100) : 0;
        ocrFill.style.width = (base + pct / ocrFiles.length) + '%';
      });
      allText += (i ? '\n' : '') + txt;
    }
    ocrFill.style.width = '100%';
    ocrProgLabel.textContent = '识别完成，正在解析…';
    ocrRaw.textContent = allText.trim() || '(未识别出文字)';
    ocrItems = parseOcrText(allText);
    window.__ocrRawText = allText; window.__ocrItems = ocrItems; // 调试钩子（供端到端验证读取真实识别文本）
    if (!ocrItems.length) {
      setOcrStatus('未能从图片中识别出尺寸/货物信息，请换更清晰的图，或改用「包装设计」手动录入', 'err');
      ocrProgress.style.display = 'none'; ocrRun.disabled = false; ocrClear.disabled = false; return;
    }
    renderOcrPreview(ocrItems);
    ocrResultCard.style.display = 'block';
    setOcrStatus(`成功识别 ${ocrItems.length} 条货物，请校对后加入`, 'ok');
  } catch (err) {
    console.error(err);
    setOcrStatus('识别失败：' + (err && err.message ? err.message : err), 'err');
  } finally {
    ocrProgress.style.display = 'none'; ocrRun.disabled = false; ocrClear.disabled = false;
  }
});

function ocrReviewBadges(review) {
  const map = { weight: '重量', qty: '数量', sku: '编号', size: '尺寸', unit: '单位' };
  return (review || []).map(r => `<span class="review-badge ${r === 'size' ? 'size' : ''}" title="系统未能自动识别，请确认">✎ ${map[r] || r}</span>`).join('');
}
function renderOcrPreview(items) {
  const head = `<thead><tr><th class="col-inc">加入</th><th>SKU/编号</th><th>名称</th><th>长(mm)</th><th>宽(mm)</th><th>高(mm)</th><th>重(kg)</th><th>数量</th><th>需确认</th></tr></thead>`;
  const rows = items.map((it, i) => `<tr data-i="${i}">
    <td class="col-inc"><input type="checkbox" data-inc checked></td>
    <td><input data-f="sku" value="${escAttr(it.sku)}"></td>
    <td><input data-f="name" value="${escAttr(it.name)}"></td>
    <td><input data-f="L" type="number" value="${it.L}"></td>
    <td><input data-f="W" type="number" value="${it.W}"></td>
    <td><input data-f="H" type="number" value="${it.H}"></td>
    <td><input data-f="weight" type="number" step="0.1" value="${it.weight}"></td>
    <td><input data-f="qty" type="number" value="${it.qty}"></td>
    <td>${ocrReviewBadges(it.review)}</td>
  </tr>`).join('');
  ocrPreview.innerHTML = head + '<tbody>' + rows + '</tbody>';
}
function commitOcrItems(goContainer) {
  const rows = [...ocrPreview.querySelectorAll('tbody tr')];
  let n = 0;
  for (const tr of rows) {
    if (!tr.querySelector('input[data-inc]').checked) continue;
    const get = f => tr.querySelector(`input[data-f="${f}"]`).value;
    state.skus.push(makeCargoUnit({
      sku: get('sku').trim(), name: get('name').trim(),
      L: +get('L') || 400, W: +get('W') || 300, H: +get('H') || 250,
      weight: +get('weight') || 1, qty: +get('qty') || 1, maxStack: 100,
    }));
    n++;
  }
  if (!n) { toast('请至少勾选一条'); return; }
  state.activeSkuId = state.skus[state.skus.length - 1].id;
  saveLocal(); renderSkuList();
  toast(`已加入 ${n} 个 SKU`);
  if (goContainer) {
    // 直接切到「散箱装载」模式，让新识别的 SKU 立即出现在装柜下拉，便于一键出方案
    const cartonRadio = document.querySelector('input[name="src"][value="carton"]');
    if (cartonRadio) cartonRadio.checked = true;
    switchTab('container');
  }
}
$('#btn-ocr-add').addEventListener('click', () => commitOcrItems(false));
$('#btn-ocr-add-go').addEventListener('click', () => commitOcrItems(true));

// ==================== 初始化 ====================
function seed() {
  if (loadLocal() && state.skus.length) return;
  state.skus = [
    makeCargoUnit({ sku: 'FB-1001', name: '弹跳杆 Pro', L: 400, W: 300, H: 250, weight: 8, maxStack: 120, qty: 1200 }),
    makeCargoUnit({ sku: 'FB-2002', name: '滑板车 Lite', L: 600, W: 250, H: 200, weight: 6, maxStack: 90, qty: 900 }),
    makeCargoUnit({ sku: 'FB-3003', name: '油性涂料', L: 360, W: 280, H: 300, weight: 12, maxStack: 100, qty: 400,
      dg: { isDg: true, imdgClass: '3', unNo: 'UN1263', psn: 'PAINT', packingGroup: 'III' } }),
    makeCargoUnit({ sku: 'FB-8008', name: '酸性清洗剂', L: 320, W: 260, H: 280, weight: 14, maxStack: 90, qty: 300,
      dg: { isDg: true, imdgClass: '8', unNo: 'UN2796', psn: 'BATTERY FLUID, ACID', packingGroup: 'II' } }),
    makeCargoUnit({ sku: 'FB-5005', name: '漂粉精', L: 400, W: 300, H: 300, weight: 18, maxStack: 120, qty: 200,
      dg: { isDg: true, imdgClass: '5', unNo: 'UN2208', psn: 'CALCIUM HYPOCHLORITE', packingGroup: 'II' } }),
    makeCargoUnit({ sku: 'FB-2101', name: '杀虫气雾剂', L: 250, W: 250, H: 400, weight: 9, maxStack: 80, qty: 150,
      dg: { isDg: true, imdgClass: '2', unNo: 'UN1950', psn: 'INSECTICIDE GAS', packingGroup: 'II' } }),
  ];
  state.activeSkuId = state.skus[0].id;
}
seed();
fillCartonForm(getSku(state.activeSkuId) || makeCargoUnit());
renderSkuList();
switchTab('design');

// 若已保存令牌，启动时静默拉取一次云端共享 SKU
if (lsGet(GH_TOKEN_KEY)) { setGhStatus('已检测到令牌，正在拉取云端…'); doPull(true); }

// ==================== 多货多柜混装 ====================
// 根据装载来源切换：单货(托盘/散箱) 或 混装清单
function syncCargoMode() {
  const src = document.querySelector('input[name=src]:checked')?.value;
  const mix = src === 'mix';
  const mp = $('#mix-panel'); if (mp) mp.style.display = mix ? 'block' : 'none';
  const cs = $('#cont-sku'); if (cs) cs.style.display = mix ? 'none' : 'block';
  if (mix) renderMixGoods();
}
$$('input[name=src]').forEach(r => r.addEventListener('change', syncCargoMode));

// IMDG 开关联动：仅在混装 + 勾选时显示自动分柜
function syncImdg() {
  const on = $('#c-imdg').checked;
  $('#c-imdg-sep-wrap').style.display = on ? 'flex' : 'none';
}
$('#c-imdg').addEventListener('change', syncImdg);
syncImdg();

// 估算某 SKU 的托盘方案（用于混装"托盘"来源默认数量）
function estPallet(sku) {
  if (state.palletResult && state.palletResult.sku.id === sku.id) return state.palletResult;
  const cfg = {
    PL: +$('#p-l').value || 1200, PW: +$('#p-w').value || 1000, PH: +$('#p-ph').value || 150,
    maxH: +$('#p-maxh').value || 1800, maxW: +$('#p-maxw').value || 1000,
    corner: $('#p-corner').checked, strap: $('#p-strap').checked,
  };
  return analyzePallet(sku, cfg);
}
function defaultMixQty(s, src) {
  src = src || 'pallet';
  if (src === 'pallet') {
    const pr = estPallet(s);
    return { qty: Math.max(1, Math.ceil(s.qty / (pr.totalBoxes || 1))), unit: '托' };
  }
  return { qty: s.qty, unit: '箱' };
}

// 渲染混装货物清单（勾选 + 来源 + 数量）
function renderMixGoods() {
  const el = $('#mix-goods');
  if (!state.skus.length) { el.innerHTML = '<div class="empty">请先在「包装设计」创建 SKU</div>'; return; }
  el.innerHTML = '';
  state.skus.forEach(s => {
    const def = defaultMixQty(s);
    const row = document.createElement('div');
    row.className = 'g-row'; row.dataset.sku = s.id;
    const dgBadge = s.dg?.isDg ? `<span class="dg-badge sm">⚠${s.dg.imdgClass || 'DG'}</span>` : '';
    row.innerHTML = `
      <input type="checkbox" class="g-chk" checked />
      <div class="g-name">${s.sku || s.name || s.id} ${dgBadge}<span class="g-dim">${s.L}×${s.W}×${s.H}mm · ${s.weight}kg</span></div>
      <select class="g-src"><option value="pallet">托盘</option><option value="carton">散箱</option></select>
      <label class="g-q">数量 <input type="number" class="g-qty" min="1" value="${def.qty}" /><span class="g-unit">${def.unit}</span></label>`;
    el.appendChild(row);
    row.querySelector('.g-src').addEventListener('change', e => {
      const d = defaultMixQty(s, e.target.value);
      row.querySelector('.g-qty').value = d.qty;
      row.querySelector('.g-unit').textContent = d.unit;
    });
  });
}

// 收集勾选的货物 → goods 数组
function buildMixGoods() {
  const rows = $$('#mix-goods .g-row');
  const goods = [];
  rows.forEach(row => {
    if (!row.querySelector('.g-chk').checked) return;
    const sku = getSku(row.dataset.sku); if (!sku) return;
    const src = row.querySelector('.g-src').value;
    const qty = Math.max(1, +row.querySelector('.g-qty').value || 1);
    const dgClass = sku.dg?.isDg ? sku.dg.imdgClass : null;
    if (src === 'pallet') {
      const pr = estPallet(sku);
      goods.push({ unit: { ...pr.unit, label: sku.sku || sku.name, dgClass }, qty });
    } else {
      goods.push({
        unit: {
          L: sku.L, W: sku.W, H: sku.H, weight: sku.weight,
          stackable: !sku.fragile, maxStack: sku.maxStack,
          label: sku.sku || sku.name, orient: sku.orient, dgClass,
        }, qty,
      });
    }
  });
  return goods;
}

// 运行混装
function runMix() {
  const goods = buildMixGoods();
  if (!goods.length) { toast('请至少勾选一个货物'); return; }
  const container = { ...CONTAINERS[$('#cont-type').value] };
  container.maxW = +$('#c-maxw').value || container.maxW;
  const maxC = +$('#mix-maxc').value || 0;
  const imdgOn = $('#c-imdg').checked;
  const opts = { cog: $('#c-cog').checked, stack: $('#c-stack').checked, maxContainers: maxC };

  // IMDG 隔离校验
  const compat = imdgOn ? checkDGCompatibility(goods) : { hard: [], soft: [] };
  const autoSep = imdgOn && $('#c-imdg-sep').checked && compat.hard.length > 0;
  let res;
  if (autoSep) {
    const groups = partitionDG(goods);
    const results = groups.map(g => packMultiContainer(g, container, { ...opts, maxContainers: 0 }));
    res = mergeMultiResults(results, container);
    res.autoSeparated = true;
    res.groups = groups.length;
  } else {
    res = packMultiContainer(goods, container, opts);
  }
  state.multiResult = res; state.activeContainerIdx = null;

  // 3 米水平隔离核查（仅对同柜内需 ≥3m 的危货对）
  const imdg = imdgOn ? checkDGSegregation3m(res) : { violations: [], checks: [], SEG_3M: 3000 };
  state.imdgResult = { compat, imdg, on: imdgOn, autoSep };
  renderIMDGReport();

  renderMixStats(res, null);
  $('#constraint-report').innerHTML = checkMultiConstraints(res, opts).map(c => {
    const ic = c.level === 'pass' ? '✓' : c.level === 'warn' ? '!' : '✕';
    return `<div class="cst ${c.level}"><span class="ic">${ic}</span>${c.text}</div>`;
  }).join('');
  renderMixChips(res);
  showContainerForMix(1);
  toast(`混装完成：需 ${res.totalContainers} 个 ${container.name}${res.unplaced > 0 ? '，' + res.unplaced + ' 件未装' : ''}${autoSep ? '（已按隔离自动分柜）' : ''}`);
}

// IMDG 隔离报告
function renderIMDGReport() {
  const el = $('#imdg-report');
  const r = state.imdgResult;
  if (!r || !r.on) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  const { compat, imdg, autoSep } = r;
  let html = `<h3>⚠ IMDG 危险品隔离校验 <span class="hint-inline">（类别级 · 规划参考）</span></h3>`;
  if (autoSep) html += `<div class="cst warn"><span class="ic">!</span>已按隔离要求自动分柜：将 ${compat.hard.length} 组硬冲突货物拆分到不同集装箱</div>`;
  if (!compat.hard.length && !compat.soft.length) {
    html += `<div class="cst pass"><span class="ic">✓</span>本批货物无危险品或相互无隔离要求，可自由混装</div>`;
  } else {
    if (compat.hard.length) {
      html += `<div class="sec-title">硬冲突（禁止同柜）</div>`;
      compat.hard.forEach(p => {
        html += `<div class="cst fail"><span class="ic">✕</span><b>${p.aLabel}</b>(${p.aClass}类) ↔ <b>${p.bLabel}</b>(${p.bClass}类)：隔离等级「${p.info.label}」— ${p.info.action}</div>`;
      });
    }
    if (compat.soft.length) {
      html += `<div class="sec-title">需隔离（同柜须满足隔离距离）</div>`;
      compat.soft.forEach(p => {
        html += `<div class="cst warn"><span class="ic">!</span><b>${p.aLabel}</b>(${p.aClass}类) ↔ <b>${p.bLabel}</b>(${p.bClass}类)：隔离等级「${p.info.label}」— ${p.info.action}</div>`;
      });
    }
  }
  // 3 米核查
  if (imdg.checks.length) {
    html += `<div class="sec-title">≥3m 水平隔离实测（柜内最近箱体中心水平距 vs 3000mm）</div>`;
    imdg.checks.forEach(c => {
      const ok = c.dist >= imdg.SEG_3M;
      const lvl = ok ? 'pass' : 'fail';
      html += `<div class="cst ${lvl}"><span class="ic">${ok ? '✓' : '✕'}</span>柜 #${c.container}：${c.a}类 ↔ ${c.b}类 实测 <b>${Math.round(c.dist)}mm</b> ${ok ? '≥ 3000mm 达标' : '< 3000mm 不达标'}</div>`;
    });
  }
  el.innerHTML = html;
}
$('#btn-calc-mix')?.addEventListener('click', runMix);

// 混装统计（总览或单柜）
function renderMixStats(res, idx) {
  const el = $('#container-stats');
  if (idx == null) {
    const avg = res.containers.length ? res.containers.reduce((s, c) => s + c.fillRate, 0) / res.containers.length : 0;
    const totW = res.containers.reduce((s, c) => s + c.totalWeight, 0);
    const legend = res.summary.map(s =>
      `<span class="lg"><i style="background:#${s.color.toString(16).padStart(6, '0')}"></i>${s.unit.label || '-'} ${s.placed}</span>`).join('');
    el.innerHTML = `
      <div class="stat"><div class="v good">${res.totalContainers}</div><div class="k">所需柜量 (${res.container.name})</div></div>
      <div class="stat"><div class="v">${fmt(res.totalBoxes)}</div><div class="k">已装总件数</div></div>
      <div class="stat"><div class="v">${(avg * 100).toFixed(1)}%</div><div class="k">平均装载率</div></div>
      <div class="stat"><div class="v">${fmt(totW)}<span style="font-size:12px">kg</span></div><div class="k">总载重</div></div>
      <div class="stat"><div class="v ${res.unplaced > 0 ? 'bad' : 'good'}">${res.unplaced}</div><div class="k">未装件数</div></div>
      <div class="stat legend-cell"><div class="legend">${legend}</div><div class="k">货物图例</div></div>`;
  } else {
    const c = res.containers.find(x => x.idx === idx) || res.containers[0];
    const fill = c.fillRate >= 0.7 ? 'good' : c.fillRate >= 0.5 ? 'warn' : 'bad';
    el.innerHTML = `
      <div class="stat"><div class="v good">#${c.idx}</div><div class="k">当前柜</div></div>
      <div class="stat"><div class="v">${c.totalCount}</div><div class="k">本柜件数</div></div>
      <div class="stat"><div class="v ${fill}">${(c.fillRate * 100).toFixed(1)}%</div><div class="k">体积装载率</div></div>
      <div class="stat"><div class="v">${fmt(c.totalWeight)}<span style="font-size:12px">kg</span></div><div class="k">本柜载重</div></div>
      <div class="stat"><div class="v">${(c.cog.offset * 100).toFixed(1)}%</div><div class="k">重心偏移</div></div>
      <div class="stat"><div class="v">${fmt(c.maxTop)}<span style="font-size:12px">mm</span></div><div class="k">码放总高</div></div>`;
  }
}

// 柜切换 chips
function renderMixChips(res) {
  const el = $('#mix-containers');
  if (res.containers.length <= 1) { el.innerHTML = ''; return; }
  let html = `<span class="chip ${state.activeContainerIdx == null ? 'on' : ''}" data-idx="">总览</span>`;
  res.containers.forEach(c => {
    html += `<span class="chip ${state.activeContainerIdx === c.idx ? 'on' : ''}" data-idx="${c.idx}">柜 #${c.idx} · ${(c.fillRate * 100).toFixed(0)}%</span>`;
  });
  el.innerHTML = html;
  $$('#mix-containers .chip').forEach(ch => ch.addEventListener('click', () => {
    const v = ch.dataset.idx;
    state.activeContainerIdx = v === '' ? null : +v;
    renderMixStats(res, state.activeContainerIdx);
    renderMixChips(res);
    showContainerForMix($('#load-progress').value / 100);
  }));
}

// 3D 显示某柜（混装）
function showContainerForMix(progress = 1) {
  if (!state.multiResult || !vizContainer) return;
  const res = state.multiResult;
  const c = state.activeContainerIdx == null
    ? res.containers[0]
    : (res.containers.find(x => x.idx === state.activeContainerIdx) || res.containers[0]);
  if (!c) return;
  const viol = (state.imdgResult?.on && state.imdgResult.imdg.violations)
    ? state.imdgResult.imdg.violations.filter(v => v.container === c.idx).map(v => v.link)
    : null;
  vizContainer.showContainer({ container: res.container, positions: c.positions, cog: c.cog, dgViolations: viol }, progress);
}

// 进度滑块兼容混装
$('#load-progress').addEventListener('input', e => {
  const p = e.target.value / 100;
  if (state.multiResult && vizContainer) showContainerForMix(p);
  else if (state.containerResult && vizContainer) vizContainer.showContainer(state.containerResult, p);
});

// 报告支持多柜
function renderReport() {
  const el = $('#report-body');
  if (state.multiResult) { renderMultiReport(el, state.multiResult); return; }
  const r = state.containerResult;
  if (!r) { el.innerHTML = '<div class="empty">请先完成集装箱装载计算，再查看装箱单</div>'; return; }
  const sku = r.sku;
  const p = state.palletResult;
  const date = new Date().toLocaleDateString('zh-CN');
  el.innerHTML = `
    <div class="rep-h">
      <div><div class="t">装箱单 / Packing List</div>
        <div style="color:var(--muted);font-size:12px">生成日期 ${date} · PackFlow</div></div>
      <div style="text-align:right;font-size:12px;color:var(--muted)">
        柜型 <b style="color:var(--ink)">${r.container.name}</b><br>装载方式 ${r.mode}</div>
    </div>
    <div class="rep-grid">
      <div class="rep-kv"><div class="k">SKU</div><div class="v">${sku.sku || '-'}</div></div>
      <div class="rep-kv"><div class="k">总箱数</div><div class="v">${fmt(sku.qty)}</div></div>
      <div class="rep-kv"><div class="k">所需柜量</div><div class="v">${r.containersNeeded} × ${r.container.name}</div></div>
      <div class="rep-kv"><div class="k">单柜载重</div><div class="v">${fmt(r.totalWeight)} kg</div></div>
      <div class="rep-kv"><div class="k">体积装载率</div><div class="v">${(r.fillRate*100).toFixed(1)}%</div></div>
      <div class="rep-kv"><div class="k">重心偏移</div><div class="v">${(r.cog.offset*100).toFixed(1)}%</div></div>
    </div>
    <h3>货物明细</h3>
    <table>
      <thead><tr><th>项目</th><th>规格</th><th>数量/参数</th></tr></thead>
      <tbody>
        <tr><td>产品名称</td><td>${sku.name || '-'}</td><td>SKU ${sku.sku || '-'}</td></tr>
        <tr><td>外箱尺寸</td><td>${sku.L}×${sku.W}×${sku.H} mm</td><td>单箱 ${sku.weight} kg</td></tr>
        ${p ? `<tr><td>托盘方案</td><td>${p.cfg.PL}×${p.cfg.PW} mm · ${p.layers}层</td><td>每托 ${p.totalBoxes} 箱 / ${fmt(p.loadWeight)} kg</td></tr>` : ''}
        <tr><td>单柜装载</td><td>${r.perFloor} 地面 × ${r.byHeight} 层</td><td>${r.perContainer} ${r.mode}/柜</td></tr>
        <tr><td>总计</td><td>${r.container.name} × ${r.containersNeeded}</td><td>${fmt(sku.qty)} 箱</td></tr>
      </tbody>
    </table>
    <h3>重量分布</h3>
    <div class="rep-kv" style="background:#fff">
      <div class="k">单柜载重 ${fmt(r.totalWeight)} kg / 上限 ${fmt(r.container.maxW)} kg</div>
      <div class="bar"><span style="width:${Math.min(100, r.totalWeight / r.container.maxW * 100).toFixed(0)}%"></span></div>
      <div class="k" style="margin-top:10px">纵向重心偏移 ${(r.cog.offX*100).toFixed(1)}% / 横向 ${(r.cog.offZ*100).toFixed(1)}%（理想 0%，居中越好）</div>
    </div>`;
}
function renderMultiReport(el, mr) {
  const c = mr.container;
  const date = new Date().toLocaleDateString('zh-CN');
  const legend = mr.summary.map(s =>
    `<span class="lg"><i style="background:#${s.color.toString(16).padStart(6, '0')}"></i>${s.unit.label || '-'}（装${s.placed}${s.unplaced > 0 ? '/未' + s.unplaced : ''}）</span>`).join('');
  const avg = mr.containers.length ? mr.containers.reduce((s, x) => s + x.fillRate, 0) / mr.containers.length : 0;
  const blocks = mr.containers.map(cc => {
    const rows = mr.summary.map((s, i) => ({ s, n: cc.placedByItem[i] || 0 })).filter(x => x.n > 0);
    return `<div class="cont-block"><b>柜 #${cc.idx}</b>（${cc.totalCount} 件 · ${(cc.fillRate*100).toFixed(1)}% · ${fmt(cc.totalWeight)}kg）
      <table><thead><tr><th>货物</th><th>数量</th></tr></thead>
      <tbody>${rows.map(x => `<tr><td>${x.s.unit.label || '-'}</td><td>${x.n}</td></tr>`).join('')}</tbody></table></div>`;
  }).join('');
  el.innerHTML = `
    <div class="rep-h">
      <div><div class="t">混装装箱单 / Mixed Packing List</div>
        <div style="color:var(--muted);font-size:12px">生成日期 ${date} · PackFlow</div></div>
      <div style="text-align:right;font-size:12px;color:var(--muted)">柜型 <b style="color:var(--ink)">${c.name}</b><br>共 ${mr.totalContainers} 柜</div>
    </div>
    <div class="rep-grid">
      <div class="rep-kv"><div class="k">所需柜量</div><div class="v">${mr.totalContainers} × ${c.name}</div></div>
      <div class="rep-kv"><div class="k">已装总件数</div><div class="v">${fmt(mr.totalBoxes)}</div></div>
      <div class="rep-kv"><div class="k">未装件数</div><div class="v">${mr.unplaced}</div></div>
      <div class="rep-kv"><div class="k">平均装载率</div><div class="v">${(avg*100).toFixed(1)}%</div></div>
    </div>
    <h3>货物图例</h3><div class="legend">${legend}</div>
    <h3>分柜汇总</h3>
    <table>
      <thead><tr><th>柜号</th><th>装载率</th><th>载重(kg)</th><th>重心偏移</th><th>件数</th></tr></thead>
      <tbody>${mr.containers.map(cc =>
        `<tr><td>#${cc.idx}</td><td>${(cc.fillRate*100).toFixed(1)}%</td><td>${fmt(cc.totalWeight)}</td><td>${(cc.cog.offset*100).toFixed(1)}%</td><td>${cc.totalCount}</td></tr>`).join('')}</tbody>
    </table>
    <h3>各柜货物构成</h3>${blocks}`;
  // IMDG 隔离摘要
  if (state.imdgResult?.on) {
    const { compat, imdg } = state.imdgResult;
    let imdgHtml = `<h3>⚠ IMDG 危险品隔离结论</h3>`;
    if (mr.autoSeparated) imdgHtml += `<div class="cst warn"><span class="ic">!</span>已按隔离要求自动分柜（${mr.groups} 组兼容柜群）</div>`;
    if (imdg.violations.length)
      imdgHtml += imdg.violations.map(v => `<div class="cst fail"><span class="ic">✕</span>柜 #${v.container}：${v.a}类 ↔ ${v.b}类 水平净距仅 ${Math.round(v.dist)}mm，< 3000mm 不达标，需拉开间距</div>`).join('');
    else if (compat.hard.length)
      imdgHtml += `<div class="cst fail"><span class="ic">✕</span>存在 ${compat.hard.length} 组硬冲突危货，未启用自动分柜，禁止同柜出运</div>`;
    else
      imdgHtml += `<div class="cst pass"><span class="ic">✓</span>3 米水平隔离核查通过，无违规</div>`;
    if (imdg.checks.length)
      imdgHtml += imdg.checks.map(c => `<div class="cst ${c.dist >= imdg.SEG_3M ? 'pass' : 'fail'}"><span class="ic">${c.dist >= imdg.SEG_3M ? '✓' : '✕'}</span>柜 #${c.container}：${c.a}类 ↔ ${c.b}类 实测 ${Math.round(c.dist)}mm</div>`).join('');
    el.innerHTML += imdgHtml;
  }
}

// 标记应用已成功初始化（供 index.html 的加载失败横幅判断）
window.__packflowReady = true;
// 应用已就绪：主动隐藏加载失败横幅（即便此前因 three.js 慢加载短暂弹出，也不应继续遮档 UI）
(function () {
  try {
    var b = document.getElementById('fatal-banner');
    if (b) b.style.display = 'none';
  } catch (e) {}
})();
