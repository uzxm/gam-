const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/** ----------------------
 * Game constants
 * --------------------- */
const TICK_RATE = 30;                 // server ticks per second
const DT = 1 / TICK_RATE;
const MAP_W = 1200;
const MAP_H = 800;

const PLAYER_RADIUS = 16;
const PLAYER_MOVE_SPEED = 220;        // px/sec
const BULLET_SPEED = 700;             // px/sec
const BULLET_RADIUS = 4;
const FIRE_COOLDOWN = 0.15;           // seconds
const RESPAWN_TIME = 0;               // instant

const MAX_HP = 100;
const HP_REGEN_PER_SEC = 0.2;

const MAX_ERASE = 100;
const ERASE_REGEN_PER_SEC = 1;
const ERASE_RADIUS = 60;              // px
const ERASE_COST_PER_TILE = 1;        // consumes 1 point per erased tile

const PAINT_DAMAGE_PER_SEC = 2;       // stepping on enemy paint
const HIT_DAMAGE = 5;

const TILE = 20; // grid tile size
const GRID_W = Math.ceil(MAP_W / TILE);
const GRID_H = Math.ceil(MAP_H / TILE);

// Walls: rectangles [x,y,w,h]
const WALLS = [
  [MAP_W*0.5 - 40, MAP_H*0.5 - 150, 80, 300],  // center pillar
  [200, 150, 300, 30],
  [MAP_W-500, MAP_H-200, 300, 30],
  [MAP_W-350, 120, 30, 260],
  [150, MAP_H-320, 30, 250],
];

/** Paint grid:
 * 0 = none, 1 = red, 2 = blue
 */
const paint = Array.from({ length: GRID_H }, () => new Uint8Array(GRID_W));

/** Utility */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function rectsOverlap(cx, cy, r, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx;
  const dy = cy - ny;
  return (dx*dx + dy*dy) <= r*r;
}
function collidesWithWalls(x, y, r) {
  for (const [wx,wy,ww,wh] of WALLS) {
    if (rectsOverlap(x,y,r,wx,wy,ww,wh)) return true;
  }
  return (x-r<0 || x+r>MAP_W || y-r<0 || y+r>MAP_H);
}
function lineHitsWall(x0,y0,x1,y1) {
  // Ray marching with small steps
  const dx = x1-x0, dy = y1-y0;
  const len = Math.hypot(dx,dy);
  const steps = Math.ceil(len / 5);
  for (let i=1;i<=steps;i++){
    const t = i/steps;
    const x = x0 + dx*t;
    const y = y0 + dy*t;
    if (collidesWithWalls(x,y,2)) return { x, y };
  }
  return null;
}
function pointToGrid(x,y){
  const gx = clamp(Math.floor(x/TILE), 0, GRID_W-1);
  const gy = clamp(Math.floor(y/TILE), 0, GRID_H-1);
  return [gx,gy];
}

function teamId(team){ return team==="red"?1:2; }
function enemyTeamId(team){ return team==="red"?2:1; }

function placePaintCircle(x,y,r, tid){
  const [gx,gy] = pointToGrid(x,y);
  const gr = Math.ceil(r / TILE);
  for (let yy = gy-gr; yy<=gy+gr; yy++){
    if (yy<0||yy>=GRID_H) continue;
    for (let xx = gx-gr; xx<=gx+gr; xx++){
      if (xx<0||xx>=GRID_W) continue;
      // center of tile
      const cx = xx*TILE + TILE/2;
      const cy = yy*TILE + TILE/2;
      if ((cx-x)**2 + (cy-y)**2 <= r*r) {
        paint[yy][xx] = tid;
      }
    }
  }
}

function erasePaintCircle(x,y,r, maxTiles){
  let erased = 0;
  const [gx,gy] = pointToGrid(x,y);
  const gr = Math.ceil(r / TILE);
  for (let yy = gy-gr; yy<=gy+gr; yy++){
    if (yy<0||yy>=GRID_H) continue;
    for (let xx = gx-gr; xx<=gx+gr; xx++){
      if (xx<0||xx>=GRID_W) continue;
      const cx = xx*TILE + TILE/2;
      const cy = yy*TILE + TILE/2;
      if ((cx-x)**2 + (cy-y)**2 <= r*r) {
        if (paint[yy][xx] !== 0) {
          paint[yy][xx] = 0;
          erased++;
          if (erased >= maxTiles) return erased;
        }
      }
    }
  }
  return erased;
}

/** ----------------------
 * Game state
 * --------------------- */
const players = new Map(); // socketId -> player
const bullets = [];        // active bullets

function spawnPosFor(team){
  if (team==="red")  return { x: 120, y: MAP_H-120 };
  if (team==="blue") return { x: MAP_W-120, y: 120 };
  return { x: MAP_W/2, y: MAP_H/2 };
}

function assignTeam(){
  let redTaken=false, blueTaken=false;
  for (const p of players.values()){
    if (p.role==="player") {
      if (p.team==="red") redTaken=true;
      if (p.team==="blue") blueTaken=true;
    }
  }
  if (!redTaken) return "red";
  if (!blueTaken) return "blue";
  return null; // no slots
}

function makePlayer(socketId){
  const team = assignTeam();
  const role = team ? "player" : "spectator";
  const spawn = spawnPosFor(team||"red");
  return {
    id: socketId,
    role,
    team, // undefined for spectator
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    vx: 0, vy: 0,
    hp: MAX_HP,
    erase: MAX_ERASE,
    alive: true,
    inputs: { up:false,down:false,left:false,right:false, lmb:false, rmb:false, angle:0 },
    fireCooldown: 0,
    respawnTimer: 0
  };
}

/** ----------------------
 * Sockets
 * --------------------- */
io.on("connection", (socket) => {
  const p = makePlayer(socket.id);
  players.set(socket.id, p);
  socket.emit("init", {
    you: socket.id,
    map: { w: MAP_W, h: MAP_H, tile: TILE, walls: WALLS },
  });
  io.emit("lobby", lobbySummary());

  socket.on("input", (data) => {
    const pl = players.get(socket.id);
    if (!pl) return;
    pl.inputs = { ...pl.inputs, ...data };
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("lobby", lobbySummary());
  });
});

function lobbySummary(){
  const list = [];
  for (const p of players.values()){
    list.push({ id:p.id, role:p.role, team:p.team });
  }
  return list;
}

/** ----------------------
 * Game loop
 * --------------------- */
setInterval(gameTick, 1000/TICK_RATE);

function gameTick(){
  // cooldowns
  for (const p of players.values()){
    if (p.role!=="player") continue;

    if (!p.alive) {
      p.respawnTimer -= DT;
      if (p.respawnTimer <= 0){
        const s = spawnPosFor(p.team);
        p.x = s.x; p.y = s.y; p.vx=0; p.vy=0;
        p.hp = MAX_HP;
        p.alive = true;
      }
      continue;
    }

    // Movement
    const inpt = p.inputs;
    let mx = 0, my = 0;
    if (inpt.up) my -= 1;
    if (inpt.down) my += 1;
    if (inpt.left) mx -= 1;
    if (inpt.right) mx += 1;
    const mag = Math.hypot(mx,my) || 1;
    const spd = PLAYER_MOVE_SPEED;
    let nx = p.x + (mx/mag)*spd*DT;
    let ny = p.y + (my/mag)*spd*DT;

    // simple collision resolution (axis-sep)
    // X
    let old = nx;
    if (collidesWithWalls(nx, p.y, PLAYER_RADIUS)) {
      // try slide along x by binary search to edge
      const dir = Math.sign(nx - p.x);
      let lo = p.x, hi = nx;
      for (let i=0;i<6;i++){
        const mid = (lo+hi)/2;
        if (collidesWithWalls(mid,p.y,PLAYER_RADIUS)) hi = mid; else lo = mid;
      }
      nx = lo;
    }
    // Y
    if (collidesWithWalls(nx, ny, PLAYER_RADIUS)) {
      const dir = Math.sign(ny - p.y);
      let lo = p.y, hi = ny;
      for (let i=0;i<6;i++){
        const mid = (lo+hi)/2;
        if (collidesWithWalls(nx,mid,PLAYER_RADIUS)) hi = mid; else lo = mid;
      }
      ny = lo;
    }
    p.x = nx; p.y = ny;

    // Aim angle
    p.angle = inpt.angle;

    // Regen
    p.hp = clamp(p.hp + HP_REGEN_PER_SEC*DT, 0, MAX_HP);
    p.erase = clamp(p.erase + ERASE_REGEN_PER_SEC*DT, 0, MAX_ERASE);

    // Paint damage
    const [gx,gy] = pointToGrid(p.x,p.y);
    const tileVal = paint[gy][gx];
    if (tileVal === enemyTeamId(p.team)) {
      p.hp = clamp(p.hp - PAINT_DAMAGE_PER_SEC * DT, 0, MAX_HP);
    }

    // Fire
    p.fireCooldown = Math.max(0, p.fireCooldown - DT);
    if (inpt.lmb && p.fireCooldown <= 0) {
      p.fireCooldown = FIRE_COOLDOWN;
      const dirx = Math.cos(p.angle), diry = Math.sin(p.angle);
      bullets.push({
        x: p.x + dirx*(PLAYER_RADIUS+8),
        y: p.y + diry*(PLAYER_RADIUS+8),
        vx: dirx*BULLET_SPEED,
        vy: diry*BULLET_SPEED,
        team: p.team,
        life: 1.2,  // seconds
      });
    }

    // Erase (consumes points per tile removed within radius around cursor point)
    if (inpt.rmb && p.erase > 0) {
      const aimX = p.x + Math.cos(p.angle)*140;
      const aimY = p.y + Math.sin(p.angle)*140;
      const budgetTiles = Math.floor(p.erase / ERASE_COST_PER_TILE);
      if (budgetTiles > 0){
        const removed = erasePaintCircle(aimX, aimY, ERASE_RADIUS, budgetTiles);
        p.erase = clamp(p.erase - removed*ERASE_COST_PER_TILE, 0, MAX_ERASE);
      }
    }

    // Death
    if (p.hp <= 0) {
      p.alive = false;
      p.respawnTimer = RESPAWN_TIME;
    }
  }

  // Bullets
  for (let i=bullets.length-1; i>=0; i--){
    const b = bullets[i];
    b.life -= DT;
    if (b.life <= 0){
      placePaintCircle(b.x, b.y, 18, teamId(b.team));
      bullets.splice(i,1);
      continue;
    }
    // advance with small steps for collision
    const steps = 3;
    for (let s=0;s<steps;s++){
      b.x += (b.vx * DT/steps);
      b.y += (b.vy * DT/steps);

      // hit wall?
      if (collidesWithWalls(b.x, b.y, BULLET_RADIUS)){
        placePaintCircle(b.x, b.y, 20, teamId(b.team));
        bullets.splice(i,1);
        break;
      }
      // hit player?
      for (const p of players.values()){
        if (p.role!=="player" || !p.alive || p.team===b.team) continue;
        const d2 = (p.x-b.x)**2 + (p.y-b.y)**2;
        if (d2 <= (PLAYER_RADIUS+BULLET_RADIUS)**2){
          p.hp = clamp(p.hp - HIT_DAMAGE, 0, MAX_HP);
          // leave paint at hit point too (satisfies “paint stays” even on hit)
          placePaintCircle(b.x, b.y, 16, teamId(b.team));
          bullets.splice(i,1);
          s = steps; // exit loops
          break;
        }
      }
    }
  }

  // Broadcast state
  const snapshot = {
    t: Date.now(),
    grid: paint, // NOTE: compact enough for small map; for bigger, send diffs
    players: Array.from(players.values()).map(p=>({
      id: p.id,
      role: p.role,
      team: p.team,
      x: p.x, y: p.y, angle: p.angle,
      hp: p.hp, erase: p.erase,
      alive: p.alive
    })),
    bullets: bullets.map(b=>({ x:b.x,y:b.y }))
  };
  io.emit("state", snapshot);
}

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
