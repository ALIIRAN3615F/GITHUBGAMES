# DEAD AIR

A top-down **co-op LAN horror game** that runs in the browser. HTML5 canvas on
the front, a zero-dependency Node WebSocket server on the back. One machine
hosts, everyone else opens a URL. No install, no accounts, no internet.

> The power is out. Five fuses are somewhere in the dark.
> Feed them all to the generator, find the panel by the exit, press it.
> Something down here is listening, and your torch is the loudest thing you own.

It is the same facility as [SIGNAL LOST](../README.md), seen from above — and
because it draws a few hundred shapes instead of a few hundred thousand
triangles, it runs on anything with a browser.

---

## Run it

```bash
cd dead-air
npm start
```

No dependencies to install. The server prints every address your friends can
reach, and defaults to port **8090** so it can run alongside SIGNAL LOST:

```
-----------------------------------------------------
  D E A D   A I R

    This machine:   http://localhost:8090

    On the LAN, everyone else opens:
      http://192.168.1.24:8090   (en0)

    Up to 8 players. First to join hosts the lobby.
-----------------------------------------------------
```

Run on another port with `npm start -- --port 8091` (or set `PORT`).

## Controls

| | |
|---|---|
| `W A S D` | move |
| `Mouse` | aim — your torch points where the cursor is |
| `Shift` | sprint — fast, and *loud* |
| `C` | crouch (toggle) — slow, quiet, and very hard to see |
| `Ctrl` | hold to crouch |
| `F` | flashlight on/off |
| `E` | hold to interact (take a fuse, seat it, take a battery, throw the switch, press the door button, revive) |
| `R` | load a fresh battery |
| `Q` | drop the fuse you are carrying |
| `T` | radio (text chat) |
| `Tab` | scoreboard |
| `Esc` | pause, settings, leave |

## How it plays

**The dark is real dark.** Every wall in the facility casts a shadow, and the
only things that light anything are your torch, the small halo each survivor
carries, and — once the generator is running — the ceiling lamps. Point the
torch down a corridor and the corridor is there; point it away and it is gone.

**You remember where you have been.** Anything you have had a clear line to
stays faintly visible afterwards, so the map fills itself in as you explore.
It shows you the walls. It does not show you what is standing between them.

**One fuse at a time.** Every fuse is a round trip into the dark and back to
the generator, which means splitting up, and splitting up is how people die.

**Light is a consumable.** Your torch runs on a charge that only ever goes
down, and it dims and stutters as it drains. There are 24 spare batteries
scattered around; picking one up banks it, and `R` spends exactly one. Fuses
are live cells, so carrying one to the generator tops your torch right back up.

**It hunts by sound and by light.** Sprinting is the loudest thing you can do.
Your torch roughly doubles how far away you can be picked out. Crouching in the
dark makes you nearly invisible — and nearly blind. Seating a fuse is loud
enough to call it over, so the safest moment to run for the next one is the
moment after somebody else has just finished.

**You get time first.** It sleeps for the opening minutes — a little over two
on Normal — and nothing you do wakes it early. That window is for learning the
layout and finding the generator before anything is hunting you. When it does
get up, you hear it.

**It is faster than a walk and slower than a sprint.** Strolling away does not
work. Sprinting does, at the cost of your whole stamina bar and every scrap of
quiet you had.

**The door does not open itself.** Seating every fuse starts the generator and
lights the panel set into the wall beside the exit. Somebody still has to walk
over there and press the button, and then wait out several seconds of shutter
motor in a building with something in it. Once the shutter is up it stays up:
cutting the power afterwards cannot strand anyone behind it.

**Nobody dies alone if you are quick.** Getting caught puts you down, bleeding
out, and you drop whatever you were carrying. A teammate can reach you and hold
`E`. Each rescue buys less time than the last.

## What is in here

```
server/
  index.js      static file server + WebSocket host, prints LAN addresses
  wsserver.js   RFC 6455 WebSocket implementation (handshake, framing, ping/pong)
  game.js       authoritative session: the monster, objectives, the door, downs
  mapgen.js     procedural facility: braided maze, rooms, props, the sealed exit
  pathfind.js   BFS routing and a grid march for line of sight, in tile space
  rng.js        seeded PRNG, so a seed always rebuilds the same facility
public/
  index.html    game shell and menus
  css/          interface styling
  js/main.js    round state machine, local simulation, glue
  js/render.js  the level painted once, entities and film drawn every frame
  js/shadow.js  wall segments, shadow volumes, and the light mask
  js/audio.js   every sound, synthesised at runtime
  js/input.js   keyboard and cursor
  js/net.js     WebSocket client
  js/hud.js     menus, meters, chat, results
test/
  map.test.js       connectivity, the sealed alcove, placement, pathfinding
  session.test.js   the round end to end, and what a tampered client cannot do
  monster.test.js   perception: the exploration phase, crouching, no wallhacks
```

**No asset files.** Every surface is drawn with canvas primitives and a
deterministic hash, and every sound — footsteps, the growl, the scream, the
shutter motor, the room itself — is synthesised from oscillators and noise
buffers.

### How the shadows work

Each solid cell contributes the edges that border open space, and collinear
runs are merged, so a long corridor wall is one segment rather than forty. For
each light, the segments facing it are projected away from it and the resulting
quads are punched out of that light's falloff. Every light is accumulated into
one mask, which is multiplied over the scene. Two offscreen canvases do all of
it and are reused every frame.

The level itself — floor, walls, props — is painted once into an offscreen
canvas the size of the whole map and blitted, so what a frame actually costs is
a blit, a handful of moving shapes, and the lights.

### How the network is split

Clients own their own movement and tell the server where they ended up; the
server clamps that against the same speed constants, refuses anything inside
geometry, and refuses any step whose *path* crosses geometry — not just its
destination. Everything that can be cheated or has to agree across machines is
decided by the server and broadcast at 15 Hz. Clients render about 110 ms in
the past and interpolate, so nobody teleports between frames.

## Tests

```bash
npm test
```

38 tests, no dependencies. They cover the things that break quietly: that every
generated map keeps its generator and every fuse reachable from the spawn, that
the exit alcove is genuinely sealed until the shutter is up, that objectives
refuse action at a distance, that a tampered client can neither teleport nor
slide through a wall when its movement is clamped, that the monster never
learns a position it could not see or hear, and that a full round runs from the
spawn to the surface.

## Requirements

Any current browser. Node 16+ on the host machine. Headphones are worth it: the
audio is positional, and which side a sound came from is information.

## License

MIT
