import { bones, mix } from './tracking.js';

const add = (a, b) => a.map((n, i) => n + b[i]);
const sub = (a, b) => a.map((n, i) => n - b[i]);
const mul = (a, k) => a.map(n => n * k);
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => mul(a, 1 / (Math.hypot(...a) || 1));
const defaultCamera = { yaw: 0.39, pitch: 0.16, zoom: 1 };

export function palmRelative(frame) {
  if (!frame.hand || !frame.pen) return null;
  const joints = frame.hand.joints;
  const origin = joints[0], x = unit(sub(joints[5], joints[17]));
  const z = unit(cross(x, sub(joints[9], origin)));
  const y = unit(cross(z, x));
  const points = frame.pen.points.map(p => [x, y, z].map(axis => dot(sub(p, origin), axis)));
  return { center: mix(...points, 0.5), axis: unit(sub(points[1], points[0])), points };
}

export function demoSequence() {
  const joints = [
    [-.15,-1.35,.02], [-.81,-.81,.02], [-1.21,-.40,.18], [-1.40,.02,.40], [-1.25,.34,.69],
    [-.56,.03,.07], [-.82,.58,.37], [-.86,.85,.68], [-.72,.90,.99],
    [-.10,.15,0], [-.12,.88,.24], [-.08,1.17,.53], [.01,1.19,.87],
    [.33,.04,-.08], [.46,.67,.12], [.53,.91,.43], [.46,.91,.80],
    [.72,-.21,-.13], [.94,.27,.03], [1.00,.51,.26], [.97,.53,.54]
  ];
  return Array.from({length: 241}, (_, index) => {
    const time = index / 60, angle = time * Math.PI * 2;
    const center = [0.07 + .15*Math.sin(angle), .62 + .22*Math.sin(angle*.5), .6 + .10*Math.cos(angle)];
    const axis = [Math.cos(angle + .36), Math.sin(angle + .36)*.81, Math.sin(angle + .36)*.47];
    return { time, hand: { joints: joints.map(([x,y,z], i) => [x, y + (i > 4 && i % 4 > 1 ? .1*Math.sin(angle + i) : 0), z + .05*Math.sin(angle + i)]), state: 'observed' },
      pen: { points: [sub(center, mul(axis, 1.72)), add(center, mul(axis, 1.72))], state: 'observed', confidence: 1 } };
  });
}

export class MotionViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = { ...defaultCamera };
    this.center = [0, -.04, .12];
    this.extent = 2.35;
    this.grid = true;
    this.frame = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    let drag;
    canvas.addEventListener('pointerdown', event => {
      drag = [event.clientX, event.clientY];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag) return;
      this.camera.yaw += (event.clientX - drag[0]) * 0.009;
      this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + (event.clientY - drag[1]) * 0.009));
      drag = [event.clientX, event.clientY];
      this.draw();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { drag = null; });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoom(Math.exp(-event.deltaY * 0.0012));
    }, { passive: false });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '0'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === '0') return this.reset();
      if (event.key === '+') return this.zoom(1.15);
      if (event.key === '-') return this.zoom(1 / 1.15);
      this.camera.yaw += event.key === 'ArrowLeft' ? -0.16 : event.key === 'ArrowRight' ? 0.16 : 0;
      this.camera.pitch = Math.max(-1.45, Math.min(1.45, this.camera.pitch + (event.key === 'ArrowUp' ? -0.13 : event.key === 'ArrowDown' ? 0.13 : 0)));
      this.draw();
    });
  }

  reset() { this.camera = { ...defaultCamera }; this.draw(); }
  zoom(factor) { this.camera.zoom = Math.max(0.4, Math.min(3.5, this.camera.zoom * factor)); this.draw(); }

  fit(frames) {
    const points = [];
    for (let i = 0; i < frames.length; i += Math.max(1, Math.floor(frames.length / 220))) {
      points.push(...(frames[i].hand?.joints || []), ...(frames[i].pen?.points || []));
    }
    if (!points.length) return;
    const bounds = [0,1,2].map(k => {
      const values = points.map(point => point[k]).sort((a,b) => a-b);
      const trim = Math.floor(values.length * .012);
      return [values[trim], values[values.length - 1 - trim]];
    });
    this.center = bounds.map(([a,b]) => (a+b)/2);
    this.extent = Math.max(...bounds.map(([a,b]) => (b-a)/2), 0.001) * 1.23;
    this.reset();
  }

  show(frame) { this.frame = frame; this.draw(); }

  draw() {
    const { canvas, ctx } = this;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpi = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w*dpi) || canvas.height !== Math.round(h*dpi)) {
      canvas.width = Math.round(w*dpi);
      canvas.height = Math.round(h*dpi);
    }
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    const background = ctx.createRadialGradient(w*.49,h*.39,0,w*.52,h*.51,Math.max(w,h)*.66);
    background.addColorStop(0, '#242c3a');
    background.addColorStop(1, '#141922');
    ctx.fillStyle = background;
    ctx.fillRect(0,0,w,h);
    const { yaw, pitch, zoom } = this.camera;
    const c = Math.cos(yaw), s = Math.sin(yaw), u = Math.cos(pitch), v = Math.sin(pitch);
    const scale = Math.min(w*.54,h*.45) / this.extent * zoom;
    const project = point => {
      const [x,y,z] = sub(point,this.center);
      const rx = x*c-z*s, rz = x*s+z*c;
      const ry = y*u-rz*v, depth = y*v+rz*u;
      const perspective = Math.max(.55, 1 - depth / (this.extent * 6));
      return [w*.50 + rx*scale/perspective, h*.48 - ry*scale/perspective, depth];
    };
    const stroke = (a,b,color,lineWidth=1) => {
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.stroke();
    };
    if (this.grid) {
      const step = this.extent/3, floor = this.center[1]-this.extent*.86;
      for (let i = -7; i <= 7; i++) {
        const x = this.center[0]+i*step, z = this.center[2]+i*step;
        const fade = .07 + (1-Math.abs(i)/8)*.12;
        stroke(project([x,floor,this.center[2]-step*7]),project([x,floor,this.center[2]+step*7]),`rgba(149,164,193,${fade})`);
        stroke(project([this.center[0]-step*7,floor,z]),project([this.center[0]+step*7,floor,z]),`rgba(149,164,193,${fade})`);
      }
    }
    const joints = this.frame?.hand?.joints.map(project);
    const pen = this.frame?.pen?.points.map(project);
    const commands = [];
    const thickness = Math.max(3, Math.min(16, h * .022 * zoom));
    if (joints) {
      const outline = [0,1,2,5,9,13,17].map(i => joints[i]);
      commands.push({ depth: joints[0][2] - this.extent*.14, draw: () => {
        ctx.beginPath(); outline.forEach((point,i) => i ? ctx.lineTo(...point.slice(0,2)) : ctx.moveTo(...point.slice(0,2)));
        ctx.closePath(); ctx.fillStyle = '#4668c359'; ctx.fill();
      } });
      for (const [i,j] of bones) {
        const a = joints[i], b = joints[j];
        commands.push({ depth: (a[2]+b[2])/2, draw: () => {
          stroke(a,b,'#324984',thickness+3);
          stroke(a,b,'#698afb',thickness);
          stroke([a[0]-1,a[1]-1],[b[0]-1,b[1]-1],'#a3b8ff77',Math.max(1,thickness*.25));
        } });
      }
      for (const [x,y,depth] of joints) commands.push({ depth: depth + .0001, draw: () => {
        ctx.beginPath(); ctx.arc(x,y,thickness*.47,0,Math.PI*2); ctx.fillStyle='#9db3ff'; ctx.fill();
      } });
    }
    if (pen) {
      for (let i=0;i<8;i++) {
        const a=mix(...pen,i/8), b=mix(...pen,(i+1)/8);
        commands.push({ depth:(a[2]+b[2])/2, draw: () => {
          const weak=this.frame.pen.state==='inferred';
          stroke(a,b,weak ? '#bc7858' : '#a94f2d',thickness*1.28);
          stroke(a,b,weak ? '#e69f7c' : i===0 ? '#ffe0b8' : i===7 ? '#f6804e' : '#ff9b63',thickness*.94);
          stroke([a[0]-1,a[1]-1],[b[0]-1,b[1]-1],'#ffe3b59a',Math.max(1,thickness*.23));
        } });
      }
    }
    commands.sort((a,b) => a.depth-b.depth).forEach(command => command.draw());
    if (this.grid) {
      const origin = [33,h-33], axes = [[1,0,0],[0,1,0],[0,0,1]];
      axes.forEach((axis,i) => {
        const target = sub(project(add(this.center, mul(axis, this.extent*.26))), project(this.center));
        const direction = mul(target, 26 / Math.max(25, Math.hypot(...target.slice(0,2))));
        const end = [origin[0]+direction[0],origin[1]+direction[1]];
        const colors = ['#fb8b81','#87cab4','#91acff'];
        stroke(origin,end,colors[i],1.5);
        ctx.fillStyle=colors[i]; ctx.font='10px monospace';
        ctx.fillText('XYZ'[i],end[0]+3,end[1]-2);
      });
    }
  }
}
