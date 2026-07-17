// ============================================================
// OCR 识别引擎 + 文本解析器（PackFlow「识别装柜」功能）
// 设计原则：引擎层（Tesseract.js）与解析层（parseOcrText）完全分离，
//          以后要换视觉大模型（GPT-4o / Claude 等）只需替换 recognizeImage。
//          所有识别均在浏览器本地完成，图片不会上传到任何服务器。
// ============================================================

// 用 document.baseURI 解析成绝对 URL：Tesseract 的 worker 会按自身脚本位置解析相对路径，
// 若用相对路径会导致 langPath/corePath 被错误地拼接成 404，进而 gunzip 报 "invalid code length"。
const _ocrBase = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : (typeof location !== 'undefined' ? location.href : './');
const TESS_DIR = new URL('js/vendor/tesseract/', _ocrBase).href;
let _enginePromise = null;

// 懒加载 Tesseract UMD（vendored 本地，不依赖 CDN）
export function ensureOcrEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    s.src = TESS_DIR + 'tesseract.min.js';
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract)
      : reject(new Error('Tesseract 已加载但全局对象缺失')));
    s.onerror = () => reject(new Error('Tesseract 脚本加载失败，请检查 js/vendor/tesseract/tesseract.min.js 是否存在'));
    document.head.appendChild(s);
  });
  return _enginePromise;
}

// 创建并初始化一个 Tesseract worker（含进度回调）。
// 批量识别时复用同一个 worker，省去为每张图重复加载 wasm 内核与语言包，速度显著提升。
async function _createWorker(onProgress) {
  const Tesseract = await ensureOcrEngine();
  return Tesseract.createWorker('eng+chi_sim', 1, {
    corePath: TESS_DIR,                         // 目录，内含 4 个 wasm 核心
    workerPath: TESS_DIR + 'worker.min.js',
    langPath: TESS_DIR,                         // 内含 eng/chi_sim 的 traineddata.gz
    logger: (m) => {
      if (onProgress && m && typeof m.progress === 'number') {
        const pct = Math.round(m.progress * 100);
        const label = ({
          'loading tesseract core': '加载识别内核',
          'initializing tesseract': '初始化引擎',
          'loading language traineddata': '加载语言包',
          'initializing api': '初始化接口',
          'recognizing text': '识别文字',
        })[m.status] || m.status || '';
        onProgress(label, pct);
      }
    },
  });
}

// 对单张图片做本地 OCR（自带 worker 的生命周期），返回纯文本。
export async function recognizeImage(file, onProgress) {
  const worker = await _createWorker(onProgress);
  try {
    const ret = await worker.recognize(file);
    return ret.data.text || '';
  } finally {
    await worker.terminate();
  }
}

// 批量识别：复用同一个 worker 逐张识别，返回 [{ file, text }]。
// cb({ phase, i, total, label, pct })：phase='prep' 为引擎一次性加载，phase='image' 为第 i 张识别进度（0 起）。
export async function recognizeImages(files, cb) {
  if (!files || !files.length) return [];
  let cur = -1;
  const worker = await _createWorker((label, pct) => {
    if (cb) cb(cur < 0
      ? { phase: 'prep', label, pct }
      : { phase: 'image', i: cur, total: files.length, label, pct });
  });
  const out = [];
  try {
    for (let i = 0; i < files.length; i++) {
      cur = i;
      const file = files[i];
      const ret = await worker.recognize(file);
      out.push({ file, text: ret.data.text || '' });
      if (cb) cb({ phase: 'image', i, total: files.length, label: '识别文字', pct: 100 });
    }
  } finally {
    await worker.terminate();
  }
  return out;
}

// ---------- 文本解析：OCR 结果 → 结构化 SKU 草稿 ----------
// 返回数组：[{ sku, name, L, W, H, weight, qty, maxStack, unit, review:[] }]
// review 中列出未能自动识别、需要用户确认的字段。

const DIM_RE = /(\d{1,4}(?:\.\d+)?)\s*[×xX*]\s*(\d{1,4}(?:\.\d+)?)\s*[×xX*]\s*(\d{1,4}(?:\.\d+)?)/g;
const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(kg|KG|公斤|千克|kgs|千克|g|克|G)/;
// 注意：不要把「长×宽×高」里的 ×数字 当作数量，因此不收录独立的 ×(\d+) 分支
const QTY_RE = /(?:数量|数量[:：]|QTY|qty|件数|箱数|PCS|pcs)\s*[:：]?\s*(\d+)|(\d+)\s*(?:pcs|PCS|件|个|箱|CTN|ctn|set|套)/;
const SKU_RE = /(?:SKU|货号|型号|料号|Item|ITEM|Code|code)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_\/]{1,19})/;
// 编号：2~4 个大写字母 + 可选分隔 + 2~8 位数字（避免把 "X 40" 之类误识）
const CODE_RE = /\b([A-Z]{2,4}[-\s_]?\d{2,8})\b/;

// 单位换算：根据上下文把尺寸/重量归一到 mm / kg
function detectDimUnit(line) {
  if (/cm|CM|公分|厘米/.test(line)) return 10;        // 厘米 → 毫米
  if (/\bin\b|\b英寸\b|\binch\b/.test(line)) return 25.4; // 英寸 → 毫米
  return 1; // 默认当作 mm
}
function detectWeightKg(val, unitRaw) {
  const u = (unitRaw || '').toLowerCase();
  if (u === 'g') return val / 1000;
  return val; // kg / 公斤 / 千克 / 无单位均按 kg
}

// 优先在主行 primary 里匹配，匹配不到再回退到相邻行块 fallback（避免跨行污染）
function pick(re, primary, fallback) {
  let m = primary.match(re);
  if (!m && fallback) m = fallback.match(re);
  return m;
}
// 提取重量：本行优先，相邻行兜底
function findWeight(primary, fallback) {
  const m = pick(WEIGHT_RE, primary, fallback);
  if (m) return { v: detectWeightKg(parseFloat(m[1]), m[2]), unit: m[2] };
  return null;
}
// 提取数量
function findQty(primary, fallback) {
  const m = pick(QTY_RE, primary, fallback);
  if (m) { const v = +(m[1] || m[2]); if (v > 0) return v; }
  return null;
}
function findSku(primary, fallback) {
  let m = pick(SKU_RE, primary, fallback);
  if (m) return m[1];
  m = pick(CODE_RE, primary, fallback);
  if (m) return m[1];
  return null;
}
// 提取产品名：去掉尺寸/重量/数量/代号/单位词后的残留文本
function findName(line, sku) {
  let s = line
    .replace(DIM_RE, ' ')
    .replace(WEIGHT_RE, ' ')
    .replace(QTY_RE, ' ')
    .replace(SKU_RE, ' ')
    .replace(CODE_RE, ' ')
    .replace(/[×xX*:\-–—/\\|#@]+/g, ' ')
    .replace(/\b(cm|mm|in|kg|g|公斤|千克|克|英寸|厘米|公分|尺寸|规格)\b/gi, ' ')
    .replace(/\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(规格|参数|项目|物品|货物|产品)\s*/i, '');
  return s;
}

export function parseOcrText(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const results = [];

  // 1) 找出所有三维尺寸三元组，按出现分行组织
  const dimMatches = [];
  lines.forEach((line, i) => {
    DIM_RE.lastIndex = 0;
    let mm;
    while ((mm = DIM_RE.exec(line)) !== null) {
      dimMatches.push({ i, L: +mm[1], W: +mm[2], H: +mm[3], line });
    }
  });

  let idx = 0;
  if (dimMatches.length > 0) {
    for (const dm of dimMatches) {
      // 行块：本行 + 上一行 + 下一行，提升重量/数量召回
      const block = [lines[dm.i - 1], dm.line, lines[dm.i + 1]].filter(Boolean).join('\n');
      const unit = detectDimUnit(dm.line) || detectDimUnit(block);
      const sku = findSku(dm.line, block);
      const name = findName(dm.line, sku);
      const review = [];
      const w = findWeight(dm.line, block);
      const qty = findQty(dm.line, block);
      const item = {
        sku: sku || ('ITEM-' + (++idx)),
        name: name || sku || ('货物' + (idx || 1)),
        L: Math.round(dm.L * unit),
        W: Math.round(dm.W * unit),
        H: Math.round(dm.H * unit),
        weight: w ? +w.v.toFixed(2) : 1,
        qty: qty || 1,
        maxStack: 100,
        unit: unit === 1 ? 'mm' : (unit === 10 ? 'cm' : 'in'),
        review: review,
      };
      if (!w) item.review.push('weight');
      if (!qty) item.review.push('qty');
      if (!sku) item.review.push('sku');
      if (unit !== 1) item.review.push('unit'); // 单位换算过，提示确认
      results.push(item);
    }
  } else {
    // 2) 无明确「长×宽×高」三元组：尝试标签式尺寸（L:400 W:300 H:250）
    const lM = text.match(/(?:长|Length|L)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
    const wM = text.match(/(?:宽|Width|W)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
    const hM = text.match(/(?:高|Height|H)\s*[:：]?\s*(\d+(?:\.\d+)?)/i);
    if (lM && wM && hM) {
      const unit = detectDimUnit(text);
      const w = findWeight(text);
      const qty = findQty(text);
      const sku = findSku(text);
      const name = (text.match(/(?:名称|品名|name|产品)\s*[:：]?\s*([^\n]{1,30})/i) || [])[1] || '';
      const item = {
        sku: sku || 'ITEM-1',
        name: name.trim() || '货物1',
        L: Math.round(+lM[1] * unit), W: Math.round(+wM[1] * unit), H: Math.round(+hM[1] * unit),
        weight: w ? +w.v.toFixed(2) : 1, qty: qty || 1, maxStack: 100,
        unit: unit === 1 ? 'mm' : (unit === 10 ? 'cm' : 'in'), review: [],
      };
      if (!w) item.review.push('weight');
      if (!qty) item.review.push('qty');
      if (unit !== 1) item.review.push('unit');
      results.push(item);
    } else {
      // 3) 实在抽不到尺寸：保留可见文字作为名称，尺寸留给用户手填
      const firstLine = lines.find(l => l.length > 1) || '货物';
      results.push({
        sku: findSku(text) || 'ITEM-1',
        name: firstLine.slice(0, 30),
        L: 400, W: 300, H: 250, weight: 1, qty: 1, maxStack: 100, unit: 'mm',
        review: ['size', 'weight', 'qty'],
      });
    }
  }

  // 去重：相同 sku+尺寸 合并数量
  const map = new Map();
  for (const r of results) {
    const key = r.sku + '|' + r.L + '|' + r.W + '|' + r.H;
    if (map.has(key)) map.get(key).qty += r.qty;
    else map.set(key, r);
  }
  return [...map.values()];
}

// ---------- 跨图合并（批量 OCR 用） ----------
// 输入：[{ items, src }]，其中 items 为某张图 parseOcrText 的结果，src 为该图序号（从 0 起）。
// 输出：去重合并后的 item 列表；相同 sku+尺寸跨图累加数量，并累计记录来源图号（item.src: number[]）。
export function mergeOcrItems(parsedPerImage) {
  const map = new Map();
  const list = [];
  for (const { items, src } of parsedPerImage) {
    for (const it of items) {
      const key = it.sku + '|' + it.L + '|' + it.W + '|' + it.H;
      if (map.has(key)) {
        const ex = map.get(key);
        ex.qty += it.qty;
        if (ex.src.indexOf(src) < 0) ex.src.push(src);
      } else {
        const clone = Object.assign({}, it, { src: [src] });
        map.set(key, clone);
        list.push(clone);
      }
    }
  }
  return list;
}

