// Keyboard and mouse. Top-down means no pointer lock and no look deltas: the
// player faces wherever the cursor is, which is the whole aiming model.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.fresh = new Set();
    this.mouse = { x: 0, y: 0 };
    this.captureText = false;
    this.crouchToggled = false;

    window.addEventListener('keydown', (e) => {
      if (this.captureText) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.fresh.add(e.code);   // ignore auto-repeat
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.fresh.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.fresh.clear(); });

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
  }

  down(code) { return this.keys.has(code); }

  // True once per physical press, so a toggle cannot fire every frame the key
  // happens to be held.
  pressed(code) {
    if (!this.fresh.has(code)) return false;
    this.fresh.delete(code);
    return true;
  }

  // Movement in world axes. Normalised, so a diagonal is not faster.
  axis() {
    let x = 0, y = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) y -= 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }
}
