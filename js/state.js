// 全局状态与数据契约（CargoUnit 是包装模块 → 装柜模块的核心契约）
export const state = {
  skus: [],          // CargoUnit 列表
  activeSkuId: null,
  palletResult: null,    // 最近一次托盘码放结果
  containerResult: null, // 最近一次装柜结果
};

// 集装箱内部尺寸（mm）
export const CONTAINERS = {
  '20GP': { name: '20GP', L: 5898, W: 2352, H: 2393, maxW: 21770 },
  '40GP': { name: '40GP', L: 12032, W: 2352, H: 2393, maxW: 26780 },
  '40HQ': { name: '40HQ', L: 12032, W: 2352, H: 2698, maxW: 26512 },
};

let seq = 1;
export function nextId() { return 'sku_' + (seq++) + '_' + Date.now().toString(36); }

// CargoUnit 数据契约
export function makeCargoUnit(o = {}) {
  const d = o.dg || {};
  return {
    id: o.id || nextId(),
    sku: o.sku || '',
    name: o.name || '',
    L: +o.L || 400, W: +o.W || 300, H: +o.H || 250,
    weight: +o.weight || 5,
    maxStack: +o.maxStack || 100,   // 抗压 kg
    qty: +o.qty || 100,
    fragile: !!o.fragile,
    orient: o.orient || 'thishead', // thishead=仅正立 / flip=可翻转
    // 危险品申报（IMDG）：是否危险品 / 类别 / UN号 / 正确运输名称 / 包装类
    dg: {
      isDg: !!d.isDg,
      imdgClass: d.imdgClass || '',
      unNo: d.unNo || '',
      psn: d.psn || '',
      packingGroup: d.packingGroup || '',
    },
  };
}
// 取危货类别（未申报返回空串）
export function dgClassOf(sku) { return sku?.dg?.isDg ? sku.dg.imdgClass : ''; }

export function getSku(id){ return state.skus.find(s => s.id === id); }

// 本地持久化
const KEY = 'packflow_state_v1';
export function saveLocal(){
  const data = { skus: state.skus, activeSkuId: state.activeSkuId };
  localStorage.setItem(KEY, JSON.stringify(data));
}
export function loadLocal(){
  const raw = localStorage.getItem(KEY);
  if(!raw) return false;
  try{
    const d = JSON.parse(raw);
    state.skus = (d.skus||[]).map(makeCargoUnit);
    state.activeSkuId = d.activeSkuId || (state.skus[0]?.id ?? null);
    return true;
  }catch(e){ return false; }
}

export function fmt(n){ return new Intl.NumberFormat('zh-CN').format(Math.round(n)); }
export function fmt1(n){ return (Math.round(n*10)/10).toLocaleString('zh-CN'); }
