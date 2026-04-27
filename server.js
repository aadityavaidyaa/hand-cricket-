#!/usr/bin/env node
/**
 * HAND CRICKET v3
 * Normal / Super Over / Draft / Tournament / IPL
 * Ball timer, Play-Again, DLS rain, SSE real-time
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = process.env.PORT || 3000;
const rooms = {};
const sseClients = {};

setInterval(() => {
  const ttl = 3 * 60 * 60 * 1000;
  for (const id in rooms) if (Date.now() - rooms[id].created > ttl) { closeRoom(id); delete rooms[id]; }
}, 10 * 60 * 1000);

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
function genId(n=5) {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s='';
  for(let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)]; return s;
}
function json(res,d,st=200) {
  res.writeHead(st,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(d));
}
function readBody(req,cb) {
  let b=''; req.on('data',c=>b+=c);
  req.on('end',()=>{try{cb(JSON.parse(b||'{}'));}catch{cb({});}});
}
function broadcast(roomId,ev,d) {
  const msg=`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
  for(const c of (sseClients[roomId]||[])) try{c.res.write(msg);}catch(_){}
}
function sendTo(roomId,role,ev,d) {
  const msg=`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
  for(const c of (sseClients[roomId]||[]).filter(c=>c.role===role)) try{c.res.write(msg);}catch(_){}
}
function closeRoom(id) {
  for(const c of (sseClients[id]||[])) try{c.res.end();}catch(_){}
  delete sseClients[id];
}
function pick(arr){return arr[Math.floor(Math.random()*arr.length)];}

const server = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const p=u.pathname;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(p.startsWith('/api/')){apiRouter(p,u,req,res);return;}
  serveFile(p,res);
});

function apiRouter(p,u,req,res){
  if(p==='/api/info'){json(res,{ip:getLocalIP(),port:PORT});return;}

  if(p==='/api/room/create'&&req.method==='POST'){
    readBody(req,body=>{
      const id=genId();
      rooms[id]={id,created:Date.now(),guestJoined:false,_ballTimer:null,
        state:{phase:'lobby',setup:body.setup,toss:{},game:null,tournament:null,hostReady:false,guestReady:false}};
      sseClients[id]=[];
      json(res,{roomId:id,role:'host',ip:getLocalIP(),port:PORT});
    });return;
  }

  if(p==='/api/room/join'&&req.method==='POST'){
    readBody(req,body=>{
      const room=rooms[body.roomId];
      if(!room){json(res,{error:'Room not found'},404);return;}
      if(room.guestJoined){json(res,{error:'Room is full'},400);return;}
      room.guestJoined=true;
      broadcast(body.roomId,'guest_joined',{});
      json(res,{roomId:body.roomId,role:'guest',state:room.state});
    });return;
  }

  if(p.match(/^\/api\/room\/[^/]+\/events$/)&&req.method==='GET'){
    const roomId=p.split('/')[3],role=u.searchParams.get('role')||'host';
    const room=rooms[roomId];
    if(!room){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write(': connected\n\n');
    res.write(`event: sync\ndata: ${JSON.stringify(room.state)}\n\n`);
    const client={role,res};
    (sseClients[roomId]=sseClients[roomId]||[]).push(client);
    const hb=setInterval(()=>{try{res.write(': ping\n\n');}catch{clearInterval(hb);}},20000);
    req.on('close',()=>{clearInterval(hb);sseClients[roomId]=(sseClients[roomId]||[]).filter(c=>c!==client);});
    return;
  }

  if(p.match(/^\/api\/room\/[^/]+\/action$/)&&req.method==='POST'){
    const roomId=p.split('/')[3],room=rooms[roomId];
    if(!room){json(res,{error:'Not found'},404);return;}
    readBody(req,body=>{handleAction(roomId,room,body);json(res,{ok:true});});
    return;
  }

  json(res,{error:'Not found'},404);
}

function handleAction(roomId,room,action){
  const st=room.state;
  switch(action.type){

    case 'update_setup':{
      st.setup=action.setup; st.phase='setup_preview';
      st.hostReady=false; st.guestReady=false;
      broadcast(roomId,'setup_updated',{setup:action.setup});
      break;
    }
    case 'guest_ready':{
      st.guestReady=true; broadcast(roomId,'ready_status',{hostReady:st.hostReady,guestReady:true});
      if(st.hostReady) startMatchFlow(roomId,room);
      break;
    }
    case 'host_ready':{
      st.hostReady=true; broadcast(roomId,'ready_status',{hostReady:true,guestReady:st.guestReady});
      if(st.guestReady) startMatchFlow(roomId,room);
      break;
    }

    case 'toss_call':{
      st.toss={call:action.call}; st.phase='toss';
      broadcast(roomId,'toss_called',{call:action.call});
      break;
    }
    case 'toss_flip':{
      const result=Math.random()<0.5?'heads':'tails';
      st.toss.result=result; st.toss.winner=st.toss.call===result?'host':'guest';
      st.phase='toss_choice';
      broadcast(roomId,'toss_result',{result,winner:st.toss.winner});
      break;
    }
    case 'toss_choice':{
      const winner=st.toss.winner,other=winner==='host'?'guest':'host';
      const batter=action.choice==='bat'?winner:other;
      const bowler=action.choice==='bat'?other:winner;
      if(st.setup&&st.setup.mode==='draft'){
        st.phase='draft'; st.draft={hostBans:null,guestBans:null,batter,bowler};
        broadcast(roomId,'draft_start',{batter,bowler});
      } else {
        st.game=initGame(batter,bowler,st.setup); st.phase='game';
        broadcast(roomId,'game_start',{game:st.game});
        scheduleNextBallTimer(roomId,room);
      }
      break;
    }

    case 'submit_bans':{
      if(!st.draft)break;
      st.draft[action.role+'Bans']=action.bans;
      broadcast(roomId,'bans_submitted',{role:action.role});
      if(st.draft.hostBans&&st.draft.guestBans){
        const reveal={hostBans:st.draft.hostBans,guestBans:st.draft.guestBans};
        broadcast(roomId,'draft_reveal',reveal);
        const setup={...st.setup,draftBans:reveal};
        st.game=initGame(st.draft.batter,st.draft.bowler,setup);
        st.phase='game';
        setTimeout(()=>{ broadcast(roomId,'game_start',{game:st.game}); scheduleNextBallTimer(roomId,room); },3000);
      }
      break;
    }

    case 'start_innings2':{
      if(!st.game||st.game.status!=='innings_break')break;
      st.game.status='playing'; st.phase='game';
      broadcast(roomId,'innings2_start',{game:st.game});
      scheduleNextBallTimer(roomId,room);
      break;
    }

    case 'move':{
      if(!st.game)break;
      const g=st.game;
      if(g.moves[action.role]!==null)break;
      // Enforce draft bans
      if(st.setup&&st.setup.draftBans){
        const isBatHost=g.battingPlayer==='host';
        const bans=action.role==='bat'
          ?(isBatHost?st.setup.draftBans.hostBans:st.setup.draftBans.guestBans)
          :(!isBatHost?st.setup.draftBans.hostBans:st.setup.draftBans.guestBans);
        if(bans&&bans.includes(action.num))break;
      }
      g.moves[action.role]={num:action.num,power:action.power||null};
      const other=action.role==='bat'?g.bowlingPlayer:g.battingPlayer;
      sendTo(roomId,other,'opponent_locked',{});
      if(g.moves.bat!==null&&g.moves.bowl!==null){
        if(room._ballTimer){clearTimeout(room._ballTimer);room._ballTimer=null;}
        resolveBall(roomId,room);
      }
      break;
    }

    case 'auto_move':{
      if(!st.game)break;
      const g=st.game;
      if(g.moves.bat===null)  g.moves.bat ={num:Math.ceil(Math.random()*6),power:null,auto:true};
      if(g.moves.bowl===null) g.moves.bowl={num:Math.ceil(Math.random()*6),power:null,auto:true};
      resolveBall(roomId,room);
      break;
    }

    case 'start_tournament':{
      st.tournament=initTournament(action.config); st.phase='tournament';
      broadcast(roomId,'tournament_ready',{tournament:st.tournament});
      break;
    }
    case 'tourn_next':{
      if(!st.tournament)break;
      const t=st.tournament;
      t.hostReady=false;t.guestReady=false;
      // Get current fixture info
      let fix=t.phase==='group'?t.fixtures[t.currentFixture]:t.knockoutFixtures[t.knockoutIdx];
      broadcast(roomId,'tourn_show_ready',{fixture:fix,hostReady:false,guestReady:false});
      break;
    }
    case 'player_ready':{
      if(!st.tournament)break;
      const t=st.tournament;
      if(action.player==='host')t.hostReady=true; else t.guestReady=true;
      let fix=t.phase==='group'?t.fixtures[t.currentFixture]:t.knockoutFixtures[t.knockoutIdx];
      broadcast(roomId,'ready_status',{hostReady:t.hostReady,guestReady:t.guestReady,fixture:fix});
      if(t.hostReady&&t.guestReady){ t.hostReady=false; t.guestReady=false; startTournamentMatch(roomId,room); }
      break;
    }
    case 'advance_tournament':{
      if(!st.tournament)break;
      advanceTournament(roomId,room,action.result);
      break;
    }
  }
  room.state=st;
}

function startMatchFlow(roomId,room){
  const st=room.state;
  st.hostReady=false; st.guestReady=false;
  st.toss={}; st.game=null; st.phase='toss';
  broadcast(roomId,'match_start',{setup:st.setup});
}

// ── Tournament ────────────────────────────────────────────────────────────
function initTournament(config){
  const {teams,overs,maxWickets,matchesPerTeam}=config;
  const mpt=matchesPerTeam||1;
  // Build fixtures: each team plays exactly mpt matches against different opponents
  // Simple approach: generate all pairs, shuffle, then pick until each team has mpt matches
  const fixtures=[];
  const played=Object.fromEntries(teams.map(t=>[t.id,0]));
  const allPairs=[];
  for(let i=0;i<teams.length;i++)
    for(let j=i+1;j<teams.length;j++)
      allPairs.push([teams[i],teams[j]]);
  // Shuffle pairs for variety
  for(let i=allPairs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[allPairs[i],allPairs[j]]=[allPairs[j],allPairs[i]];}
  // Keep adding pairs while each team hasn't hit mpt matches
  // Allow multiple passes to fill up to mpt matches per team
  let pass=0;
  while(pass<mpt){
    const passedPairs=[...allPairs];
    const usedThisPass=new Set();
    for(const [a,b] of passedPairs){
      if(played[a.id]<mpt&&played[b.id]<mpt&&!usedThisPass.has(a.id)&&!usedThisPass.has(b.id)){
        fixtures.push({id:fixtures.length,home:a,away:b,result:null});
        played[a.id]++;played[b.id]++;
        usedThisPass.add(a.id);usedThisPass.add(b.id);
      }
    }
    pass++;
  }
  return {
    phase:'group',teams,overs,maxWickets,matchesPerTeam:mpt,
    fixtures,currentFixture:0,
    points:Object.fromEntries(teams.map(t=>[t.id,{id:t.id,name:t.name,flag:t.flag,p:0,w:0,l:0,tie:0,nrr:0,pts:0,rf:0,bf:0,ra:0,ba:0}])),
    knockoutFixtures:[],knockoutIdx:0,
    hostReady:false,guestReady:false,champion:null,
  };
}
function startTournamentMatch(roomId,room){
  const st=room.state,t=st.tournament;
  let fix=t.phase==='group'?t.fixtures[t.currentFixture]:t.knockoutFixtures[t.knockoutIdx];
  if(!fix||fix.pending)return;
  const setup={
    team1:fix.home,team2:fix.away,
    players1:fix.home.players||Array(10).fill('').map((_,i)=>fix.home.name+' '+(i+1)),
    players2:fix.away.players||Array(10).fill('').map((_,i)=>fix.away.name+' '+(i+1)),
    overs:t.overs,maxWickets:t.maxWickets,mode:'normal',tournamentMatch:true,ballTimer:st.setup?.ballTimer||0,
  };
  st.setup=setup; st.toss={}; st.game=null; st.phase='toss';
  broadcast(roomId,'match_start',{setup});
}
function advanceTournament(roomId,room,result){
  const t=room.state.tournament; if(!t)return;
  if(t.phase==='group'){
    const fix=t.fixtures[t.currentFixture]; fix.result=result;
    updatePoints(t,fix,result); t.currentFixture++;
    if(t.currentFixture>=t.fixtures.length) buildKnockout(t);
  } else {
    const fix=t.knockoutFixtures[t.knockoutIdx]; fix.result=result;
    // Patch final teams if this was a semi
    const nextFix=t.knockoutFixtures[t.knockoutIdx+1];
    if(nextFix&&nextFix.pending&&result.winnerId){
      const winTeam=result.winnerId===fix.home.id?fix.home:fix.away;
      if(!nextFix.home){nextFix.home=winTeam;} else {nextFix.away=winTeam; nextFix.pending=false;}
    }
    t.knockoutIdx++;
    if(t.knockoutIdx>=t.knockoutFixtures.length){
      t.phase='done'; t.champion=result.winnerId?t.teams.find(x=>x.id===result.winnerId)||null:null;
    }
  }
  broadcast(roomId,'tournament_state',{tournament:t});
}
function updatePoints(t,fix,result){
  const h=t.points[fix.home.id],a=t.points[fix.away.id]; if(!h||!a)return;
  h.p++;a.p++;
  h.rf+=result.homeRuns||0; h.bf+=result.homeBalls||1;
  h.ra+=result.awayRuns||0; h.ba+=result.awayBalls||1;
  a.rf+=result.awayRuns||0; a.bf+=result.awayBalls||1;
  a.ra+=result.homeRuns||0; a.ba+=result.homeBalls||1;
  if(result.tie){h.tie++;a.tie++;h.pts++;a.pts++;}
  else if(result.winnerId===fix.home.id){h.w++;h.pts+=2;a.l++;}
  else{a.w++;a.pts+=2;h.l++;}
  const nrr=e=>e.bf>0&&e.ba>0?((e.rf/e.bf)-(e.ra/e.ba))*6:0;
  h.nrr=+nrr(h).toFixed(3); a.nrr=+nrr(a).toFixed(3);
}
function buildKnockout(t){
  const sorted=Object.values(t.points).sort((a,b)=>b.pts!==a.pts?b.pts-a.pts:b.nrr-a.nrr);
  const getTeam=entry=>t.teams.find(x=>x.id===entry.id)||t.teams[0];
  t.knockoutFixtures=[];
  if(t.teams.length>=4){
    t.knockoutFixtures=[
      {id:'SF1',home:getTeam(sorted[0]),away:getTeam(sorted[3]),result:null,label:'Semi Final 1'},
      {id:'SF2',home:getTeam(sorted[1]),away:getTeam(sorted[2]),result:null,label:'Semi Final 2'},
      {id:'FIN',home:null,away:null,result:null,label:'Final',pending:true},
    ];
  } else {
    t.knockoutFixtures=[{id:'FIN',home:getTeam(sorted[0]),away:getTeam(sorted[1]),result:null,label:'Final'}];
  }
  t.phase='knockout'; t.knockoutIdx=0;
}

// ── Game init ─────────────────────────────────────────────────────────────
function initGame(battingPlayer,bowlingPlayer,setup){
  return {
    innings:1,battingPlayer,bowlingPlayer,
    scores:{
      1:emptyInnings(battingPlayer,bowlingPlayer,setup),
      2:{runs:0,wickets:0,balls:0,overs:0,fallOfWickets:[],overHistory:[],batsmen:null,bowlers:null},
    },
    target:null,currentOver:[],
    moves:{bat:null,bowl:null},
    lastBallResult:null,setup,status:'playing',
    powers:{
      host: {shield:true,doubler:true,wildcard:true,freeze:true,blitz:true,predict:true,swap:true,surge:true,wall:true},
      guest:{shield:true,doubler:true,wildcard:true,freeze:true,blitz:true,predict:true,swap:true,surge:true,wall:true},
    },
    shieldQueued:false,doublerQueued:false,freezeActive:false,frozenNum:null,
    blitzQueued:false,predictQueued:false,swapQueued:false,surgeActive:0,wallQueued:false,
    currentBatterIdx:0,currentBowlerIdx:0,currentBowlerBalls:0,
    commentary:[],milestones:[],dlsApplied:false,
  };
}
function emptyInnings(bp,bwp,setup){
  const bPlayers=bp==='host'?setup.players1:setup.players2;
  const wPlayers=bwp==='host'?setup.players1:setup.players2;
  return {
    runs:0,wickets:0,balls:0,overs:0,fallOfWickets:[],overHistory:[],
    batsmen:bPlayers.map((name,i)=>({name,runs:0,balls:0,fours:0,sixes:0,out:false,active:i<2,dismissed:'',bowledBy:''})),
    bowlers:wPlayers.map(name=>({name,overs:0,balls:0,runs:0,wickets:0,maidens:0})),
  };
}

function scheduleNextBallTimer(roomId,room){
  const setup=room.state?.setup;
  if(!setup||!(setup.ballTimer>0))return;
  if(room._ballTimer){clearTimeout(room._ballTimer);room._ballTimer=null;}
  room._ballTimer=setTimeout(()=>{
    handleAction(roomId,room,{type:'auto_move'});
  },setup.ballTimer*1000);
}

// ── Ball resolution ───────────────────────────────────────────────────────
const CMT={
  six:   ['MAXIMUM! 🚀 Into the stands!','SIXXX!','GONE! Six all the way!','SIX — bat meets ball!'],
  four:  ['FOUR! Races to the boundary!','Cracked through covers — FOUR!','Beautiful timing — four!','BOUNDARY!'],
  two:   ['Good running! Two runs.','They turn for two!','Pushed into the gap, two.'],
  three: ['Excellent running — THREE!','Misfield allows three!'],
  one:   ['Worked away for a single.','Nudged off the pads, one.','Pushed to mid-on, one.'],
  dot:   ['Dot ball. Nothing doing.','Beaten! Dot.','Good length — no run.','Tight line — dot.'],
  wicket:['CAUGHT! Same number — OUT! 😱','WICKET! Stumps flying!','DISMISSED! 🚶','OUT! Middle stump cartwheels!','GONE! 🎯'],
  shield:['🛡 SHIELD — wicket nullified!'],
  doubler:['✖2 DOUBLER — {d} runs!'],
  blitz: ['💣 BLITZ! +3 bonus runs!'],
  predict:['🔮 PREDICT! DOUBLE WICKET!'],
  wall:  ['🧱 WALL — capped at 3!'],
  auto:  ['⏱ TIME UP — random number played!'],
};
function pick(arr){return arr[Math.floor(Math.random()*arr.length)];}

function resolveBall(roomId,room){
  const g=room.state.game,sc=g.scores[g.innings];
  const batM=g.moves.bat,bowlM=g.moves.bowl,setup=g.setup;
  const batPlayer=g.battingPlayer,bowlPlayer=g.bowlingPlayer;

  // Power activation
  if(batM.power==='shield'  &&g.powers[batPlayer].shield)  {g.shieldQueued=true; g.powers[batPlayer].shield=false;}
  if(batM.power==='doubler' &&g.powers[batPlayer].doubler) {g.doublerQueued=true;g.powers[batPlayer].doubler=false;}
  if(batM.power==='wildcard'&&g.powers[batPlayer].wildcard){g.powers[batPlayer].wildcard=false;}
  if(batM.power==='blitz'   &&g.powers[batPlayer].blitz)   {g.blitzQueued=true;  g.powers[batPlayer].blitz=false;}
  if(batM.power==='surge'   &&g.powers[batPlayer].surge)   {g.surgeActive=3;     g.powers[batPlayer].surge=false;}
  if(batM.power==='swap'    &&g.powers[batPlayer].swap)    {g.swapQueued=true;   g.powers[batPlayer].swap=false;}
  if(bowlM.power==='freeze' &&g.powers[bowlPlayer].freeze) {g.freezeActive=true; g.frozenNum=batM.num;g.powers[bowlPlayer].freeze=false;}
  if(bowlM.power==='predict'&&g.powers[bowlPlayer].predict){g.predictQueued=true;g.powers[bowlPlayer].predict=false;}
  if(bowlM.power==='wall'   &&g.powers[bowlPlayer].wall)   {g.wallQueued=true;   g.powers[bowlPlayer].wall=false;}
  if(bowlM.power==='swap'   &&g.powers[bowlPlayer].swap)   {g.swapQueued=true;   g.powers[bowlPlayer].swap=false;}
  g.freezeActive=false; // clear for this ball (was set last ball)

  const rawBat=batM.num,rawBowl=bowlM.num;
  const effBat=g.swapQueued?rawBowl:rawBat;
  const effBowl=g.swapQueued?rawBat:rawBowl;
  if(g.swapQueued)g.swapQueued=false;
  const finalBat=g.wallQueued?Math.min(effBat,3):effBat;
  const wallApplied=g.wallQueued&&effBat>3;
  if(g.wallQueued)g.wallQueued=false;

  const isWicket=finalBat===effBowl;
  let runs=0,commentary='',shieldSaved=false;
  let doublerApplied=false,blitzApplied=false,predictDouble=false,surgeApplied=false;
  const autoPlayed=!!(batM.auto||bowlM.auto);
  const bowlerObj=sc.bowlers?.[g.currentBowlerIdx%(sc.bowlers?.length||1)];
  const batterObj=sc.batsmen?.[g.currentBatterIdx];
  const prevRuns=batterObj?batterObj.runs:0;

  if(isWicket){
    if(g.shieldQueued){
      g.shieldQueued=false;shieldSaved=true;if(g.blitzQueued)g.blitzQueued=false;
      commentary=pick(CMT.shield);
    } else {
      sc.wickets++;
      sc.fallOfWickets.push({runs:sc.runs,wickets:sc.wickets,ball:sc.balls+1,batter:batterObj?.name||'?'});
      if(batterObj){batterObj.out=true;batterObj.active=false;batterObj.balls++;batterObj.dismissed='c&b';batterObj.bowledBy=bowlerObj?.name||'';}
      g.currentBatterIdx++;
      if(sc.batsmen&&g.currentBatterIdx+1<sc.batsmen.length)sc.batsmen[g.currentBatterIdx+1].active=true;
      if(bowlerObj)bowlerObj.wickets++;
      if(g.predictQueued){
        g.predictQueued=false;predictDouble=true;
        if(sc.wickets<setup.maxWickets){
          const nxt=sc.batsmen?.[g.currentBatterIdx];
          sc.wickets++;
          sc.fallOfWickets.push({runs:sc.runs,wickets:sc.wickets,ball:sc.balls+1,batter:nxt?.name||'?'});
          if(nxt){nxt.out=true;nxt.active=false;nxt.dismissed='predict';nxt.bowledBy=bowlerObj?.name||'';}
          g.currentBatterIdx++;
          if(sc.batsmen&&g.currentBatterIdx+1<sc.batsmen.length)sc.batsmen[g.currentBatterIdx+1].active=true;
          if(bowlerObj)bowlerObj.wickets++;
        }
        commentary=pick(CMT.predict);
      } else {g.predictQueued=false;commentary=pick(CMT.wicket);}
      g.frozenNum=null;if(g.blitzQueued)g.blitzQueued=false;
    }
  } else {
    g.predictQueued=false;runs=finalBat;
    if(g.surgeActive>0){if(runs===6){runs=12;surgeApplied=true;}g.surgeActive--;}
    if(g.doublerQueued){runs*=2;doublerApplied=true;g.doublerQueued=false;commentary=pick(CMT.doubler).replace('{d}',runs);}
    if(g.blitzQueued){runs+=3;blitzApplied=true;g.blitzQueued=false;if(!commentary)commentary=pick(CMT.blitz);}
    if(!commentary){
      commentary=autoPlayed?pick(CMT.auto):
        runs>=12?pick(CMT.six)+' ⚡ SURGE!':runs===6?pick(CMT.six):
        wallApplied?pick(CMT.wall):runs===4?pick(CMT.four):runs===3?pick(CMT.three):
        runs===2?pick(CMT.two):runs===1?pick(CMT.one):pick(CMT.dot);
    }
    if(batterObj){batterObj.runs+=runs;batterObj.balls++;if(runs>=4&&runs<6)batterObj.fours++;if(runs>=6)batterObj.sixes++;}
    if(bowlerObj)bowlerObj.runs+=runs;
    sc.runs+=runs;g.frozenNum=finalBat;
    // Milestones
    if(batterObj){
      if(prevRuns<50&&batterObj.runs>=50)g.milestones.push({type:50,name:batterObj.name});
      if(prevRuns<100&&batterObj.runs>=100)g.milestones.push({type:100,name:batterObj.name});
    }
  }

  sc.balls++;if(bowlerObj)bowlerObj.balls++;
  const overDone=sc.balls>0&&sc.balls%6===0;
  if(overDone){
    sc.overs++;
    if(bowlerObj){
      bowlerObj.overs=Math.floor(bowlerObj.balls/6);
      const oruns=g.currentOver.reduce((a,b)=>a+(b.isWicket?0:b.runs),0);
      if(oruns===0&&!g.currentOver.some(b=>b.isWicket))bowlerObj.maidens++;
    }
    sc.overHistory.push([...g.currentOver,{overNum:sc.overs}]);
    g.currentOver=[];g.currentBowlerIdx++;g.currentBowlerBalls=0;
  } else g.currentBowlerBalls++;

  const ball={bat:rawBat,bowl:rawBowl,runs,isWicket:isWicket&&!shieldSaved,shieldSaved,doublerApplied,blitzApplied,predictDouble,surgeApplied,wallApplied,autoPlayed,commentary};
  g.currentOver.push(ball);
  g.commentary.unshift(`${sc.overs}.${(sc.balls%6)||6}: ${commentary}`);
  if(g.commentary.length>8)g.commentary.pop();
  g.lastBallResult=ball;g.moves={bat:null,bowl:null};

  const effOvers=g._inn2Overs||setup.overs;
  const totalBalls=effOvers*6;
  const allOut=sc.wickets>=setup.maxWickets;
  const oversUp=sc.balls>=totalBalls;
  const chased=g.innings===2&&sc.runs>=g.target;

  if(chased||allOut||oversUp){
    if(g.innings===1){
      g.target=sc.runs+1;
      const ob=g.battingPlayer,ow=g.bowlingPlayer;
      g.battingPlayer=ow;g.bowlingPlayer=ob;g.innings=2;
      g.currentBatterIdx=0;g.currentBowlerIdx=0;g.currentBowlerBalls=0;
      g.currentOver=[];g.moves={bat:null,bowl:null};
      g.shieldQueued=false;g.doublerQueued=false;g.freezeActive=false;g.frozenNum=null;
      g.blitzQueued=false;g.predictQueued=false;g.swapQueued=false;g.surgeActive=0;g.wallQueued=false;
      g.powers={host:{shield:true,doubler:true,wildcard:true,freeze:true,blitz:true,predict:true,swap:true,surge:true,wall:true},
                guest:{shield:true,doubler:true,wildcard:true,freeze:true,blitz:true,predict:true,swap:true,surge:true,wall:true}};
      g.scores[2]=emptyInnings(g.battingPlayer,g.bowlingPlayer,setup);
      g.status='innings_break'; room.state.phase='game';
      // DLS rain scheduling for innings 2
      if(setup.overs>=10&&Math.random()<0.30){
        const rainOver=2+Math.floor(Math.random()*(setup.overs-4));
        g._rainScheduledOver=rainOver;
      }
      broadcast(roomId,'ball_result',{result:ball,game:g});
      setTimeout(()=>{
        const r=rooms[roomId];if(!r?.state?.game)return;
        const gg=r.state.game;if(gg.status!=='innings_break')return;
        gg.status='playing';r.state.phase='game';
        broadcast(roomId,'innings2_start',{game:gg});
        scheduleNextBallTimer(roomId,r);
      },15000);
      return;
    } else {
      g.status='result';room.state.phase='result';
      const s1=g.scores[1],s2=g.scores[2];
      const tn=p=>p==='host'?setup.team1.name:setup.team2.name;
      if(chased){const w=setup.maxWickets-s2.wickets;g.resultText=`${tn(g.battingPlayer)} won by ${w} wicket${w!==1?'s':''}`;}
      else if(s1.runs>s2.runs){const d=s1.runs-s2.runs;g.resultText=`${tn(g.bowlingPlayer)} won by ${d} run${d!==1?'s':''}`;}
      else g.resultText='Match tied!';
      if(setup.tournamentMatch){
        const wId=chased?(g.battingPlayer==='host'?setup.team1.id:setup.team2.id):
                  s1.runs>s2.runs?(g.bowlingPlayer==='host'?setup.team1.id:setup.team2.id):null;
        g.tournamentResult={winnerId:wId,homeRuns:s1.runs,homeBalls:s1.balls,awayRuns:s2.runs,awayBalls:s2.balls,tie:s1.runs===s2.runs};
        setTimeout(()=>{const r=rooms[roomId];if(r)advanceTournament(roomId,r,g.tournamentResult);},2000);
      }
    }
  } else {
    g.status='playing';
    // Check DLS rain
    if(g.innings===2&&g._rainScheduledOver!==undefined&&!g.dlsApplied&&sc.overs>=g._rainScheduledOver){
      const reduction=1+Math.floor(Math.random()*3);
      const newOvers=Math.max(sc.overs+1,setup.overs-reduction);
      const newTarget=Math.floor(g.target*newOvers/setup.overs)+1;
      g._rainScheduledOver=undefined;g.dlsApplied=true;
      g.dlsInfo={reduction,newOvers,originalTarget:g.target,newTarget};
      g.target=newTarget;g._inn2Overs=newOvers;
      g.commentary.unshift(`🌧 RAIN! DLS — new target: ${newTarget} in ${newOvers} overs`);
      broadcast(roomId,'rain_event',{dlsInfo:g.dlsInfo,game:g});
    }
  }

  // Schedule next ball timer
  if(g.status==='playing')scheduleNextBallTimer(roomId,room);

  room.state.game=g;
  broadcast(roomId,'ball_result',{result:ball,game:g});
}

function serveFile(urlPath,res){
  const safe=urlPath==='/'?'/index.html':urlPath;
  const fp=path.join(__dirname,safe);
  if(!fp.startsWith(__dirname)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(err,data)=>{
    if(err){
      fs.readFile(path.join(__dirname,'index.html'),(e2,d2)=>{
        if(e2){res.writeHead(404);res.end('Not found');return;}
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d2);
      });return;
    }
    const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.ico':'image/x-icon','.json':'application/json'};
    res.writeHead(200,{'Content-Type':mime[path.extname(fp)]||'text/plain'});res.end(data);
  });
}

server.listen(PORT,'0.0.0.0',()=>{
  const ip=getLocalIP();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  🏏  HAND CRICKET  v3                ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}         ║`);
  console.log(`║  Network: http://${ip}:${PORT}     ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
server.on('error',err=>{
  if(err.code==='EADDRINUSE')console.error(`\n❌ Port ${PORT} busy.\n`);
  else console.error(err);process.exit(1);
});