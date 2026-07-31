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

// 品詞コード → 日本語ラベル
const POS_JP = {
  "v.":"動詞", "n.":"名詞", "adj.":"形容詞", "adv.":"副詞",
  "phr.":"熟語", "prep.":"前置詞", "conj.":"接続詞", "pron.":"代名詞",
  "v./n.":"動詞・名詞", "n./v.":"名詞・動詞", "adj./n.":"形容詞・名詞", "adj./adv.":"形容詞・副詞",
};
function posJP(pos){ return POS_JP[pos] || pos || ""; }

// 発音カタカナ / 発音ポイント / 覚え方
function infoOf(card){ return (typeof INFO !== "undefined") ? INFO[card.id] : null; }

// カードの例文を配列 [{en,jp}, ...] で返す (単語は最大2つ、表現は元の配列)
function examplesOf(card){
  if(card.type === "expr") return card.examples || [];
  const out = [];
  if(card.ex) out.push({ en:card.ex, jp:card.exJp });
  const e2 = (typeof EX2 !== "undefined") ? EX2[card.id] : null;
  if(e2) out.push(e2);
  return out;
}

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

// ---- 学習セッションの保存/復元(閉じても続きから) ----
const SESSION_KEY = "eng_session_v1";
function saveSession(){
  if(!session){ localStorage.removeItem(SESSION_KEY); return; }
  try{
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      date: todayStr(), mode: session.mode,
      queueIds: session.queue.map(c=>c.id), idx: session.idx,
      done: session.done, total: session.total,
      againIds: session.again.map(c=>c.id),
    }));
  }catch(e){}
}
function loadSession(){
  try{
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if(!s || s.date !== todayStr()) return null;
    const queue = (s.queueIds||[]).map(id=>CARD_BY_ID[id]).filter(Boolean);
    const again = (s.againIds||[]).map(id=>CARD_BY_ID[id]).filter(Boolean);
    if(s.idx >= queue.length && again.length===0) return null; // 完了済み
    return { queue, idx:s.idx, total:s.total||queue.length, revealed:false, mode:s.mode||"normal", done:s.done||0, again };
  }catch(e){ return null; }
}
function sessionRemaining(){
  if(!session) return 0;
  return Math.max(0, session.queue.length - session.idx) + session.again.length;
}

// ---- 今日の学習回数カウント ----
function bumpTodayCount(){
  if(!DB.stats.today || DB.stats.today.date !== todayStr()){
    DB.stats.today = { date: todayStr(), n: 0 };
  }
  DB.stats.today.n += 1;
}
function todayCount(){ return (DB.stats.today && DB.stats.today.date===todayStr()) ? DB.stats.today.n : 0; }

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
  stopListenPlayback();
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

// ---------- ホーム(ダッシュボード) ----------
function renderHome(){
  const q = buildQueue();
  const p = progressCounts();                 // learned, learning, retired, total
  const notStarted = Math.max(0, p.total - p.learned - p.learning - p.retired);
  const started = p.total - notStarted;
  const streak = DB.stats.streak || 0;
  const introduced = DB.introducedToday.ids.length;
  const doneToday = todayCount();
  const resuming = session && sessionRemaining()>0;
  const remaining = resuming ? sessionRemaining() : q.total;

  // 今日の目標に対する進み具合
  const todayGoal = Math.max(1, doneToday + q.total);
  const todayPct = Math.round(doneToday / todayGoal * 100);

  // 全体の内訳バー
  const seg = (n,cls)=> n>0 ? `<i class="${cls}" style="width:${(n/p.total*100).toFixed(1)}%"></i>` : "";

  // メインボタンの文言
  let mainLabel, mainAction;
  if(resuming){ mainLabel = `▶ 学習を再開(残り ${remaining} 枚)`; mainAction = ()=>go("study"); }
  else if(q.total>0){ mainLabel = `学習を始める(${q.total} 枚)`; mainAction = ()=>startSession("normal"); }
  else { mainLabel = "🔁 復習を続ける"; mainAction = ()=>startSession("cram"); }

  app.innerHTML = `
    <div class="today">
      <div class="today-top">
        <div><div class="today-big">${doneToday}<span>枚</span></div><div class="lbl">今日 学習した</div></div>
        <div class="today-right">
          <div>🔥 連続 <b>${streak}</b> 日</div>
          <div>➕ 今日追加 <b>${introduced}</b> 語</div>
        </div>
      </div>
      <div class="tprog"><i style="width:${resuming||q.total>0?todayPct:100}%"></i></div>
      <div class="lbl">${q.total>0 ? `今日の残り ${q.total} 枚(復習 ${q.due.length}・新規 ${q.fresh.length})` : "今日のぶんは完了しました 🎉"}</div>
    </div>

    <button class="btn" id="mainBtn">${mainLabel}</button>
    <div class="row">
      <button class="btn sec small" id="startListen">🎧 聞き流し</button>
      <button class="btn sec small" id="cram">🔁 総復習</button>
    </div>

    <div class="section-title">全体の進み具合</div>
    <div class="pbar">${seg(p.retired,'s-ret')}${seg(p.learned,'s-lrn')}${seg(p.learning,'s-ing')}${seg(notStarted,'s-new')}</div>
    <div class="legend">
      <span><i class="s-ret"></i>習得済み ${p.retired}</span>
      <span><i class="s-lrn"></i>定着 ${p.learned}</span>
      <span><i class="s-ing"></i>学習中 ${p.learning}</span>
      <span><i class="s-new"></i>未学習 ${notStarted}</span>
    </div>
    <div class="muted center" style="margin-top:12px">全 ${p.total} 語のうち <b>${started}</b> 語に着手 / 累計 ${DB.stats.totalReviews||0} 回</div>
  `;
  document.getElementById("mainBtn").onclick = mainAction;
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
  saveSession();
  go("study");
}

// 進行中のセッションがあれば続きから、なければ新規開始
function studyOrResume(){
  if(session && sessionRemaining()>0){ go("study"); }
  else startSession("normal");
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

  const info = infoOf(card);
  const kanaHtml = info && info.kana ? `<div class="kana">${info.kana}</div>` : "";
  const tipHtml  = info && info.tip  ? `<div class="tip">🗣 ${info.tip}</div>` : "";
  const front = card.type==="vocab"
    ? `<div class="kicker">${isNew?"新しい単語":"単語"}</div>
       <div class="term">${card.term}</div>${kanaHtml}<div class="pos">${posJP(card.pos)}</div>${tipHtml}`
    : `<div class="kicker">${isNew?"新しい表現":"表現"}</div>
       <div class="frame">${card.frame}</div>${kanaHtml}${tipHtml}`;

  const exList = examplesOf(card);
  let backHtml = "";
  if(session.revealed){
    const exHtml = exList.slice(0,2).map(e=>
      `<div class="ex"><span class="en">${card.type==="vocab"?boldTerm(e.en,card.term):e.en}</span><br><span class="exjp">${e.jp}</span></div>`
    ).join("");
    const memHtml = info && info.mem ? `<div class="mem">💡 覚え方: ${info.mem}</div>` : "";
    backHtml = `<div class="divider"></div>
         <div class="answer">
           <div class="jp">${card.jp}</div>
           ${exHtml}
           ${card.type==="expr" ? `<div class="note">${card.note}</div>` : ""}
           ${memHtml}
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
      // 答え表示時に例文(1つ目)を読む
      if(DB.settings.autoSpeak && exList[0]){
        speak(exList[0].en,"en");
      }
    };
  }else{
    document.getElementById("sp").onclick = async ()=>{
      // 2つの例文を順に読む
      for(const e of exList.slice(0,2)){ await speak(e.en,"en"); await wait(500); }
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
  bumpTodayCount();
  // 新規カードのみ「今日の新規」枠として記録
  if(wasNew && !DB.introducedToday.ids.includes(card.id)){
    DB.introducedToday.ids.push(card.id);
  }
  markStreak();
  save();
  // 選んだ結果を一瞬フィードバック(次にいつ出るか)
  toast(g===0 ? "🔁 すぐにもう一度出します" : `✓ 次は ${nextText(updated)}`);
  // 忘れた→同セッションで再出
  if(g===0) session.again.push(card);
  else session.done++;
  advance();
}

function advance(){
  session.idx++;
  session.revealed=false;
  saveSession();
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
  saveSession();
}

function markStreak(){
  const t = todayStr();
  if(DB.stats.lastStudy === t) return;
  const y = new Date(Date.now()-DAY).toISOString().slice(0,10);
  DB.stats.streak = (DB.stats.lastStudy===y) ? (DB.stats.streak||0)+1 : 1;
  DB.stats.lastStudy = t;
}

// ============================================================
//  聞き流しモード (音声ファイル + バックグラウンド/ロック画面再生)
//  ※ 音声ファイルが無い時は端末読み上げにフォールバック(背景再生不可)
// ============================================================
let listenState = { queue:[], idx:0, playing:false };
let listenAudio = null;
let curPlayId = 0;      // next/prev や停止で古い再生を無効化

function getAudioEl(){
  if(!listenAudio){ listenAudio = new Audio(); listenAudio.preload = "auto"; }
  return listenAudio;
}
function audioSrc(id){ return "audio/" + id + ".mp3"; }

function stopListenPlayback(){
  listenState.playing = false;
  curPlayId++;
  if(listenAudio) listenAudio.pause();
  stopSpeak();
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

function renderListen(){
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
  const info = infoOf(card);
  const kanaHtml = info && info.kana ? `<div class="kana">${info.kana}</div>` : "";
  const head = card.type==="vocab"
    ? `<div class="term">${card.term}</div>${kanaHtml}<div class="pos">${posJP(card.pos)}</div>
       <div class="jp">${card.jp}</div>`
    : `<div class="frame" style="font-size:30px">${card.frame}</div>${kanaHtml}
       <div class="jp">${card.jp}</div>`;
  const exHtml = examplesOf(card).slice(0,2).map(e=>
    `<div class="ex">${card.type==="vocab"?boldTerm(e.en,card.term):e.en}<br><span class="exjp">${e.jp}</span></div>`
  ).join("");
  app.innerHTML = `
    <div class="listen">
      ${head}${exHtml}
      <div class="listen-controls">
        <button class="lc" id="prev">⏮</button>
        <button class="lc main" id="play">${listenState.playing?"⏸":"▶"}</button>
        <button class="lc" id="next">⏭</button>
      </div>
      <div class="muted" style="margin-top:16px">${listenState.idx+1} / ${listenState.queue.length}</div>
      <div class="muted" style="font-size:12px;max-width:300px">🔒 画面を消しても・他アプリ中でも再生が続きます。ロック画面で操作できます。</div>
    </div>`;
  document.getElementById("play").onclick = toggleListen;
  document.getElementById("next").onclick = ()=> gotoListen(1);
  document.getElementById("prev").onclick = ()=> gotoListen(-1);
}

function toggleListen(){
  if(listenState.playing){
    stopListenPlayback();
    drawListen();
  }else{
    listenState.playing = true;
    playIdx();
  }
}

function gotoListen(delta){
  if(listenAudio) listenAudio.pause();
  stopSpeak();
  curPlayId++;
  listenState.idx = Math.min(listenState.queue.length-1, Math.max(0, listenState.idx+delta));
  drawListen();
  if(listenState.playing) playIdx();
}

function playIdx(){
  const card = listenState.queue[listenState.idx];
  const myId = ++curPlayId;
  drawListen();
  setMediaSession(card);
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  const a = getAudioEl();
  a.onended = ()=>{ if(myId!==curPlayId || !listenState.playing) return; advanceListen(); };
  a.onerror = ()=>{ if(myId!==curPlayId || !listenState.playing) return; fallbackSpeak(card, myId); };
  a.src = audioSrc(card.id);
  a.currentTime = 0;
  const p = a.play();
  if(p && p.catch) p.catch(()=>{ if(myId!==curPlayId || !listenState.playing) return; fallbackSpeak(card, myId); });
}

function advanceListen(){
  const gap = (DB.settings.listenGap||1.4)*1000;
  if(listenState.idx < listenState.queue.length-1){
    setTimeout(()=>{ if(listenState.playing){ listenState.idx++; playIdx(); } }, gap);
  }else{
    stopListenPlayback(); drawListen();
  }
}

// 音声ファイルが利用できない時のフォールバック(端末読み上げ)
async function fallbackSpeak(card, myId){
  const exs = examplesOf(card).slice(0,2);
  if(card.type==="vocab"){ await speak(card.term,"en"); if(myId!==curPlayId||!listenState.playing) return; await wait(300); }
  await speak(card.jp,"ja"); if(myId!==curPlayId||!listenState.playing) return; await wait(250);
  for(const e of exs){ await speak(e.en,"en"); if(myId!==curPlayId||!listenState.playing) return; await wait(300); }
  advanceListen();
}

function setMediaSession(card){
  if(!("mediaSession" in navigator)) return;
  const title = card.type==="vocab" ? card.term : card.frame;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist:card.jp, album:"English Trainer" });
  }catch(e){}
  navigator.mediaSession.setActionHandler("play", ()=>{ if(!listenState.playing){ listenState.playing=true; playIdx(); } });
  navigator.mediaSession.setActionHandler("pause", ()=>{ stopListenPlayback(); drawListen(); });
  navigator.mediaSession.setActionHandler("nexttrack", ()=> gotoListen(1));
  navigator.mediaSession.setActionHandler("previoustrack", ()=> gotoListen(-1));
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

    <div class="section-title">オフライン音声</div>
    <button class="btn sec small" id="prefetch">📥 全音声をこの端末に保存(約19MB)</button>
    <div class="muted center" id="prefetchMsg" style="margin-top:8px">Wi-Fiで一度保存すれば、圏外・バックグラウンドでも音が流れます。</div>

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
  document.getElementById("prefetch").onclick=prefetchAudio;
}

// 全音声を事前ダウンロード(Service Worker に依頼)
function prefetchAudio(){
  const msg = document.getElementById("prefetchMsg");
  if(!("serviceWorker" in navigator) || !navigator.serviceWorker.controller){
    msg.textContent = "アプリをホーム画面に追加してから再度お試しください。";
    return;
  }
  msg.textContent = "ダウンロード中… 0%";
  navigator.serviceWorker.controller.postMessage({ type:"PREFETCH_AUDIO", ids: CARDS.map(c=>c.id) });
}
if("serviceWorker" in navigator){
  navigator.serviceWorker.addEventListener("message", e=>{
    if(e.data && e.data.type==="PREFETCH_PROGRESS"){
      const msg = document.getElementById("prefetchMsg");
      if(msg){
        const pct = Math.round(e.data.done/e.data.total*100);
        msg.textContent = e.data.done>=e.data.total ? "✅ 保存完了。オフライン・バックグラウンドで再生できます。" : `ダウンロード中… ${pct}%`;
      }
    }
  });
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

// 一瞬だけ出るフィードバック表示
function toast(msg){
  let t=document.getElementById("toast");
  if(!t){ t=document.createElement("div"); t.id="toast"; document.body.appendChild(t); }
  t.textContent=msg; t.classList.add("show");
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove("show"), 1500);
}

// ---- ナビ ----
document.querySelectorAll("nav button").forEach(b=> b.onclick=()=>{
  if(b.dataset.v==="study"){ studyOrResume(); }  // 続きがあれば再開
  else go(b.dataset.v);
});

// 初回起動でモバイル音声を有効化(最初のタップで無音を1回鳴らす)
let audioUnlocked=false;
document.addEventListener("click",()=>{
  if(!audioUnlocked && "speechSynthesis" in window){
    const u=new SpeechSynthesisUtterance(""); speechSynthesis.speak(u); audioUnlocked=true;
  }
},{once:true});

// 閉じる/バックグラウンド時に確実に保存
["visibilitychange","pagehide"].forEach(ev=>
  document.addEventListener(ev, ()=>{ save(); saveSession(); })
);

// 起動時に前回の続きを復元
session = loadSession();
go("home");
