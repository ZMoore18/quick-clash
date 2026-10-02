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
const LASER_MS = 60000;
const CARD_COLORS = ["red","blue","green","yellow"];
const CARD_VALUES = ["1","2","3","4","5","6","7","8","9","skip","reverse","draw2"];

function cleanName(n){ return String(n||"Player").trim().slice(0,18)||"Player"; }
function code(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s="";
  do{s=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join("")}while(rooms.has(s));
  return s;
}
function send(ws,msg){if(ws.readyState===1)ws.send(JSON.stringify(msg));}
function broadcast(room,msg){for(const p of room.players)send(p.ws,msg);}
function baseState(room){
  return {
    type:"state",room:room.id,status:room.status,game:room.game,
    players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,health:p.health,connected:p.ws.readyState===1})),
    target:room.target,timeLeft:room.status==="playing"?Math.max(0,room.endsAt-Date.now()):null,
    winner:room.winner||null,turn:room.turn||null,topCard:room.topCard||null,
    hand:room.players.find(p=>p===room.lastPlayer)?.hand||null,deckCount:room.deck?.length||0,
    message:room.message||""
  };
}
function push(room){
  for(const p of room.players){
    const st=baseState(room);
    st.hand=room.game==="cards" ? p.hand : null;
    send(p.ws,st);
  }
}
function clearRoomTimers(room){clearTimeout(room.roundTimer);clearTimeout(room.targetTimer);clearTimeout(room.laserTimer);}
function newTarget(room){
  room.target={id:Math.random().toString(36).slice(2),x:8+Math.random()*84,y:12+Math.random()*72};
  room.targetExpires=Date.now()+TARGET_MS;
}
function finish(room){
  if(room.status!=="playing")return;
  room.status="finished"; clearRoomTimers(room);
  const sorted=[...room.players].sort((a,b)=>b.score-a.score);
  room.winner=sorted[0]?{name:sorted[0].name,score:sorted[0].score}:null; push(room);
}
function startQuick(room){
  if(room.players.length<2)return;
  room.game="quick";room.status="playing";room.winner=null;room.message="";
  room.players.forEach(p=>p.score=0);room.endsAt=Date.now()+ROUND_MS;newTarget(room);
  clearRoomTimers(room);room.roundTimer=setTimeout(()=>finish(room),ROUND_MS);push(room);scheduleTarget(room);
}
function scheduleTarget(room){
  clearTimeout(room.targetTimer);room.targetTimer=setTimeout(()=>{
    if(room.status!=="playing")return;
    if(Date.now()>=room.endsAt){finish(room);return}
    newTarget(room);push(room);scheduleTarget(room);
  },TARGET_MS);
}
function startLaser(room){
  if(room.players.length<2)return;
  room.game="laser";room.status="playing";room.winner=null;room.message="Tag an opponent before they tag you!";
  room.players.forEach(p=>{p.score=0;p.health=3});
  room.endsAt=Date.now()+LASER_MS;clearRoomTimers(room);
  room.roundTimer=setTimeout(()=>finish(room),LASER_MS);push(room);
}
function makeDeck(){
  const d=[]; for(const c of CARD_COLORS)for(const v of CARD_VALUES)d.push({color:c,value:v});
  for(let i=0;i<8;i++)d.push({color:"wild",value:i%2?"wild":"draw4"}); return d.sort(()=>Math.random()-.5);
}
function startCards(room){
  if(room.players.length<2)return;
  room.game="cards";room.status="playing";room.winner=null;room.message="";
  room.deck=makeDeck();room.discard=[];room.players.forEach(p=>{p.score=0;p.hand=[]});
  for(let i=0;i<7;i++)for(const p of room.players)p.hand.push(room.deck.pop());
  room.topCard=room.deck.pop();room.turn=room.players[0].id;room.lastPlayer=room.players[0];
  room.endsAt=Date.now()+300000;clearRoomTimers(room);push(room);
}
function cardPlayable(card,top){return card.color==="wild"||card.color===top.color||card.value===top.value;}
function nextPlayer(room){
  const idx=room.players.findIndex(p=>p.id===room.turn);
  room.turn=room.players[(idx+1)%room.players.length]?.id||null;
}
function cardWinner(room,p){room.status="finished";room.winner={name:p.name,score:7-p.hand.length};room.message=p.name+" played their last card!";push(room);}
function playCard(room,p,index){
  if(room.game!=="cards"||room.status!=="playing"||room.turn!==p.id)return;
  const card=p.hand[index];if(!card||!cardPlayable(card,room.topCard))return;
  p.hand.splice(index,1);room.topCard=card;room.lastPlayer=p;room.message=p.name+" played "+card.color+" "+card.value+".";
  if(p.hand.length===0){cardWinner(room,p);return;}
  if(card.value==="draw2"){
    const n=room.players[(room.players.findIndex(x=>x.id===p.id)+1)%room.players.length];
    for(let i=0;i<2&&room.deck.length;i++)n.hand.push(room.deck.pop());room.turn=n.id;
  }else if(card.value==="draw4"){
    const n=room.players[(room.players.findIndex(x=>x.id===p.id)+1)%room.players.length];
    for(let i=0;i<4&&room.deck.length;i++)n.hand.push(room.deck.pop());room.turn=n.id;
  }else if(card.value==="skip"){nextPlayer(room);nextPlayer(room);}
  else if(card.value==="reverse"){room.players.reverse();nextPlayer(room);}
  else nextPlayer(room);
  push(room);
}
function drawCard(room,p){
  if(room.game!=="cards"||room.status!=="playing"||room.turn!==p.id)return;
  if(!room.deck.length){room.deck=room.discard.splice(0,Math.max(0,room.discard.length-1)).sort(()=>Math.random()-.5)}
  if(room.deck.length)p.hand.push(room.deck.pop()); room.message=p.name+" drew a card."; nextPlayer(room);push(room);
}
wss.on("connection",ws=>{
  ws.on("message",raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return}
    if(m.type==="create"){
      const id=code(),p={id:Math.random().toString(36).slice(2),name:cleanName(m.name),score:0,health:3,ws,hand:[]};
      const room={id,players:[p],status:"lobby",game:null,target:null,roundTimer:null,targetTimer:null,laserTimer:null,winner:null,turn:null,topCard:null,deck:null,discard:[],message:""};
      rooms.set(id,room);ws.room=room;ws.player=p;send(ws,{type:"joined",id:p.id});push(room);return;
    }
    if(m.type==="join"){
      const room=rooms.get(String(m.room||"").toUpperCase());
      if(!room||room.status!=="lobby"){send(ws,{type:"error",message:"That room is unavailable."});return}
      if(room.players.length>=MAX_PLAYERS){send(ws,{type:"error",message:"That room is full (6 players maximum)."});return}
      const p={id:Math.random().toString(36).slice(2),name:cleanName(m.name),score:0,health:3,ws,hand:[]};
      room.players.push(p);ws.room=room;ws.player=p;send(ws,{type:"joined",id:p.id});push(room);return;
    }
    const room=ws.room,p=ws.player;if(!room||!p)return;
    if(m.type==="chooseGame"){
      if(room.players[0].id!==p.id)return;
      if(m.game==="quick")startQuick(room);else if(m.game==="laser")startLaser(room);else if(m.game==="cards")startCards(room);
    }
    if(m.type==="hit"&&room.game==="quick"&&room.status==="playing"){
      if(!room.target||m.targetId!==room.target.id||Date.now()>room.targetExpires||Date.now()>=room.endsAt)return;
      p.score++;newTarget(room);broadcast(room,{type:"hit",by:p.name});push(room);scheduleTarget(room);
    }
    if(m.type==="tag"&&room.game==="laser"&&room.status==="playing"){
      const target=room.players.find(x=>x.id===m.targetId);
      if(!target||target.id===p.id||target.health<=0)return;
      target.health--;p.score++;room.message=p.name+" tagged "+target.name+"!";
      if(target.health<=0)room.message=target.name+" is out!";
      const alive=room.players.filter(x=>x.health>0);
      if(alive.length<=1){room.status="finished";room.winner=alive[0]?{name:alive[0].name,score:alive[0].score}:{name:p.name,score:p.score};clearRoomTimers(room)}
      push(room);
    }
    if(m.type==="playCard")playCard(room,p,Number(m.index));
    if(m.type==="drawCard")drawCard(room,p);
    if(m.type==="rematch"&&room.players[0].id===p.id){room.status="lobby";room.game=null;room.winner=null;room.message="";room.players.forEach(x=>{x.score=0;x.health=3;x.hand=[]});push(room)}
  });
  ws.on("close",()=>{
    const room=ws.room,p=ws.player;if(!room||!p)return;
    room.players=room.players.filter(x=>x.id!==p.id);
    if(room.players.length===0){clearRoomTimers(room);rooms.delete(room.id)}
    else{if(room.status==="playing"&&room.players.length<2)finish(room);if(room.turn===p.id)nextPlayer(room);push(room)}
  });
});
server.listen(PORT,()=>console.log("Quick Clash running on "+PORT));