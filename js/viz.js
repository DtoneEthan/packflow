import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// 通用 3D 场景封装（毫米 → 场景单位按 /1000 米）
export class Scene3D {
  constructor(el) {
    this.el = el;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf1f5f9);

    const w = el.clientWidth || 600, h = el.clientHeight || 360;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
    this.camera.position.set(6, 5, 8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    el.innerHTML = '';
    el.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // 光照
    const amb = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(8, 14, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-6, 8, -8);
    this.scene.add(dir2);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._defaultCam = this.camera.position.clone();
    this._animate = this._animate.bind(this);
    this._animate();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(el);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  clear() {
    while (this.group.children.length) {
      const c = this.group.children.pop();
      c.geometry?.dispose?.();
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material?.dispose?.();
      this.group.remove(c);
    }
  }

  _animate() {
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // 摆正视角并框住内容
  frame(size) {
    const S = 1000; // mm -> unit
    const d = Math.max(size.L, size.W, size.H) / S;
    this.controls.target.set(0, size.H / S / 2, 0);
    this.camera.position.set(d * 1.2, d * 1.0, d * 1.4);
    this.controls.update();
  }

  resetCam() {
    this.controls.reset?.();
  }

  // 单个箱体预览
  showCarton(sku) {
    this.clear();
    const S = 1000;
    const g = new THREE.BoxGeometry(sku.L / S, sku.H / S, sku.W / S);
    const m = new THREE.MeshStandardMaterial({ color: 0xc79a5b, roughness: 0.85 });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = sku.H / S / 2;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x8a6a34 }));
    edges.position.copy(mesh.position);
    this.group.add(mesh); this.group.add(edges);
    this._floor(sku.L / S * 1.6, sku.W / S * 1.6);
    this.frame({ L: sku.L, W: sku.W, H: sku.H });
  }

  // 托盘码放：底面矩形 rects + 层数
  showPallet(res) {
    this.clear();
    const S = 1000;
    const { cfg, sku, layerRects, layers } = res;
    const PL = cfg.PL / S, PW = cfg.PW / S, PH = cfg.PH / S;
    // 托盘
    const pal = new THREE.Mesh(
      new THREE.BoxGeometry(PL, PH, PW),
      new THREE.MeshStandardMaterial({ color: 0x9c6b3f, roughness: 0.9 }));
    pal.position.set(0, PH / 2, 0);
    this.group.add(pal);

    const ox = -PL / 2, oz = -PW / 2;
    const palette = [0x3b82f6, 0x0ea5e9, 0x22c55e, 0xf59e0b, 0x8b5cf6, 0xef4444];
    for (let layer = 0; layer < layers; layer++) {
      const color = palette[layer % palette.length];
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
      for (const r of layerRects) {
        const bw = r.w / S, bd = r.h / S, bh = sku.H / S;
        const box = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
        box.position.set(ox + r.x / S + bw / 2, PH + layer * bh + bh / 2, oz + r.y / S + bd / 2);
        this.group.add(box);
        const e = new THREE.LineSegments(
          new THREE.EdgesGeometry(box.geometry),
          new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.25, transparent: true }));
        e.position.copy(box.position);
        this.group.add(e);
      }
    }
    this._floor(PL * 1.5, PW * 1.5);
    this.frame({ L: cfg.PL, W: cfg.PW, H: res.loadHeight });
  }

  // 集装箱装载：positions 3D + 进度
  showContainer(res, progress = 1) {
    this.clear();
    const S = 1000;
    const c = res.container;
    const CL = c.L / S, CW = c.W / S, CH = c.H / S;
    // 集装箱线框
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(CL, CH, CW));
    const helper = new THREE.Box3Helper(box, 0x1e3a8a);
    this.group.add(helper);
    // 半透明地板
    const fl = new THREE.Mesh(
      new THREE.PlaneGeometry(CL, CW),
      new THREE.MeshStandardMaterial({ color: 0xdbeafe, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    fl.rotation.x = -Math.PI / 2;
    fl.position.set(CL / 2, 0.001, CW / 2);
    this.group.add(fl);

    const palette = [0x3b82f6, 0x0ea5e9, 0x22c55e, 0xf59e0b, 0x8b5cf6];
    const n = Math.max(0, Math.round(res.positions.length * progress));
    for (let i = 0; i < n; i++) {
      const p = res.positions[i];
      const color = p.color != null ? p.color : palette[Math.floor(p.y / (p.h || 1)) % palette.length];
      const matOpts = { color, roughness: 0.8 };
      if (p.dgClass) { matOpts.emissive = 0x7c2d12; matOpts.emissiveIntensity = 0.25; }
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(p.w / S, p.h / S, p.d / S),
        new THREE.MeshStandardMaterial(matOpts));
      mesh.position.set(p.x / S + p.w / S / 2, p.y / S + p.h / S / 2, p.z / S + p.d / S / 2);
      this.group.add(mesh);
      // 危货箱体用橙色描边突出
      const edgeColor = p.dgClass ? 0xf97316 : 0xffffff;
      const edgeOpacity = p.dgClass ? 0.95 : 0.3;
      const e = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: edgeColor, opacity: edgeOpacity, transparent: true }));
      e.position.copy(mesh.position);
      this.group.add(e);
      // 危货顶部危险标记（小橙块）
      if (p.dgClass) {
        const tag = new THREE.Mesh(
          new THREE.BoxGeometry(p.w / S * 0.4, p.h / S * 0.12, p.d / S * 0.4),
          new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 0.5 }));
        tag.position.set(mesh.position.x, p.y / S + p.h / S + (p.h / S * 0.06), mesh.position.z);
        this.group.add(tag);
      }
    }
    // 3 米隔离违规红连线
    if (res.dgViolations && res.dgViolations.length) {
      res.dgViolations.forEach(v => {
        const a = new THREE.Vector3(v.from[0] / S, v.from[1] / S, v.from[2] / S);
        const b = new THREE.Vector3(v.to[0] / S, v.to[1] / S, v.to[2] / S);
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xef4444 }));
        this.group.add(line);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(0.08, 12, 12),
          new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x991b1b }));
        ball.position.copy(mid);
        this.group.add(ball);
      });
    }
    // 重心标记
    if (res.cog && n > 0) {
      const cg = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0x7f1d1d }));
      cg.position.set(res.cog.x / S, res.cog.y / S, res.cog.z / S);
      this.group.add(cg);
    }
    // 居中整个 group
    this.group.position.set(-CL / 2, 0, -CW / 2);
    this.controls.target.set(0, CH / 2, 0);
    const d = Math.max(CL, CW, CH);
    this.camera.position.set(d * 0.9, d * 0.8, d * 1.1);
    this.controls.update();
  }

  _floor(w, d) {
    const grid = new THREE.GridHelper(Math.max(w, d) * 1.4, 20, 0xcbd5e1, 0xe2e8f0);
    this.group.add(grid);
  }
}
