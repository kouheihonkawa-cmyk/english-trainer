// ============================================================
//  英語学習アプリ  メインロジック
// ============================================================

const STORE_KEY = "eng_learn_v1";

// ---- 全カードを1つの配列に統合 ----
const CARDS = [
  ...VOCAB.map(v => ({ ...v, type:"vocab" })),
  ...EXPRESSIONS.map(e => ({ ...e, type:"expr" })),
];
const CARD_BY_ID = Object.fromEntries(CARDS.map(c => [c.id, c]));

// ---- 保存データ ----
let DB = load();

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {
    states:{},                          // id -> SRS状態
    settings:{ newPerDay:12, order:"mix", autoSpeak:true, listenGap:1.4 },
    stats:{ streak:0, lastStudy:null, totalReviews:0 },
    introducedToday:{ date:null, ids:[] },
  };
}
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

function stateOf(id){
  if(!DB.states[id]) DB.states[id] = newCardState(id);
  return DB.states[id];
}
function todayStr(){ return new Date().toISOString().slice(0,10); }

// 今日導入した新規カードの管理
function resetDailyIfNeeded(){
  if(DB.introducedToday.date !== todayStr()){
    DB.introducedToday = { date: todayStr(), ids:[] };
  }
}

// ---- キュー構築 ----
// 期限が来た復習カード + 今日の新規枠
function buildQueue(){
  resetDailyIfNeeded();
  const due = [];
  const seen = new Set();

  // 既に開始済みで期限が来ているもの
  for(const c of CARDS){
    const s = DB.states[c.id];
    if(s && s.state !== "retired" && s.state !== "new" && isDue(s)){
      due.push(c); seen.add(c.id);
    }
  }

  // 新規カード枠 (今日の残り)
  const remainNew = Math.max(0, DB.settings.newPerDay - DB.introducedToday.ids.length);
  const fresh = [];
  const pool = orderedNewPool();
  for(const c of pool){
    if(fresh.length >= remainNew) break;
    const s = DB.states[c.id];
    if(!s || s.state === "new"){ fresh.push(c); seen.add(c.id); }
  }

  // 復習を先、新規を後ろに
  return { due, fresh, total: due.length + fresh.length };
}

function orderedNewPool(){
  const notStarted = CARDS.filter(c => { const s=DB.states[c.id]; return !s || s.state==="new"; });
  const vocab = notStarted.filter(c=>c.type==="vocab");
  const expr  = notStarted.filter(c=>c.type==="expr");
  if(DB.settings.order === "vocab") return [...vocab, ...expr];
  if(DB.settings.order === "expr")  return [...expr, ...vocab];
  return interleave(vocab, expr); // mix = 単語と表現を毎日バランスよく混ぜる
}
// 2つの配列を比率に応じて交互に混ぜる (例: 単語3 : 表現1)
function interleave(a, b){
  const out=[]; let i=0, j=0;
  const ratio = b.length ? Math.max(1, Math.round(a.length/b.length)) : Infinity;
  while(i<a.length || j<b.length){
    for(let k=0;k<ratio && i<a.length;k++) out.push(a[i++]);
    if(j<b.length) out.push(b[j++]);
  }
  return out;
}

// 全体進捗
function progressCounts(){
  let learned=0, learning=0, retired=0;
  for(const c of CARDS){
    const s = DB.states[c.id];
    if(!s || s.state==="new") continue;
    if(s.state==="retired") retired++;
    else if(s.state==="review" && s.interval>=7) learned++;
    else learning++;
  }
  return { learned, learning, retired, total: CARDS.length };
}

// ============================================================
//  音声 (Web Speech API)
// ============================================================
let VOICES = [];
function loadVoices(){ VOICES = speechSynthesis.getVoices(); }
if("speechSynthesis" in window){
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
function pickVoice(lang){
  const v = VOICES.filter(v => v.lang && v.lang.toLowerCase().startsWith(lang));
  // 自然な声を優先
  return v.find(x=>/natural|google|samantha|aria|nanami/i.test(x.name)) || v[0];
}
function speak(text, lang="en", rate=0.95){
  return new Promise(resolve=>{
    if(!("speechSynthesis" in window)){ resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang==="ja"?"ja":"en");
    if(v) u.voice = v;
    u.lang = lang==="ja"?"ja-JP":"en-US";
    u.rate = rate;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}
function stopSpeak(){ if("speechSynthesis" in window) speechSynthesis.cancel(); }
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ============================================================
//  画面制御
// ============================================================
const app = document.getElementById("app");
let VIEW = "home";
let session = null;   // 学習セッション状態

function go(view){
  stopSpeak();
  if(listenTimer){ listenState.playing=false; }
  VIEW = view;
  document.querySelectorAll("nav button").forEach(b=> b.classList.toggle("on", b.dataset.v===view));
  render();
}

function render(){
  if(VIEW==="home") renderHome();
  else if(VIEW==="study") renderStudy();
  else if(VIEW==="listen") renderListen();
  else if(VIEW==="settings") renderSettings();
}

// ---------- ホーム ----------
function renderHome(){
  const q = buildQueue();
  const p = progressCounts();
  const streak = DB.stats.streak || 0;
  app.innerHTML = `
    <div class="stats">
      <div class="stat due"><div class="num">${q.due.length}</div><div class="lbl">復習の期限</div></div>
      <div class="stat new"><div class="num">${q.fresh.length}</div><div class="lbl">今日の新規</div></div>
      <div class="stat"><div class="num">${streak}</div><div class="lbl">連続日数</div></div>
    </div>

    <button class="btn" id="startStudy">${q.total>0 ? `学習を始める (${q.total}枚)` : "今日のノルマ完了 🎉"}</button>
    <div class="row">
      <button class="btn sec small" id="startListen">🎧 聞き流し</button>
      <button class="btn sec small" id="cram">🔁 総復習</button>
    </div>

    <div class="section-title">進捗</div>
    <div class="stats">
      <div class="stat"><div class="num">${p.learned}</div><div class="lbl">定着</div></div>
      <div class="stat"><div class="num">${p.learning}</div><div class="lbl">学習中</div></div>
      <div class="stat"><div class="num">${p.retired}</div><div class="lbl">習得済み</div></div>
    </div>
    <div class="muted center" style="margin-top:14px">全 ${p.total} 枚中 ${p.total-(CARDS.filter(c=>{const s=DB.states[c.id];return !s||s.state==='new'}).length)} 枚に着手</div>
  `;
  document.getElementById("startStudy").onclick = ()=> startSession(q.total>0 ? "normal" : "empty");
  document.getElementById("startListen").onclick = ()=> go("listen");
  document.getElementById("cram").onclick = ()=> startSession("cram");
}

// ============================================================
//  学習セッション (タップ回答)
// ============================================================
function startSession(mode){
  const q = buildQueue();
  let queue;
  if(mode==="cram"){
    // 開始済み全カードをシャッフル
    queue = CARDS.filter(c=>{ const s=DB.states[c.id]; return s && s.state!=="new"; });
    shuffle(queue);
    if(queue.length===0) queue = CARDS.slice(0,20);
  }else{
    queue = [...q.due, ...q.fresh];
  }
  session = { queue, idx:0, total:queue.length, revealed:false, mode, done:0, again:[] };
  go("study");
}

function renderStudy(){
  if(!session){ go("home"); return; }
  // キュー尽きたら completion
  if(session.idx >= session.queue.length){
    // 再出題(忘れた)分を消化
    if(session.again.length){
      session.queue = session.again; session.again=[]; session.idx=0;
    }else{
      renderDone(); return;
    }
  }
  const card = session.queue[session.idx];
  const s = stateOf(card.id);
  const isNew = s.state==="new";
  const pct = Math.round((session.done/Math.max(1,session.total))*100);

  const front = card.type==="vocab"
    ? `<div class="kicker">${isNew?"新しい単語":"単語"}</div>
       <div class="term">${card.term}</div><div class="pos">${card.pos}</div>`
    : `<div class="kicker">${isNew?"新しい表現":"表現"}</div>
       <div class="frame">${card.frame}</div>`;

  let backHtml = "";
  if(session.revealed){
    backHtml = card.type==="vocab"
      ? `<div class="divider"></div>
         <div class="answer">
           <div class="jp">${card.jp}</div>
           <div class="ex"><span class="en">${boldTerm(card.ex, card.term)}</span></div>
           <div class="ex exjp">${card.exJp}</div>
           <button class="speak" id="sp">🔊</button>
         </div>`
      : `<div class="divider"></div>
         <div class="answer">
           <div class="jp">${card.jp}</div>
           ${card.examples.map(e=>`<div class="ex"><span class="en">${e.en}</span><br><span class="exjp">${e.jp}</span></div>`).join("")}
           <div class="note">${card.note}</div>
           <button class="speak" id="sp">🔊</button>
         </div>`;
  }

  app.innerHTML = `
    <div class="study">
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="card">${front}${backHtml}</div>
      ${ session.revealed
        ? `<div class="grades">
             <button class="g0" data-g="0">忘れた<small>やり直し</small></button>
             <button class="g1" data-g="1">あやふや<small>短め</small></button>
             <button class="g2" data-g="2">覚えた<small>OK</small></button>
             <button class="g3" data-g="3">完璧<small>長め</small></button>
           </div>
           <button class="btn ghost small reveal-btn" id="retire">この項目はもう覚えた → 卒業</button>`
        : `<button class="btn reveal-btn" id="reveal">答えを見る</button>`
      }
    </div>
  `;

  // 表向きで自動読み上げ
  if(DB.settings.autoSpeak && !session.revealed){
    speak(card.type==="vocab"?card.term:stripSlot(card.frame), "en");
  }

  if(!session.revealed){
    document.getElementById("reveal").onclick = ()=>{ session.revealed=true; renderStudy();
      // 答え表示時に例文を読む
      if(DB.settings.autoSpeak){
        const t = card.type==="vocab"? card.ex : card.examples[0].en;
        speak(t,"en");
      }
    };
  }else{
    document.getElementById("sp").onclick = ()=>{
      const t = card.type==="vocab"? card.ex : card.examples.map(e=>e.en).join(". ");
      speak(t,"en");
    };
    document.querySelectorAll(".grades button").forEach(b=>{
      b.onclick = ()=> grade(card, parseInt(b.dataset.g));
    });
    document.getElementById("retire").onclick = ()=>{
      const st = stateOf(card.id); st.state="retired"; st.due=Date.now()+3650*DAY;
      session.done++; save(); advance();
    };
  }
}

function grade(card, g){
  const st = stateOf(card.id);
  const wasNew = st.state==="new";
  const updated = schedule(st, g);
  DB.states[card.id] = updated;
  DB.stats.totalReviews = (DB.stats.totalReviews||0)+1;
  // 新規カードのみ「今日の新規」枠として記録
  if(wasNew && !DB.introducedToday.ids.includes(card.id)){
    DB.introducedToday.ids.push(card.id);
  }
  markStreak();
  save();
  // 忘れた→同セッションで再出
  if(g===0) session.again.push(card);
  else session.done++;
  advance();
}

function advance(){
  session.idx++;
  session.revealed=false;
  renderStudy();
}

function renderDone(){
  markStreak(); save();
  const q = buildQueue();
  app.innerHTML = `
    <div class="empty">
      <div class="big">🎉</div>
      <div style="font-size:20px;color:var(--fg);font-weight:600">お疲れさま!</div>
      <div class="muted">このセッションで ${session.done} 枚を復習しました。<br>
      ${q.total>0 ? `まだ ${q.total} 枚残っています。` : "今日の期限分は完了です。"}</div>
      ${q.total>0 ? `<button class="btn small" style="width:auto;padding:12px 24px" id="more">続ける</button>`:""}
      <button class="btn sec small" style="width:auto;padding:12px 24px" id="home2">ホームへ</button>
    </div>`;
  const m=document.getElementById("more"); if(m) m.onclick=()=>startSession("normal");
  document.getElementById("home2").onclick=()=>go("home");
  session=null;
}

function markStreak(){
  const t = todayStr();
  if(DB.stats.lastStudy === t) return;
  const y = new Date(Date.now()-DAY).toISOString().slice(0,10);
  DB.stats.streak = (DB.stats.lastStudy===y) ? (DB.stats.streak||0)+1 : 1;
  DB.stats.lastStudy = t;
}

// ============================================================
//  聞き流しモード (ハンズフリー自動再生)
// ============================================================
let listenState = { queue:[], idx:0, playing:false };
let listenTimer = null;

function renderListen(){
  // キュー = 期限復習 + 新規 + それでも足りなければ開始済み
  const q = buildQueue();
  let queue = [...q.due, ...q.fresh];
  if(queue.length < 5){
    const extra = CARDS.filter(c=>{const s=DB.states[c.id]; return s&&s.state!=="new"&&!queue.includes(c);});
    queue = queue.concat(extra).slice(0, Math.max(queue.length, 20));
  }
  if(queue.length===0) queue = CARDS.slice(0,20);
  listenState = { queue, idx:0, playing:false };
  drawListen();
}

function drawListen(){
  const card = listenState.queue[listenState.idx];
  const body = card.type==="vocab"
    ? `<div class="term">${card.term}</div>
       <div class="jp">${card.jp}</div>
       <div class="ex">${boldTerm(card.ex, card.term)}</div>
       <div class="ex exjp">${card.exJp}</div>`
    : `<div class="frame" style="font-size:30px">${card.frame}</div>
       <div class="jp">${card.jp}</div>
       <div class="ex">${card.examples[0].en}</div>
       <div class="ex exjp">${card.examples[0].jp}</div>`;
  app.innerHTML = `
    <div class="listen">
      ${body}
      <div class="listen-controls">
        <button class="lc" id="prev">⏮</button>
        <button class="lc main" id="play">${listenState.playing?"⏸":"▶"}</button>
        <button class="lc" id="next">⏭</button>
      </div>
      <div class="muted" style="margin-top:16px">${listenState.idx+1} / ${listenState.queue.length}</div>
      <div class="muted" style="font-size:12px;max-width:280px">画面を消すと停止します(端末の仕様)。再生中は画面をつけたままにしてください。</div>
    </div>`;
  document.getElementById("play").onclick = toggleListen;
  document.getElementById("next").onclick = ()=>{ stopSpeak(); listenState.idx=Math.min(listenState.queue.length-1,listenState.idx+1); drawListen(); if(listenState.playing) playCurrent(); };
  document.getElementById("prev").onclick = ()=>{ stopSpeak(); listenState.idx=Math.max(0,listenState.idx-1); drawListen(); if(listenState.playing) playCurrent(); };
}

function toggleListen(){
  listenState.playing = !listenState.playing;
  drawListen();
  if(listenState.playing) playCurrent();
  else stopSpeak();
}

async function playCurrent(){
  const gap = (DB.settings.listenGap||1.4)*1000;
  while(listenState.playing && listenState.idx < listenState.queue.length){
    const card = listenState.queue[listenState.idx];
    if(card.type==="vocab"){
      await speak(card.term,"en"); if(!listenState.playing) return; await wait(gap*0.5);
      await speak(card.jp,"ja"); if(!listenState.playing) return; await wait(gap*0.4);
      await speak(card.ex,"en"); if(!listenState.playing) return; await wait(gap);
    }else{
      await speak(stripSlot(card.frame),"en"); if(!listenState.playing) return; await wait(gap*0.5);
      await speak(card.jp,"ja"); if(!listenState.playing) return; await wait(gap*0.4);
      await speak(card.examples[0].en,"en"); if(!listenState.playing) return; await wait(gap);
    }
    if(!listenState.playing) return;
    if(listenState.idx < listenState.queue.length-1){
      listenState.idx++; drawListen();
    }else{
      listenState.playing=false; drawListen(); return;
    }
  }
}

// ============================================================
//  設定
// ============================================================
function renderSettings(){
  const s = DB.settings;
  app.innerHTML = `
    <div class="section-title">1日の新規カード数</div>
    <div class="row" style="margin-bottom:14px">
      ${[6,12,20,30].map(n=>`<button class="btn ${s.newPerDay===n?'':'sec'} small" data-n="${n}">${n}</button>`).join("")}
    </div>

    <div class="section-title">出題の順序</div>
    ${radio("order","mix","単語と表現を混ぜる")}
    ${radio("order","vocab","単語を優先")}
    ${radio("order","expr","表現を優先")}

    <div class="section-title">音声</div>
    <div class="toggle"><label>カード表示時に自動で読み上げ</label>
      <div class="switch ${s.autoSpeak?'on':''}" id="tgAuto"><i></i></div></div>

    <div class="section-title">聞き流しの間(ま)</div>
    <div class="row">
      ${[0.8,1.4,2.2].map(g=>`<button class="btn ${s.listenGap===g?'':'sec'} small" data-gap="${g}">${g===0.8?"速い":g===1.4?"標準":"ゆっくり"}</button>`).join("")}
    </div>

    <div class="section-title">データ</div>
    <button class="btn ghost small" id="export">進捗をバックアップ (書き出し)</button>
    <button class="btn ghost small" id="reset" style="color:#e5484d">進捗をすべてリセット</button>
    <div class="muted center" style="margin-top:20px">総復習回数: ${DB.stats.totalReviews||0} 回</div>
  `;
  document.querySelectorAll("[data-n]").forEach(b=> b.onclick=()=>{ DB.settings.newPerDay=+b.dataset.n; save(); renderSettings(); });
  document.querySelectorAll("[data-gap]").forEach(b=> b.onclick=()=>{ DB.settings.listenGap=+b.dataset.gap; save(); renderSettings(); });
  document.querySelectorAll("[data-radio]").forEach(b=> b.onclick=()=>{ DB.settings[b.dataset.radio]=b.dataset.val; save(); renderSettings(); });
  document.getElementById("tgAuto").onclick=()=>{ DB.settings.autoSpeak=!DB.settings.autoSpeak; save(); renderSettings(); };
  document.getElementById("export").onclick=exportData;
  document.getElementById("reset").onclick=()=>{ if(confirm("本当に全ての進捗を消去しますか?")){ localStorage.removeItem(STORE_KEY); DB=load(); go("home"); } };
}
function radio(key,val,label){
  const on = DB.settings[key]===val;
  return `<div class="toggle" data-radio="${key}" data-val="${val}" style="cursor:pointer">
    <label>${label}</label><div class="switch ${on?'on':''}"><i></i></div></div>`;
}
function exportData(){
  const blob = new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="english_progress_"+todayStr()+".json"; a.click();
}

// ============================================================
//  ユーティリティ
// ============================================================
function boldTerm(sentence, term){
  const base = term.replace(/\s+/g,' ');
  const re = new RegExp("\\b("+base.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+"\\w*)","i");
  return sentence.replace(re,"<b>$1</b>");
}
function stripSlot(frame){ return frame.replace(/~/g,"blank").replace(/\?/g,""); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } }

// ---- ナビ ----
document.querySelectorAll("nav button").forEach(b=> b.onclick=()=>{
  if(b.dataset.v==="study"){ startSession("normal"); }  // 学習タブは直接セッション開始
  else go(b.dataset.v);
});

// 初回起動でモバイル音声を有効化(最初のタップで無音を1回鳴らす)
let audioUnlocked=false;
document.addEventListener("click",()=>{
  if(!audioUnlocked && "speechSynthesis" in window){
    const u=new SpeechSynthesisUtterance(""); speechSynthesis.speak(u); audioUnlocked=true;
  }
},{once:true});

go("home");
