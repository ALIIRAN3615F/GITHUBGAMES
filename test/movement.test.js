'use strict';

// Client movement/orientation tests.
//
// These exist because of a real bug: the WASD transform used the textbook 2D
// rotation, which has the opposite handedness to three's rotation about Y. The
// result was movement mirrored about the Z axis - pressing forward walked you
// sideways at every angle except due north and south. Distance-based tests did
// not catch it, so these assert on direction.

const test = require('node:test');
const assert = require('node:assert');

const load = async () => ({
  THREE: await import('../public/vendor/three.module.js'),
  player: await import('../public/js/player.js'),
});

// Where a camera at this yaw actually looks. Camera.getWorldDirection returns
// local -Z (Object3D's returns +Z - mixing them up is how this bug was born).
function cameraLook(THREE, yaw) {
  const cam = new THREE.PerspectiveCamera();
  cam.rotation.set(0, 0, 0);
  cam.rotateY(yaw);
  const v = new THREE.Vector3();
  cam.getWorldDirection(v);
  return v;
}

const angleBetween = (ax, az, bx, bz) => {
  const dot = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz));
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
};

test('W walks along the direction the camera is looking, at every yaw', async () => {
  const { THREE, player } = await load();
  for (let deg = 0; deg < 360; deg += 15) {
    const yaw = deg * Math.PI / 180;
    const wish = player.moveVector({ x: 0, z: -1 }, yaw);
    const look = cameraLook(THREE, yaw);
    const off = angleBetween(wish.x, wish.z, look.x, look.z);
    assert.ok(off < 0.001, `yaw ${deg}: forward is ${off.toFixed(1)} degrees off the view direction`);
  }
});

test('S walks backwards, not forwards', async () => {
  const { THREE, player } = await load();
  for (let deg = 0; deg < 360; deg += 45) {
    const yaw = deg * Math.PI / 180;
    const wish = player.moveVector({ x: 0, z: 1 }, yaw);
    const look = cameraLook(THREE, yaw);
    const off = angleBetween(wish.x, wish.z, look.x, look.z);
    assert.ok(Math.abs(off - 180) < 0.001, `yaw ${deg}: back is ${off.toFixed(1)} degrees from the view`);
  }
});

test('A and D strafe square to the view, and to opposite sides', async () => {
  const { THREE, player } = await load();
  for (let deg = 0; deg < 360; deg += 45) {
    const yaw = deg * Math.PI / 180;
    const left = player.moveVector({ x: -1, z: 0 }, yaw);
    const right = player.moveVector({ x: 1, z: 0 }, yaw);
    const look = cameraLook(THREE, yaw);

    assert.ok(Math.abs(angleBetween(left.x, left.z, look.x, look.z) - 90) < 0.001,
      `yaw ${deg}: strafe left is not perpendicular to the view`);
    assert.ok(Math.abs(angleBetween(right.x, right.z, look.x, look.z) - 90) < 0.001,
      `yaw ${deg}: strafe right is not perpendicular to the view`);

    // D must be the player's right, i.e. look x up.
    const trueRight = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0));
    assert.ok(Math.abs(right.x - trueRight.x) < 1e-9 && Math.abs(right.z - trueRight.z) < 1e-9,
      `yaw ${deg}: D strafes to the wrong side`);
    assert.ok(Math.abs(left.x + right.x) < 1e-9 && Math.abs(left.z + right.z) < 1e-9,
      `yaw ${deg}: A and D are not opposites`);
  }
});

test('diagonals combine, and moving does not change speed with facing', async () => {
  const { player } = await load();
  const axis = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };   // W + D, normalised
  for (let deg = 0; deg < 360; deg += 30) {
    const wish = player.moveVector(axis, deg * Math.PI / 180);
    assert.ok(Math.abs(Math.hypot(wish.x, wish.z) - 1) < 1e-9,
      `yaw ${deg}: rotation changed the movement speed`);
  }
});

test('the spawn-facing table looks down the grid direction it claims', async () => {
  const { THREE } = await load();
  // Mirrors the table in main.js bestFacing(). Grid +y is world +z.
  const table = [
    { name: 'north', dx: 0, dz: -1, yaw: 0 },
    { name: 'east', dx: 1, dz: 0, yaw: -Math.PI / 2 },
    { name: 'south', dx: 0, dz: 1, yaw: Math.PI },
    { name: 'west', dx: -1, dz: 0, yaw: Math.PI / 2 },
  ];
  for (const row of table) {
    const look = cameraLook(THREE, row.yaw);
    assert.ok(Math.abs(look.x - row.dx) < 1e-6 && Math.abs(look.z - row.dz) < 1e-6,
      `${row.name}: yaw ${row.yaw.toFixed(2)} looks (${look.x.toFixed(2)},${look.z.toFixed(2)}), wanted (${row.dx},${row.dz})`);
  }

  // And the source must still agree with what is asserted here.
  const src = require('fs').readFileSync(require.resolve('../public/js/main.js'), 'utf8');
  // Anchor on the method definition; the call site appears earlier.
  const start = src.indexOf('bestFacing(spawn) {');
  const block = src.slice(start, start + 600);
  assert.ok(block.includes('{ dx: 0, dy: -1, yaw: 0 }'), 'north yaw in main.js no longer matches this test');
  assert.ok(block.includes('{ dx: 0, dy: 1, yaw: Math.PI }'), 'south yaw in main.js no longer matches this test');
});

test('a survivor avatar aims its flashlight where that player is looking', async () => {
  const { THREE } = await load();
  // The avatar carries no beam geometry any more - a cone mesh read as a solid
  // object sticking out of the player. A pooled spotlight is aimed instead,
  // composing yaw and pitch exactly as the owner's camera does (YXZ).
  for (const yawDeg of [0, 90, 180, 270]) {
    for (const pitch of [-0.8, 0, 0.6]) {
      const yaw = yawDeg * Math.PI / 180;
      const beam = new THREE.Vector3(0, 0, -1)
        .applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

      const cam = new THREE.PerspectiveCamera();
      cam.rotation.set(0, 0, 0);
      cam.rotateY(yaw);
      cam.rotateX(pitch);
      const look = new THREE.Vector3();
      cam.getWorldDirection(look);

      const off = Math.acos(Math.max(-1, Math.min(1, beam.dot(look)))) * 180 / Math.PI;
      assert.ok(off < 0.001,
        `yaw ${yawDeg} pitch ${pitch}: beam is ${off.toFixed(1)} degrees off the view`);
    }
  }

  const src = require('fs').readFileSync(require.resolve('../public/js/entities.js'), 'utf8');
  assert.ok(!/const cone = new THREE\.Mesh/.test(src),
    'the beam cone mesh is back - it reads as an object, not as light');
  assert.ok(src.includes("new THREE.Euler(owner.entity.data.pitch || 0, g.rotation.y, 0, 'YXZ')"),
    'the pooled flashlight no longer aims with pitch');
});

test('the monster faces the way it is walking', async () => {
  const { THREE } = await load();
  // Server sets yaw = atan2(dx, dz); the model's front is local +Z.
  for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0], [0.6, -0.8]]) {
    const yaw = Math.atan2(dx, dz);
    const o = new THREE.Object3D();
    o.rotation.y = yaw;
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
    const off = angleBetween(front.x, front.z, dx, dz);
    assert.ok(off < 0.001, `travelling (${dx},${dz}): model is ${off.toFixed(0)} degrees off`);
  }
});
