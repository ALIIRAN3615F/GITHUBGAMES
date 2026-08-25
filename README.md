# SIGNAL LOST

A co-op **LAN horror game** that runs in the browser. HTML5 + WebGL via three.js on the
front, a zero-dependency Node WebSocket server on the back. One machine hosts, everyone
else opens a URL. No install, no accounts, no internet required.

> The power is out. Six fuses are scattered somewhere in the dark.
> Feed them all to the generator, find the panel beside the bulkhead, and press
> the button. Whatever is on the other side of that door is not the surface.
> Something else is down here, and it hunts by sound and by light.

---

## Run it

```bash
git clone <this repo>
cd GITHUBGAMES
npm start
```

That's the whole setup — there are **no dependencies to install**. The server prints
every address your friends can reach:

```
-----------------------------------------------------
  S I G N A L   L O S T

    This machine:   http://localhost:8080

    On the LAN, everyone else opens:
      http://192.168.1.24:8080   (en0)

    Up to 8 players. First to join hosts the lobby.
-----------------------------------------------------
```

Everyone on the same Wi-Fi opens that address in a browser. First player in is the host
and controls difficulty, map size, fuse count, and when the run starts. Latecomers drop
straight into a round in progress.

Run on another port with `npm start -- --port 8081` (or set `PORT`).

## Controls

| | |
|---|---|
| `W A S D` | move |
| `Shift` | sprint — fast, and *loud* |
| `C` | crouch (toggle) — slow, and very hard to see |
| `Ctrl` | hold to crouch |
| `F` | flashlight on/off |
| `E` | hold to interact (take fuse, seat fuse, take battery, throw the power switch, press the door button, take the rifle, climb, revive) |
| `Mouse 1` | fire the rifle, if you are carrying it |
| `R` | reload — the rifle if it needs it, otherwise a fresh battery for the flashlight |
| `Q` | drop the fuse you are carrying |
| `G` | drop the rifle |
| `T` | radio (text chat) |
| `Tab` | scoreboard |
| `Esc` | pause, settings, leave |

## How it actually plays

**You carry one fuse at a time.** Every fuse is its own round trip into the dark and
back to the generator, which means splitting up — and splitting up is how people die.

**Light is a consumable.** Your flashlight runs on a charge that only ever goes
down. There are **24 spare batteries** hidden around the facility; picking one up
banks it in reserve rather than spending it, and `R` loads exactly one when you
need it. Fuses are live cells, so carrying one to the generator tops your
flashlight straight back to full - which is the compensation for hauling the most
dangerous object in the building across it.

**The generator is a building-wide switch.** Seat every fuse and it starts,
lighting the whole facility rather than just its own room. After that it stays a
switch: anyone standing at it can cut the power and put the building back into
darkness. Sometimes you will want to. The lights make you visible from a long way
off, and the thing down here is drawn to them.

**The bulkhead does not open itself.** Power reaches a control panel set into the
wall beside it, and the panel reads `POWER: OFF` until it does. Somebody still has
to walk over there and press the button. Then a shutter motor takes six seconds to
wind a roller door up out of the floor, in a building with something listening in
it, and once it is up it stays up — cutting the power afterwards will not strand
anyone behind it.

**The door is not the ending.** Behind it is a short concrete passage, and at the
end of that the wall has come away. What is on the other side is lit, yellow, and
goes on for a long way. Nothing hunts you there. There is no marker, no objective
text and nothing to fight: somewhere in the partitions there is one opening into a
corridor a hundred metres long, and at the end of that a ladder to a vent in the
ceiling. That is the way out.

**There is one rifle.** An AK-47, somewhere in the middle distance of the
facility, with thirty rounds in it and thirty more in reserve, and nothing
anywhere that reloads it. It takes ten rounds to put the monster down, and it does
not stay down — it gets back up in under a minute, and it is faster afterwards.
A full loadout buys you six of those, if every round lands, which it will not.
The rifle is there to buy a corridor, not to win a fight. Friendly fire is on, the
server decides every hit, and four rounds will put a teammate on the floor.

**Two endings.** Get through the bulkhead, find the corridor, climb the ladder and
get into the vent — or find the gasoline can hidden in the far half of the
facility, pour it into the generator, and take the other one: the machine labours,
sparks, and takes the building with it. The two never trigger each other.

**You get time first.** The monster sleeps for the opening minutes - two and a
half on Normal - and nothing you do wakes it early. That window is for learning
the layout, finding batteries and locating the generator before anything is
hunting you. When it does get up, you hear it.

**The monster hunts by sound and light.** Sprinting is the loudest thing you can do.
Your flashlight is a beacon it can see from across the level. Crouching in the dark makes you
nearly invisible, and nearly blind. Seating a fuse is loud enough to call it to the
generator, so the safest moment to run for the next one is the moment after someone
else has just finished.

**It gets worse as you win.** Every fuse you seat makes it faster and sharpens its
hearing. When the last fuse lands the lights come up and it knows exactly where you
are — and the walk to the door panel, and the six seconds of shutter motor after
you press the button, are meant to be the worst of the round.

**Nobody dies alone if you're quick.** Getting caught puts you down, bleeding out, and
you drop whatever you were carrying. A teammate can reach you and hold `E`. Each rescue
buys less time than the last, so the third mistake is usually the one that sticks.

Difficulty changes the monster's speed, hearing, how long you have before it wakes, and
how long you bleed. **Nightmare** puts two of them down there with you.

## What is in here

```
server/
  index.js      static file server + WebSocket host, prints LAN addresses
  wsserver.js   RFC 6455 WebSocket implementation (handshake, framing, ping/pong)
  game.js       authoritative session: monster AI, objectives, the door, the
                rifle and every shot fired, downs, revives, zones
  mapgen.js     procedural facility: braided maze, chambers, props, objectives,
                and the doorway bored through a wall with a sealed passage behind
  backrooms.js  the second level: partitions, halls, the long corridor, the ladder
  pathfind.js   BFS routing and DDA line-of-sight on the grid
  rng.js        seeded PRNG, so a seed always rebuilds the same facility
public/
  index.html    game shell and menus
  css/          interface styling
  js/main.js    renderer, round state machine, glue
  js/world.js   level geometry, instanced walls and props, the shutter, light budget
  js/backrooms.js the second level: yellow walls, carpet, hundreds of fluorescents
  js/weapon.js  the rifle, modelled and animated, drawn in its own render pass
  js/entities.js monster, survivors and fuses, with snapshot interpolation
  js/player.js  local movement, flashlight, stamina, nerve
  js/audio.js   every sound, synthesised at runtime
  js/textures.js every surface, painted into a canvas at startup
  js/net.js     WebSocket client
  js/hud.js     menus, meters, chat, results
  js/fx.js      grain, vignette, damage flash
  vendor/       three.js r160 (vendored so LAN play needs no internet)
test/
  logic.test.js   map connectivity, WebSocket framing, a full round end to end
  movement.test.js the movement transform, in isolation
  collision.test.js walls, props and the doorway aperture
  monster.test.js  perception: the exploration phase, crouching, no wallhacks
  endings.test.js  the fuel can, the fire, and keeping the endings apart
  overhaul.test.js the sealed doorway, the shutter, zones, the rifle, the vent
```

**No asset files.** Every texture is drawn into a `<canvas>` at load, and every sound —
footsteps, the growl, the scream, the generator, the reverb of the rooms — is
synthesised from oscillators and noise buffers. That is why the whole game is about a
megabyte, most of which is three.js.

### How the network is split

Clients own their own movement and tell the server where they ended up; the server
clamps that against the same speed constants and rejects positions inside geometry. On a
LAN this feels immediate in a way server-side prediction does not. Everything that can
be cheated or has to agree across machines — the monster, the fuses, the generator, who
is down and who got revived — is decided by the server and broadcast at 15 Hz. Clients
render ~110 ms in the past and interpolate, so a sprinting monster never teleports
between frames.

## Tests

```bash
npm test
```

106 tests, no dependencies, about a second. They cover the things that break quietly:
that every generated map keeps its generator and every fuse reachable from the spawn,
that the emergency doorway is always an opening in a real wall with rock on both flanks
and a sealed dead end behind it, that boring that passage never cuts the facility in two
(all checked across 60 seeds and all three sizes), that nothing can reach the far side
before the shutter is up, that the WebSocket codec survives split packets and 64-bit
payload lengths, that objectives reject action at a distance, that a tampered client
cannot teleport or fire faster than the rifle can, that the monster never learns a
position it cannot see or hear, and that a full round runs from the spawn through the
door and out through the vent.

## Requirements

Any current browser with WebGL2 and pointer lock — Chrome, Edge, Firefox or Safari.
Node 16+ on the host machine. Headphones are strongly recommended: the audio is
positional, and knowing which corridor a sound came from is the difference between
getting out and not.

The game watches its own frame time and quietly lowers render resolution when it
cannot hold ~40 fps, restoring it when there is headroom again, so a weaker machine
degrades in sharpness rather than in smoothness. If it still struggles, drop
**Graphics** to Low in the pause menu (`Esc`): that turns off shadows, the ceiling
lamps and other players' flashlight lights, which is where nearly all the remaining cost
is. The scene itself is cheap — a whole maze is one instanced draw call — so the
limit is per-pixel lighting, which is exactly what resolution trades against.

## License

MIT
