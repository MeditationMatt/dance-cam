// One Euro filter (Casiez et al.) — low lag at speed, low jitter at rest.
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.6, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.prev = null;
  }
  filter(value, dt) {
    if (this.prev === null || dt <= 0) {
      this.prev = value;
      this.x.y = value;
      this.dx.y = 0;
      return value;
    }
    const d = (value - this.prev) / dt;
    const ed = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    const out = this.x.filter(value, alpha(cutoff, dt));
    this.prev = out;
    return out;
  }
}

// Filters an array of {x,y,z} points, one OneEuro per coordinate.
export class PointSetFilter {
  constructor(count) {
    this.count = count;
    this.filters = [];
    for (let i = 0; i < count * 3; i++) this.filters.push(new OneEuro());
    this.lastT = null;
  }
  setParams(minCutoff, beta) {
    for (const f of this.filters) { f.minCutoff = minCutoff; f.beta = beta; }
  }
  reset() {
    for (const f of this.filters) f.prev = null;
    this.lastT = null;
  }
  filter(points, tSec) {
    const dt = this.lastT === null ? 0 : Math.min(0.25, tSec - this.lastT);
    this.lastT = tSec;
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      out[i] = {
        x: this.filters[i * 3].filter(p.x, dt),
        y: this.filters[i * 3 + 1].filter(p.y, dt),
        z: this.filters[i * 3 + 2].filter(p.z, dt),
        visibility: p.visibility ?? 1,
      };
    }
    return out;
  }
}
