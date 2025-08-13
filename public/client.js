const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });
const hpBar = document.getElementById("hpBar");
const eraseBar = document.getElementById("eraseBar");
const statusEl = document.getElementById("status");

let W = canvas.width = window.innerWidth;
let H = canvas.height = window.innerHeight;
window.addEventListener("resize", ()=>{ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; });

const socket = io();
let youId = null;
let map = null;

const input = {
  up:false,down:false,left:false,right:false, lmb:false, rmb:false, angle:0
};

let world = {
  players: [],
  bullets: [],
  grid: [],
  t: Date.now()
};

const keyMap = {
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};

document.addEventListener("keydown", (e)=>{
  const k = keyMap[e.code];
  if (k) { input[k] = true; e.preventDefault(); sendInput(); }
});
document.addEventListener("keyup", (e)=>{
  const k = keyMap[e.code];
  if (k) { input[k] = false; e.preventDefault(); sendInput(); }
});

canvas.addEventListener("contextmenu", e=> e.preventDefault());
canvas.addEventListener("mousedown", (e)=>{
  if (e.button===0) input.lmb = true;
  if (e.button===2) input.rmb = true;
  sendInput();
});
canvas.addEventListener("mouseup", (e)=>{
  if (e.button===0) input.lmb = false;
  if (e.button===2) input.rmb = false;
  sendInput();
});
canvas.addEventListener("mousemove", (e)=>{
  const me = myPlayer();
  if (!me) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // angle from player screen position to mouse
  const sx = me.x - cam.x + W/2;
  const sy = me.y - cam.y + H/2;
  input.angle = Math.atan2(my - sy, mx - sx);
  sendInputThrottled();
});

function sendInput(){ socket.emit("input", input); }
let inputTimer = null;
function sendInputThrottled(){
  if (inputTimer) return;
  inputTimer = setTimeout(()=>{ inputTimer=null; sendInput(); }, 33);
}

socket.on("init", (data)=>{
  youId = socket.id;
  map = data.map;
});
socket.on("lobby", (list)=>{
  const me = list.find(p=>p.id===youId);
  if (!me) return;
  const role = me.role;
  let label = `You are ${role}`;
  if (role==="player") label += ` - Team ${me.team.toUpperCase()}`;
  statusEl.innerHTML = label +
    (role==="player" ? `<span class="badge ${me.team}">${me.team}</span>` : `<span class="badge spectator">spectator</span>`);
});
socket.on("state", (snap)=>{
  world = snap;
});

function myPlayer(){
  return world.players.find(p=>p.id===youId);
}

// Camera follows you
const cam = { x:0, y:0 };

function draw(){
  const me = myPlayer();
  if (me) { cam.x = me.x; cam.y = me.y; }
  // Clamp camera to map
  cam.x = Math.max(W/2, Math.min(map?.w - W/2, cam.x || 0));
  cam.y = Math.max(H/2, Math.min(map?.h - H/2, cam.y || 0));

  // clear
  ctx.fillStyle = "#0f1220";
  ctx.fillRect(0,0,W,H);

  if (!map) { requestAnimationFrame(draw); return; }

  // grid background
  ctx.save();
  ctx.translate(W/2 - cam.x, H/2 - cam.y);

  // paint tiles
  if (world.grid.length){
    for (let yy=0; yy<world.grid.length; yy++){
      const row = world.grid[yy];
      for (let xx=0; xx<row.length; xx++){
        const v = row[xx];
        if (!v) continue;
        const x = xx*map.tile;
        const y = yy*map.tile;
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = (v===1) ? "#ef4444" : "#3b82f6";
        ctx.fillRect(x, y, map.tile, map.tile);
        ctx.globalAlpha = 1;
      }
    }
  }

  // walls
  ctx.fillStyle = "#1f2433";
  for (const [x,y,w,h] of map.walls){
    ctx.fillRect(x,y,w,h);
  }

  // bullets
  ctx.fillStyle = "#e5e7eb";
  for (const b of world.bullets){
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI*2);
    ctx.fill();
  }

  // players
  for (const p of world.players){
    if (!p.alive) continue;
    const color = p.team==="red" ? "#ef4444" : "#3b82f6";
    // body
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(p.x, p.y, 16, 0, Math.PI*2);
    ctx.fill();

    // direction line
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(p.angle)*28, p.y + Math.sin(p.angle)*28);
    ctx.stroke();

    // nameplate (last 4 chars of id)
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`${p.team||'spec'}-${String(p.id).slice(-4)}`, p.x, p.y - 24);
  }

  ctx.restore();

  // UI
  if (me) {
    hpBar.style.width = `${(me.hp/100)*100}%`;
    eraseBar.style.width = `${(me.erase/100)*100}%`;
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
