import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/OrbitControls.js';
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

const up = new THREE.Vector3(0, 1, 0);
const defaultDirection = new THREE.Vector3(0.37, 0.19, 1).normalize();
const meshMaterial = (color, roughness = 0.48) => new THREE.MeshStandardMaterial({ color, roughness });

function alignSegment(mesh, start, end) {
  mesh.position.copy(start).lerp(end, 0.5);
  const direction = mesh.userData.direction ??= new THREE.Vector3();
  direction.subVectors(end, start);
  mesh.scale.y = direction.length();
  if (mesh.scale.y > 0) mesh.quaternion.setFromUnitVectors(up, direction.normalize());
}

function makePen() {
  const group = new THREE.Group();
  const shaft = meshMaterial(0xf28b54, 0.36);
  const band = meshMaterial(0x733e36, 0.42);
  const cap = meshMaterial(0xffca99, 0.42);
  const tail = meshMaterial(0xcf5830, 0.42);
  const sections = [
    [-0.5, -0.43, 0.031, 0.019, cap],
    [-0.43, -0.38, 0.035, 0.035, band],
    [-0.38, 0.38, 0.033, 0.033, shaft],
    [0.38, 0.42, 0.037, 0.037, band],
    [0.42, 0.5, 0.031, 0.037, tail]
  ];
  for (const [from, to, top, bottom, material] of sections) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, to - from, 20), material);
    mesh.position.y = (from + to) / 2;
    group.add(mesh);
  }
  return { group, shaft };
}

export class MotionViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.grid = true;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch {
      document.getElementById('viewer-unavailable').hidden = false;
      return;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1c2330);
    this.scene.fog = new THREE.Fog(0x1c2330, 4.5, 10);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.035, 40);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.75;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 14;

    const light = new THREE.DirectionalLight(0xf2f5ff, 2.4);
    light.position.set(-3, 5, 6);
    const rim = new THREE.DirectionalLight(0xb0c2ff, 1.3);
    rim.position.set(3, 1, -4);
    this.scene.add(new THREE.HemisphereLight(0xe1eaff, 0x544361, 1.38), light, rim);
    this.floor = new THREE.Group();
    const grid = new THREE.GridHelper(12, 36, 0x60728f, 0x40506b);
    const axes = new THREE.AxesHelper(0.4);
    axes.position.set(-1, 0.01, 0.78);
    this.floor.add(grid, axes);
    this.scene.add(this.floor);

    this.center = new THREE.Vector3();
    this.extent = 1;
    this.hand = new THREE.Group();
    const jointGeometry = new THREE.SphereGeometry(1, 16, 12);
    const boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
    const jointMaterial = meshMaterial(0x9bb2ff);
    const boneMaterial = meshMaterial(0x5b7dee);
    this.joints = Array.from({ length: 21 }, (_, index) => {
      const mesh = new THREE.Mesh(jointGeometry, jointMaterial);
      mesh.scale.setScalar(index === 0 ? 0.046 : 0.032);
      this.hand.add(mesh);
      return mesh;
    });
    this.links = bones.map(([a, b]) => {
      const mesh = new THREE.Mesh(boneGeometry, boneMaterial);
      const radius = a === 0 || [5, 9, 13, 17].includes(b) ? 0.027 : 0.023;
      mesh.scale.set(radius, 1, radius);
      this.hand.add(mesh);
      return mesh;
    });
    const skin = new THREE.BufferGeometry();
    this.palmJoints = [0, 1, 5, 9, 13, 17];
    skin.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.palmJoints.length * 3), 3));
    skin.setIndex([0,1,2, 0,2,3, 0,3,4, 0,4,5]);
    this.palm = new THREE.Mesh(skin, new THREE.MeshStandardMaterial({ color: 0x344d9d, side: THREE.DoubleSide }));
    this.palm.frustumCulled = false;
    this.hand.add(this.palm);
    this.pen = makePen();
    this.tipPositions = [new THREE.Vector3(), new THREE.Vector3()];
    this.scene.add(this.hand, this.pen.group);
    this.resize();
    this.reset();
    this.controls.addEventListener('change', () => this.draw());
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      document.getElementById('viewer-unavailable').hidden = false;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      document.getElementById('viewer-unavailable').hidden = true;
      this.draw();
    });
    canvas.addEventListener('keydown', event => this.onKey(event));
  }

  resize() {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  onKey(event) {
    const actions = {
      ArrowLeft: [-0.14, 0, 1], ArrowRight: [0.14, 0, 1],
      ArrowUp: [0, -0.13, 1], ArrowDown: [0, 0.13, 1],
      '+': [0, 0, 0.87], '-': [0, 0, 1.15]
    };
    const action = actions[event.key];
    if (!action && event.key !== '0') return;
    event.preventDefault();
    if (!action) return this.reset();
    const [yaw, pitch, dolly] = action;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const angle = new THREE.Spherical().setFromVector3(offset);
    angle.theta += yaw;
    angle.phi += pitch;
    angle.makeSafe();
    angle.radius *= dolly;
    this.camera.position.copy(offset.setFromSpherical(angle).add(this.controls.target));
    this.controls.update();
  }

  reset() {
    if (!this.renderer) return;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfWidth = Math.atan(Math.tan(halfFov) * this.camera.aspect);
    const distance = 1.08 / Math.sin(Math.min(halfFov, halfWidth));
    this.controls.target.set(0, 0.02, 0);
    this.camera.position.copy(defaultDirection).multiplyScalar(distance).add(this.controls.target);
    this.controls.update();
    this.draw();
  }

  fit(frames) {
    if (!this.renderer) return;
    const points = [];
    for (let i = 0; i < frames.length; i += Math.max(1, Math.floor(frames.length / 220))) {
      points.push(...(frames[i].hand?.joints || []), ...(frames[i].pen?.points || []));
    }
    if (!points.length) return;
    const bounds = [0, 1, 2].map(axis => {
      const values = points.map(point => point[axis]).sort((a, b) => a - b);
      const trim = Math.floor(values.length * 0.012);
      return [values[trim], values[values.length - 1 - trim]];
    });
    this.center.fromArray(bounds.map(([a, b]) => (a + b) / 2));
    this.extent = Math.max(Math.hypot(...bounds.map(([a, b]) => (b - a) / 2)), 1e-6);
    this.floor.position.y = (bounds[1][0] - this.center.y) / this.extent - 0.15;
    this.reset();
  }

  show(frame) {
    if (!this.renderer) return;
    this.hand.visible = Boolean(frame?.hand);
    this.pen.group.visible = Boolean(frame?.pen);
    if (frame?.hand) {
      for (let i = 0; i < this.joints.length; i++) {
        this.joints[i].position.fromArray(frame.hand.joints[i]).sub(this.center).divideScalar(this.extent);
      }
      this.links.forEach((mesh, i) => {
        const [a, b] = bones[i];
        alignSegment(mesh, this.joints[a].position, this.joints[b].position);
      });
      const palm = this.palm.geometry.getAttribute('position');
      this.palmJoints.forEach((joint, i) => {
        const { x, y, z } = this.joints[joint].position;
        palm.setXYZ(i, x, y, z);
      });
      palm.needsUpdate = true;
      this.palm.geometry.computeVertexNormals();
    }
    if (frame?.pen) {
      this.tipPositions.forEach((tip, i) => tip.fromArray(frame.pen.points[i]).sub(this.center).divideScalar(this.extent));
      alignSegment(this.pen.group, ...this.tipPositions);
      this.pen.shaft.color.setHex(frame.pen.state === 'inferred' ? 0xbf8069 : 0xf28b54);
    }
    this.draw();
  }

  draw() {
    if (!this.renderer) return;
    this.floor.visible = this.grid;
    this.renderer.render(this.scene, this.camera);
  }
}

