// ====== 核心算法：托盘码放 + 集装箱装载启发式 ======

// --- 单层最优排布：多策略取优（同质栅格 + 递归块填充 + 双向 guillotine 混排）---
// 在 W×H 的矩形里放置 bl×bw 的箱（可旋转），最大化数量并给出坐标
export function packLayer(W, H, bl, bw) {
  if (W <= 0 || H <= 0 || bl <= 0 || bw <= 0) return { count: 0, rects: [] };
  const candidates = [
    gridRects(0, 0, W, H, bl, bw),   // 同质方向 A
    gridRects(0, 0, W, H, bw, bl),   // 同质方向 B
    recursiveFill(W, H, bl, bw),     // 递归交错咬合
    guillotine(W, H, bl, bw),        // 双向混排切分
  ];
  let best = candidates[0];
  for (const c of candidates) if (c.rects.length > best.rects.length) best = c;
  return { count: best.rects.length, rects: best.rects };
}

// 均匀栅格铺满：ow×oh 的箱在 (x,y,w,h) 内
function gridRects(x, y, w, h, ow, oh) {
  const rects = [];
  const nx = Math.floor(w / ow), ny = Math.floor(h / oh);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      rects.push({ x: x + i * ow, y: y + j * oh, w: ow, h: oh });
  return { rects };
}

// 双向 guillotine：主区一种方向 + 余条另一种方向，枚举切分位置取最优
function guillotine(W, H, bl, bw) {
  let best = { rects: [] };
  // 横向切：底部若干行 A，顶部余条 B
  for (let k = 0; k <= Math.floor(H / bw); k++) {
    const bottomH = k * bw;
    const bottom = gridRects(0, 0, W, bottomH, bl, bw).rects;
    const top = gridRects(0, bottomH, W, H - bottomH, bw, bl).rects;
    const all = bottom.concat(top);
    if (all.length > best.rects.length) best = { rects: all };
  }
  // 纵向切：左侧若干列 A，右侧余条 B
  for (let k = 0; k <= Math.floor(W / bl); k++) {
    const leftW = k * bl;
    const left = gridRects(0, 0, leftW, H, bl, bw).rects;
    const right = gridRects(leftW, 0, W - leftW, H, bw, bl).rects;
    const all = left.concat(right);
    if (all.length > best.rects.length) best = { rects: all };
  }
  return best;
}

// 递归块填充（交错咬合）
function recursiveFill(W, H, bl, bw) {
  const rects = [];
  fillRect(0, 0, W, H, bl, bw, rects, 0);
  return { rects };
}
function fillRect(x, y, w, h, bl, bw, out, depth) {
  if (depth > 6 || w < Math.min(bl, bw) || h < Math.min(bl, bw)) return;
  let best = null;
  for (const [ow, oh] of [[bl, bw], [bw, bl]]) {
    const nx = Math.floor(w / ow), ny = Math.floor(h / oh);
    if (nx > 0 && ny > 0) {
      const used = nx * ow * ny * oh;
      if (!best || used > best.used) best = { ow, oh, nx, ny, used };
    }
  }
  if (!best) return;
  const { ow, oh, nx, ny } = best;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      out.push({ x: x + i * ow, y: y + j * oh, w: ow, h: oh });
  const bw2 = nx * ow, bh2 = ny * oh;
  fillRect(x + bw2, y, w - bw2, h, bl, bw, out, depth + 1);
  fillRect(x, y + bh2, bw2, h - bh2, bl, bw, out, depth + 1);
}

// --- 托盘码放分析 ---
// cfg.usePallet: true=标准托盘（货物码在托盘上）/ false=无托盘落地码放
export function analyzePallet(sku, cfg) {
  const usePallet = cfg.usePallet !== false;
  const PH = usePallet ? (cfg.PH || 0) : 0;
  const { PL, PW, maxH, maxW } = cfg;
  const layer = packLayer(PL, PW, sku.L, sku.W);
  const perLayer = layer.count;

  const stackHeight = maxH; // 码放净高（托盘模式下为托盘上方，落地模式下为地面以上）
  const byHeight = Math.floor(stackHeight / sku.H);
  // 抗压：一箱可承受 maxStack kg，则其上可压 floor(maxStack/weight) 箱，加自身
  const byStack = sku.weight > 0 ? Math.floor(sku.maxStack / sku.weight) + 1 : byHeight;
  // 承重：托盘载重上限
  const byWeight = (perLayer * sku.weight) > 0
    ? Math.floor(maxW / (perLayer * sku.weight)) : byHeight;

  const layers = Math.max(0, Math.min(byHeight, byStack, byWeight));
  const totalBoxes = perLayer * layers;

  const footprintUtil = PL * PW > 0 ? (perLayer * sku.L * sku.W) / (PL * PW) : 0;
  const loadHeight = PH + layers * sku.H;
  const palletWeight = usePallet ? 25 : 0; // 空托盘约 25kg，落地码放无此项
  const loadWeight = totalBoxes * sku.weight + palletWeight;

  // 稳定性评分：底面利用率 + 高宽比（越矮越稳）
  const aspect = loadHeight / Math.min(PL, PW);
  let stability = footprintUtil * 100 * 0.7 + Math.max(0, (2 - aspect)) * 30 * 0.5;
  stability = Math.max(20, Math.min(99, Math.round(stability + 25)));

  // 限制层数的瓶颈
  let limit = '高度';
  if (layers === byStack && byStack <= byHeight) limit = '抗压强度';
  if (layers === byWeight && byWeight <= byHeight && byWeight <= byStack) limit = usePallet ? '托盘承重' : '承重上限';

  const labelPrefix = usePallet ? '托盘' : '落地堆';

  return {
    sku, cfg, usePallet, perLayer, layers, totalBoxes,
    footprintUtil, loadHeight, loadWeight, stability, limitBy: limit,
    layerRects: layer.rects,
    // 作为货物单元（数据契约）传给装柜；落地模式去掉托盘高与托盘自重
    unit: {
      L: PL, W: PW, H: loadHeight,
      weight: loadWeight,
      maxStack: sku.maxStack * 0.8, // 整体抗压保守取值
      stackable: aspect < 1.6 && !sku.fragile,
      label: `${labelPrefix}(${sku.sku || sku.name})`,
    },
  };
}

// --- 集装箱装载 ---
// unit: {L,W,H,weight,stackable} ; container: {L,W,H,maxW}
export function packContainer(unit, container, needCount, opts = {}) {
  // 地面最优排布（俯视）
  const floor = packLayer(container.L, container.W, unit.L, unit.W);
  const perFloor = floor.count;
  const byHeight = unit.stackable === false ? 1 : Math.max(1, Math.floor(container.H / unit.H));
  const perContainerByVol = perFloor * byHeight;

  // 载重约束
  const byWeight = unit.weight > 0 ? Math.floor(container.maxW / unit.weight) : perContainerByVol;
  const perContainer = Math.max(0, Math.min(perContainerByVol, byWeight));

  const containersNeeded = perContainer > 0 ? Math.ceil(needCount / perContainer) : 0;

  // 生成最后一柜的 3D 摆放（用于可视化，最多渲染一柜）
  // 部分装载时按"距集装箱中心由近及远"顺序摆放，以平衡重心/轴重
  const unitsInLastView = Math.min(needCount, perContainer);
  const cxTarget = container.L / 2, czTarget = container.W / 2;
  const orderedFloor = [...floor.rects].sort((a, b) => {
    const da = Math.hypot(a.x + a.w / 2 - cxTarget, a.y + a.h / 2 - czTarget);
    const db = Math.hypot(b.x + b.w / 2 - cxTarget, b.y + b.h / 2 - czTarget);
    return da - db;
  });
  const positions = [];
  let placed = 0;
  outer:
  for (let layer = 0; layer < byHeight; layer++) {
    for (const r of orderedFloor) {
      if (placed >= unitsInLastView) break outer;
      positions.push({
        x: r.x, y: layer * unit.H, z: r.y,
        w: r.w, h: unit.H, d: r.h,
      });
      placed++;
    }
  }

  // 重心计算（相对集装箱）
  let cx = 0, cz = 0, cy = 0, wSum = 0;
  for (const p of positions) {
    const w = unit.weight;
    cx += (p.x + p.w / 2) * w;
    cz += (p.z + p.d / 2) * w;
    cy += (p.y + p.h / 2) * w;
    wSum += w;
  }
  if (wSum > 0) { cx /= wSum; cz /= wSum; cy /= wSum; }

  const usedVol = positions.reduce((s, p) => s + p.w * p.h * p.d, 0);
  const contVol = container.L * container.W * container.H;
  const fillRate = contVol > 0 ? usedVol / contVol : 0;
  const totalWeight = placed * unit.weight;

  // 重心偏移评估（理想在几何中心）
  const offX = (cx - container.L / 2) / container.L;
  const offZ = (cz - container.W / 2) / container.W;
  const cogOffset = Math.sqrt(offX * offX + offZ * offZ);

  return {
    unit, container, perFloor, byHeight, perContainer, containersNeeded,
    positions, unitsInLastView: placed,
    fillRate, totalWeight,
    cog: { x: cx, y: cy, z: cz, offset: cogOffset, offX, offZ },
    byWeightLimited: byWeight < perContainerByVol,
  };
}

// 约束校验
export function checkConstraints(res, opts) {
  const list = [];
  const c = res.container;
  // 重心
  if (opts.cog) {
    const off = res.cog.offset;
    if (off < 0.08) list.push({ level: 'pass', text: `重心居中良好（偏移 ${(off*100).toFixed(1)}%）` });
    else if (off < 0.18) list.push({ level: 'warn', text: `重心轻微偏移 ${(off*100).toFixed(1)}%，建议微调` });
    else list.push({ level: 'fail', text: `重心偏移过大 ${(off*100).toFixed(1)}%，存在倾覆/轴重风险` });
  }
  // 总重
  if (res.totalWeight <= c.maxW) list.push({ level: 'pass', text: `单柜总重 ${Math.round(res.totalWeight)}kg，未超载（上限 ${c.maxW}kg）` });
  else list.push({ level: 'fail', text: `单柜总重 ${Math.round(res.totalWeight)}kg 超过上限 ${c.maxW}kg` });
  // 堆叠
  if (opts.stack) {
    if (res.byHeight <= 1) list.push({ level: 'pass', text: '货物单元不可叠放，已按单层装载' });
    else list.push({ level: 'pass', text: `堆叠 ${res.byHeight} 层，符合抗压强度限制` });
  }
  // 装载率
  if (res.fillRate > 0.7) list.push({ level: 'pass', text: `体积装载率 ${(res.fillRate*100).toFixed(1)}%，效率良好` });
  else if (res.fillRate > 0.5) list.push({ level: 'warn', text: `体积装载率 ${(res.fillRate*100).toFixed(1)}%，仍有优化空间` });
  else list.push({ level: 'warn', text: `体积装载率偏低 ${(res.fillRate*100).toFixed(1)}%，建议更换箱型或柜型` });
  return list;
}

// ==================== 多货多柜混装（Mixed Load） ====================
// goods: [{ unit:{L,W,H,weight,stackable,maxStack,label,color,orient}, qty }]
//   qty 含义随来源：散箱=箱数；托盘=托数
// opts: { maxContainers, cog, stack, weightLimit }
// 返回 { containers:[单柜结果], totalContainers, totalBoxes, unplaced, summary, container }
const MIX_PALETTE = [0x3b82f6, 0x0ea5e9, 0x22c55e, 0xf59e0b, 0x8b5cf6, 0xef4444, 0x14b8a6, 0xec4899, 0x84cc16, 0xf97316];

// guillotine 切分：在 free 矩形左下角占用 used，返回剩余两块（右条 + 上条）
function cutFree(free, used) {
  const res = [];
  if (used.w < free.w - 1e-6) res.push({ x: used.x + used.w, y: free.y, w: free.w - used.w, h: free.h });
  if (used.h < free.h - 1e-6) res.push({ x: free.x, y: used.y + used.h, w: used.w, h: free.h - used.h });
  return res;
}
function pruneFree(list) {
  return list.filter(f => f.w > 5 && f.h > 5).sort((a, b) => (b.w * b.h) - (a.w * a.h));
}

// 用 block-stacking + guillotine 地面切分，把多货装进单个柜
function buildOneContainer(items, container, opts) {
  const positions = [];
  let free = [{ x: 0, y: 0, w: container.L, h: container.W }];
  const placedByItem = {};
  let weightSum = 0, volSum = 0, cx = 0, cz = 0, cy = 0, maxTop = 0;
  let guard = 0;
  while (guard < 8000) {
    guard++;
    let best = null;
    const cL = container.L / 2, cW = container.W / 2;
    // 中心向外放置：先为每个待装货找其“最靠集装箱中心”的可放位置，
    // 再在所有货里选全局最靠中心者（密度相近时取体积大者），以平衡重心/轴重
    for (const it of items) {
      if (it.left <= 0) continue;
      let bf = null;
      for (const fr of free) {
        const orients = it.unit.orient === 'flip'
          ? [[it.unit.L, it.unit.W], [it.unit.W, it.unit.L]]
          : [[it.unit.L, it.unit.W]];
        for (const [ow, od] of orients) {
          if (ow <= fr.w + 1e-6 && od <= fr.h + 1e-6) {
            const byH = it.unit.stackable === false ? 1 : Math.max(1, Math.floor(container.H / it.unit.H));
            const vol = ow * it.unit.H * od * byH;
            const dist = Math.hypot(fr.x + ow / 2 - cL, fr.y + od / 2 - cW);
            if (!bf || dist < bf.dist || (Math.abs(dist - bf.dist) < 1e-6 && vol > bf.vol)) bf = { fr, ow, od, byH, vol, dist };
            break;
          }
        }
      }
      if (bf) {
        const cand = { it, ...bf };
        if (!best || cand.dist < best.dist || (Math.abs(cand.dist - best.dist) < 1e-6 && cand.vol > best.vol)) best = cand;
      }
    }
    if (!best) break;
    const { it, fr, ow, od, byH } = best;
    const count = Math.min(byH, it.left); // 防止最后一柱超量
    if (count <= 0) { it.left = 0; continue; }
    // 放置一个堆叠柱（count 层）
    for (let k = 0; k < count; k++) {
      positions.push({
        x: fr.x, y: k * it.unit.H, z: fr.y,
        w: ow, h: it.unit.H, d: od,
        unitIdx: it.idx, color: it.color, item: it,
        dgClass: it.unit.dgClass ?? null,
      });
    }
    it.left -= count;
    placedByItem[it.idx] = (placedByItem[it.idx] || 0) + count;
    const wgt = count * it.unit.weight;
    weightSum += wgt;
    volSum += count * it.unit.L * it.unit.W * it.unit.H;
    cx += (fr.x + ow / 2) * wgt;
    cz += (fr.y + od / 2) * wgt;
    cy += (count * it.unit.H / 2) * wgt;
    maxTop = Math.max(maxTop, count * it.unit.H);
    // 切分地面
    free = free.filter(f => f !== fr).concat(cutFree(fr, { x: fr.x, y: fr.y, w: ow, h: od }));
    free = pruneFree(free);
  }
  if (weightSum > 0) { cx /= weightSum; cz /= weightSum; cy /= weightSum; }
  const contVol = container.L * container.W * container.H;
  const fillRate = contVol > 0 ? volSum / contVol : 0;
  const offX = cx > 0 ? (cx - container.L / 2) / container.L : 0;
  const offZ = cz > 0 ? (cz - container.W / 2) / container.W : 0;
  return {
    positions,
    totalCount: Object.values(placedByItem).reduce((a, b) => a + b, 0),
    placedByItem, usedVol: volSum, fillRate, totalWeight: weightSum,
    cog: { x: cx, y: cy, z: cz, offset: Math.sqrt(offX * offX + offZ * offZ), offX, offZ },
    maxTop,
  };
}

// 主入口：逐柜装载，直到货物装完或达到柜数上限
export function packMultiContainer(goods, container, opts = {}) {
  const items = goods.map((g, i) => ({
    idx: i, unit: g.unit, qty: g.qty, left: g.qty,
    color: g.unit.color || MIX_PALETTE[i % MIX_PALETTE.length],
  }));
  const maxContainers = (opts.maxContainers && opts.maxContainers > 0) ? opts.maxContainers : 999;
  const containers = [];
  let contIdx = 0, guard = 0, anyPlaced = true;
  while (items.some(it => it.left > 0) && contIdx < maxContainers && anyPlaced && guard < 60) {
    guard++; contIdx++;
    const built = buildOneContainer(items, container, opts);
    if (built.totalCount === 0) { anyPlaced = false; break; }
    built.idx = contIdx;
    containers.push(built);
  }
  const totalBoxes = items.reduce((s, it) => s + (it.qty - it.left), 0);
  const unplaced = items.reduce((s, it) => s + it.left, 0);
  const summary = items.map(it => ({
    unit: it.unit, requested: it.qty, placed: it.qty - it.left, unplaced: it.left,
    color: it.color,
  }));
  return { containers, totalContainers: containers.length, totalBoxes, unplaced, summary, container };
}

// 多柜约束校验
export function checkMultiConstraints(mr, opts) {
  const list = [];
  const c = mr.container;
  mr.containers.forEach(cont => {
    if (opts.cog) {
      const off = cont.cog.offset;
      const lvl = off < 0.08 ? 'pass' : off < 0.18 ? 'warn' : 'fail';
      list.push({ level: lvl, text: `柜 #${cont.idx} 重心偏移 ${(off*100).toFixed(1)}%` +
        (lvl === 'pass' ? '（居中良好）' : lvl === 'warn' ? '（建议微调）' : '（倾覆/轴重风险）') });
    }
    if (cont.totalWeight <= c.maxW) list.push({ level: 'pass', text: `柜 #${cont.idx} 载重 ${Math.round(cont.totalWeight)}kg / 上限 ${c.maxW}kg` });
    else list.push({ level: 'fail', text: `柜 #${cont.idx} 载重 ${Math.round(cont.totalWeight)}kg 超过上限 ${c.maxW}kg` });
    if (cont.fillRate > 0.7) list.push({ level: 'pass', text: `柜 #${cont.idx} 体积装载率 ${(cont.fillRate*100).toFixed(1)}%（良好）` });
    else if (cont.fillRate > 0.5) list.push({ level: 'warn', text: `柜 #${cont.idx} 装载率 ${(cont.fillRate*100).toFixed(1)}% 仍可优化` });
    else list.push({ level: 'warn', text: `柜 #${cont.idx} 装载率偏低 ${(cont.fillRate*100).toFixed(1)}%` });
  });
  if (mr.unplaced > 0) list.push({ level: 'fail', text: `仍有 ${mr.unplaced} 件货物未能装入（柜量不足或尺寸超限）` });
  return list;
}

// ==================== IMDG 危险品隔离（第 7.2 章隔离表） ====================
// 隔离等级：'-' 无限制 | '4' 至少 3m 水平隔离 | '3' 纵向隔离 | '2' 整舱/纵隔 | '1' 远离(不同运输单元) | 'X' 禁止同装
// 说明：本矩阵为类别级（9 大类）规划用表，子类归并到基类别。正式海运出运请以最新版 IMO/IMDG 官方文本为准。
export const IMDG = {
  CLASSES: [
    { code: '1', label: '1 类 爆炸品' },
    { code: '2', label: '2 类 气体' },
    { code: '3', label: '3 类 易燃液体' },
    { code: '4', label: '4 类 易燃固体' },
    { code: '5', label: '5 类 氧化性物质' },
    { code: '6', label: '6 类 毒性物质' },
    { code: '7', label: '7 类 放射性物质' },
    { code: '8', label: '8 类 腐蚀性物质' },
    { code: '9', label: '9 类 杂项危险物' },
  ],
  // 类别级隔离矩阵（行/列均为基类别 1-9）
  TABLE: {
    '1': { '1': '1', '2': 'X', '3': 'X', '4': 'X', '5': 'X', '6': 'X', '7': 'X', '8': 'X', '9': 'X' },
    '2': { '1': 'X', '2': 'X', '3': '3', '4': '3', '5': 'X', '6': '3', '7': '2', '8': '3', '9': '2' },
    '3': { '1': 'X', '2': '3', '3': '-', '4': '2', '5': '4', '6': '2', '7': '2', '8': '4', '9': '2' },
    '4': { '1': 'X', '2': '3', '3': '2', '4': '-', '5': '2', '6': '1', '7': '2', '8': '2', '9': '2' },
    '5': { '1': 'X', '2': 'X', '3': '4', '4': '2', '5': '-', '6': 'X', '7': '2', '8': '2', '9': '2' },
    '6': { '1': 'X', '2': '3', '3': '2', '4': '1', '5': 'X', '6': 'X', '7': '2', '8': '3', '9': '2' },
    '7': { '1': 'X', '2': '2', '3': '2', '4': '2', '5': '2', '6': '2', '7': '-', '8': '2', '9': '2' },
    '8': { '1': 'X', '2': '3', '3': '4', '4': '2', '5': '2', '6': '3', '7': '2', '8': '-', '9': '2' },
    '9': { '1': 'X', '2': '2', '3': '2', '4': '2', '5': '2', '6': '2', '7': '2', '8': '2', '9': '-' },
  },
  // 子类归并到基类别（规划级）：1.4→1，4.2→4，5.1→5 …
  baseClass(cls) {
    if (!cls) return '';
    const s = String(cls).trim();
    return s.split('.')[0] || s;
  },
  // 查询隔离等级代码
  segregate(a, b) {
    const ca = IMDG.baseClass(a), cb = IMDG.baseClass(b);
    if (!ca || !cb) return '-';
    if (ca === cb) return ca === '1' ? '1' : '-'; // 同类：1 类保守隔离，其余同类可同装
    const row = IMDG.TABLE[ca] || {};
    return row[cb] || '-';
  },
  // 隔离等级的中文释义与处置建议
  degreeInfo(code) {
    switch (code) {
      case 'X': return { label: '禁止同装', short: '禁止', level: 'fail', action: '必须分装到不同集装箱（同运输单元禁止）' };
      case '1': return { label: '远离（不同运输单元）', short: '远离', level: 'fail', action: '不得装入同一集装箱，需分柜装载' };
      case '2': return { label: '隔离（整舱/纵隔）', short: '隔离', level: 'warn', action: '同一柜内需完全物理隔离（整舱或纵舱壁分隔）' };
      case '3': return { label: '纵向隔离', short: '纵隔', level: 'warn', action: '同一柜内需沿纵轴方向完全隔离' };
      case '4': return { label: '至少 3 米水平隔离', short: '≥3m', level: 'warn', action: '同一柜内水平净距须 ≥ 3000mm' };
      default:  return { label: '无隔离要求', short: '无', level: 'pass', action: '可任意混装' };
    }
  },
};

// 危货对之间的隔离对描述
function dgPair(a, b) {
  const deg = IMDG.segregate(a.unit.dgClass, b.unit.dgClass);
  return {
    aLabel: a.unit.label || '货物',
    aClass: a.unit.dgClass,
    bLabel: b.unit.label || '货物',
    bClass: b.unit.dgClass,
    degree: deg,
    info: IMDG.degreeInfo(deg),
  };
}
// 硬冲突：禁止(X) / 远离(1) —— 不得同柜
export function isHardConflict(deg) { return deg === 'X' || deg === '1'; }

// 校验一组货物内部的危货隔离兼容性
// goods: [{ unit:{label,dgClass}, ... }]
export function checkDGCompatibility(goods) {
  const dg = goods.filter(g => g.unit && g.unit.dgClass);
  const hard = [], soft = [];
  for (let i = 0; i < dg.length; i++)
    for (let j = i + 1; j < dg.length; j++) {
      const p = dgPair(dg[i], dg[j]);
      if (isHardConflict(p.degree)) hard.push(p);
      else if (p.degree !== '-') soft.push(p);
    }
  return { hard, soft };
}

// 按隔离要求（仅硬冲突）贪心分柜：把互不冲突的危货并入同一柜
export function partitionDG(goods) {
  const dg = goods.filter(g => g.unit && g.unit.dgClass);
  const nonDg = goods.filter(g => !(g.unit && g.unit.dgClass));
  const groups = [];
  const conflict = (grp, g) => grp.some(m => isHardConflict(IMDG.segregate(m.unit.dgClass, g.unit.dgClass)));
  dg.forEach(g => {
    let placed = false;
    for (const grp of groups) { if (!conflict(grp, g)) { grp.push(g); placed = true; break; } }
    if (!placed) groups.push([g]);
  });
  if (nonDg.length) { if (!groups.length) groups.push([]); groups[0].push(...nonDg); }
  return groups.length ? groups : [goods];
}

// 合并多次 packMultiContainer 结果为单一 multiResult（重编号柜、汇总）
export function mergeMultiResults(results, container) {
  const containers = [];
  const summaryMap = new Map();
  let contIdx = 0;
  results.forEach(r => {
    r.containers.forEach(c => {
      contIdx++;
      containers.push({
        ...c, idx: contIdx,
        members: r.summary.map((s, i) => ({ unit: s.unit, placed: c.placedByItem?.[i] || 0 })),
      });
    });
    r.summary.forEach(s => {
      const ex = summaryMap.get(s.unit) || { unit: s.unit, requested: 0, placed: 0, unplaced: 0, color: s.color };
      ex.requested += s.requested; ex.placed += s.placed; ex.unplaced += s.unplaced;
      summaryMap.set(s.unit, ex);
    });
  });
  const summary = [...summaryMap.values()];
  return {
    containers, totalContainers: containers.length,
    totalBoxes: summary.reduce((a, s) => a + s.placed, 0),
    unplaced: summary.reduce((a, s) => a + s.unplaced, 0),
    summary, container,
  };
}

// 3 米水平隔离核查：对每个“≥3m”危货对，计算同柜内最近箱体中心水平净距
export function checkDGSegregation3m(mr) {
  const SEG_3M = 3000; // mm
  const violations = [], checks = [];
  mr.containers.forEach(cont => {
    const byClass = {};
    cont.positions.forEach(p => { if (p.dgClass) (byClass[p.dgClass] = byClass[p.dgClass] || []).push(p); });
    const classes = Object.keys(byClass);
    for (let a = 0; a < classes.length; a++)
      for (let b = a + 1; b < classes.length; b++) {
        const ca = classes[a], cb = classes[b];
        if (IMDG.segregate(ca, cb) !== '4') continue;
        let minD = Infinity, link = null;
        for (const pa of byClass[ca]) for (const pb of byClass[cb]) {
          const dx = (pa.x + pa.w / 2) - (pb.x + pb.w / 2);
          const dz = (pa.z + pa.d / 2) - (pb.z + pb.d / 2);
          const d = Math.hypot(dx, dz);
          if (d < minD) { minD = d; link = { from: [pa.x + pa.w / 2, pa.y + pa.h / 2, pa.z + pa.d / 2], to: [pb.x + pb.w / 2, pb.y + pb.h / 2, pb.z + pb.d / 2] }; }
        }
        checks.push({ container: cont.idx, a: ca, b: cb, dist: minD });
        if (minD < SEG_3M) violations.push({ container: cont.idx, a: ca, b: cb, dist: minD, link });
      }
  });
  return { violations, checks, SEG_3M };
}
