import * as THREE from './vendor/three/three.module.js';

const MAX_POINTS = 32;
const SAMPLES = 256;
const finitePoint = point => [0, 1, 2].map(i => Number.isFinite(Number(point?.[i])) ? THREE.MathUtils.clamp(Number(point[i]), -1e6, 1e6) : 0);

export class RailOverlay extends THREE.Group {
  constructor() {
    super();
    this.name = 'Lumen_CameraRail_Overlay';
    this.userData.editorOnly = true;
    this.visible = false;
    this._signature = '';
    this._disposed = false;
    this._matrix = new THREE.Matrix4();
    this._point = new THREE.Vector3();
    this._curve = new THREE.CatmullRomCurve3([], false, 'centripetal');

    const curveGeometry = new THREE.BufferGeometry();
    curveGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SAMPLES + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    curveGeometry.setDrawRange(0, 0);
    this.path = new THREE.Line(curveGeometry, new THREE.LineBasicMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
    this.path.name = 'Lumen_CameraRail_Curve';
    this.path.renderOrder = 12;
    this.path.frustumCulled = false;

    const controlGeometry = new THREE.BufferGeometry();
    controlGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    controlGeometry.setDrawRange(0, 0);
    this.controlPolygon = new THREE.Line(controlGeometry, new THREE.LineBasicMaterial({ color: '#9fb8ce', transparent: true, opacity: 0.32, depthTest: false, depthWrite: false }));
    this.controlPolygon.name = 'Lumen_CameraRail_ControlPolygon';
    this.controlPolygon.renderOrder = 11;
    this.controlPolygon.frustumCulled = false;

    this.controlPoints = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshBasicMaterial({ color: '#9fd8ff', depthTest: false, depthWrite: false }), MAX_POINTS);
    this.controlPoints.name = 'Lumen_CameraRail_ControlPoints';
    this.controlPoints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.controlPoints.count = 0;
    this.controlPoints.renderOrder = 13;
    this.controlPoints.frustumCulled = false;

    const targetGeometry = new THREE.BufferGeometry();
    targetGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.16, 0, 0, 0.16, 0, 0, 0, -0.16, 0, 0, 0.16, 0, 0, 0, -0.16, 0, 0, 0.16,
    ], 3));
    this.target = new THREE.LineSegments(targetGeometry, new THREE.LineBasicMaterial({ color: '#f2ca90', depthTest: false, depthWrite: false }));
    this.target.name = 'Lumen_CameraRail_LookAt';
    this.target.renderOrder = 14;
    this.add(this.controlPolygon, this.path, this.controlPoints, this.target);
    this.traverse(part => { part.userData.editorOnly = true; });
  }

  update(rail = {}) {
    if (this._disposed) throw new Error('Camera rail overlay has been disposed');
    const points = (Array.isArray(rail.points) ? rail.points : []).slice(0, MAX_POINTS).map(finitePoint);
    const valid = points.length >= 2;
    this.visible = !!rail.enabled && valid;
    this.target.position.fromArray(finitePoint(rail.lookAt || [0, 1, 0]));
    this.target.visible = valid && rail.orientation !== 'tangent';
    const signature = JSON.stringify(points);
    if (signature === this._signature) return this;
    this._signature = signature;
    this.controlPoints.count = points.length;
    this.controlPolygon.geometry.setDrawRange(0, points.length);
    const controls = this.controlPolygon.geometry.attributes.position;
    points.forEach((point, i) => {
      controls.setXYZ(i, ...point);
      this._matrix.makeTranslation(...point);
      this.controlPoints.setMatrixAt(i, this._matrix);
    });
    controls.needsUpdate = true;
    this.controlPoints.instanceMatrix.needsUpdate = true;
    this.path.geometry.setDrawRange(0, valid ? SAMPLES + 1 : 0);
    if (valid) {
      this._curve.points = points.map(point => new THREE.Vector3(...point));
      this._curve.updateArcLengths();
      const positions = this.path.geometry.attributes.position;
      for (let i = 0; i <= SAMPLES; i++) {
        this._curve.getPointAt(i / SAMPLES, this._point);
        positions.setXYZ(i, this._point.x, this._point.y, this._point.z);
      }
      positions.needsUpdate = true;
    }
    return this;
  }

  dispose() {
    if (this._disposed) return;
    for (const object of [this.path, this.controlPolygon, this.controlPoints, this.target]) {
      object.geometry.dispose(); object.material.dispose();
    }
    this.controlPoints.dispose();
    this.clear(); this.removeFromParent(); this._disposed = true;
  }
}
