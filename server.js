import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const ROUND_MS = 60000;
const TARGET_MS = 2200;

function cleanName(n) {
  return String(n || "Player").trim().slice(0, 18) || "Player";
}
function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  do {
    s = Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join("");
  } while (rooms.has(s));
  return s;
}
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}
function state(room) {
  return {
    type:"state",
    room: room.id,
    status: room.status,
    players: room.players.map(p=>({id:p.id,name:p.name,score:p.score,connected:p.ws.readyState===1})),
    target: room.target,
    timeLeft: room.status==="playing" ? Math.max(0, room.endsAt-Date.now()) : null,
    winner: room.winner || null
  };
}
function pushState(room){ broadcast(room,state(room)); }

function newTarget(room) {
  room.target = {
    id: Math.random().toString(36).slice(2),
    x: 8 + Math.random()*84,
    y: 12 + Math.random()*72
  };
  room.targetExpires = Date.now()+TARGET_MS;
}

function finish(room) {
  if (room.status !== "playing") return;
  room.status="finished";
  clearTimeout(room.roundTimer);
  const sorted=[...room.players].sort((a,b)=>b.score-a.score);
  room.winner = sorted[0] ? {name:sorted[0].name,score:sorted[0].score} : null;
  pushState(room);
}

function start(room) {
  if (room.players.length < 2) return;
  room.status="playing";
  room.winner=null;
  room.players.forEach(p=>p.score=0);
  room.endsAt=Date.now()+ROUND_MS;
  newTarget(room);
  clearTimeout(room.roundTimer);
  room.roundTimer=setTimeout(()=>finish(room), ROUND_MS);
  pushState(room);
  scheduleTarget(room);
}

function scheduleTarget(room) {
  clearTimeout(room.targetTimer);
  room.targetTimer=setTimeout(()=>{
    if(room.status!=="playing") return;
    if(Date.now() >= room.endsAt){ finish(room); return; }
    newTarget(room);
    pushState(room);
    scheduleTarget(room);
  }, TARGET_MS);
}

wss.on("connection",(ws)=>{
  ws.on("message",(raw)=>{
    let m;
    try { m=JSON.parse(raw.toString()); } catch { return; }

    if(m.type==="create"){
      const id=code();
      const player={id:Math.random().toString(36).slice(2),name:cleanName(m.name),score:0,ws};
      const room={id,players:[player],status:"lobby",target:null,roundTimer:null,targetTimer:null,winner:null};
      rooms.set(id,room);
      ws.room=room; ws.player=player;
      send(ws,{type:"joined",id:player.id});
      pushState(room);
      return;
    }

    if(m.type==="join"){
      const room=rooms.get(String(m.room||"").toUpperCase());
      if(!room || room.status!=="lobby"){ send(ws,{type:"error",message:"That room is unavailable. Create a new room or use another code."}); return; }
      if(room.players.length>=MAX_PLAYERS){ send(ws,{type:"error",message:"That room is full (6 players maximum)."}); return; }
      const player={id:Math.random().toString(36).slice(2),name:cleanName(m.name),score:0,ws};
      room.players.push(player); ws.room=room; ws.player=player;
      send(ws,{type:"joined",id:player.id});
      pushState(room);
      return;
    }

    const room=ws.room, player=ws.player;
    if(!room || !player) return;

    if(m.type==="start"){
      if(room.players[0].id!==player.id){ send(ws,{type:"error",message:"Only the room creator can start the match."}); return; }
      if(room.players.length<2){ send(ws,{type:"error",message:"You need at least 2 players to start."}); return; }
      start(room);
    }

    if(m.type==="hit" && room.status==="playing"){
      if(!room.target || m.targetId!==room.target.id) return;
      if(Date.now()>room.targetExpires || Date.now()>=room.endsAt) return;
      player.score += 1;
      newTarget(room);
      broadcast(room,{type:"hit",by:player.name});
      pushState(room);
      scheduleTarget(room);
    }

    if(m.type==="rematch"){
      if(room.players[0].id!==player.id) return;
      start(room);
    }
  });

  ws.on("close",()=>{
    const room=ws.room, player=ws.player;
    if(!room || !player) return;
    room.players=room.players.filter(p=>p.id!==player.id);
    if(room.players.length===0){
      clearTimeout(room.roundTimer); clearTimeout(room.targetTimer); rooms.delete(room.id);
    } else {
      if(room.status==="playing" && room.players.length<2) finish(room);
      pushState(room);
    }
  });
});

server.listen(PORT,()=>console.log(`Quick Clash running on ${PORT}`));