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
  // 頻出優先: 頻度ティア昇順(同ティア内は元の順を保つ安定ソート)
  const byFreq = arr => arr.map((c,i)=>[c,i])
    .sort((a,b)=> (freqTier(a[0].id)-freqTier(b[0].id)) || (a[1]-b[1]))
    .map(x=>x[0]);
  const vocab = byFreq(notStarted.filter(c=>c.type==="vocab"));
  const expr  = notStarted.filter(c=>c.type==="expr"); // 表現はどれも日常頻出
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

  // 出題方向を決定(初回は英→日で認識、以降はランダムで日→英も混ぜる)
  if(session._dirIdx !== session.idx){
    session._dirIdx = session.idx;
    session.dir = isNew ? "en2jp" : (Math.random()<0.5 ? "jp2en" : "en2jp");
  }
  const dir = session.dir;

  const info = infoOf(card);
  const kanaHtml = info && info.kana ? `<div class="kana">${info.kana}</div>` : "";
  const tipHtml  = info && info.tip  ? `<div class="tip">🗣 ${info.tip}</div>` : "";
  const exList = examplesOf(card);
  const exHtml = exList.slice(0,2).map(e=>
    `<div class="ex"><span class="en">${card.type==="vocab"?boldTerm(e.en,card.term):e.en}</span><br><span class="exjp">${e.jp}</span></div>`
  ).join("");
  const memHtml = info && info.mem ? `<div class="mem">💡 覚え方: ${info.mem}</div>` : "";
  const noteHtml = card.type==="expr" ? `<div class="note">${card.note}</div>` : "";
  // 英語側(答え or 問題)の表示
  const engBlock = card.type==="vocab"
    ? `<div class="term">${card.term}</div>${kanaHtml}<div class="pos">${posJP(card.pos)}</div>${tipHtml}`
    : `<div class="frame">${card.frame}</div>${kanaHtml}${tipHtml}`;

  let front, backHtml = "";
  if(dir==="jp2en"){
    // 日本語 → 英語(産出練習)
    front = `<div class="kicker">${card.type==="vocab"?"日本語 → 英語":"日本語 → 英語の型"}</div>
       <div class="q-jp">${card.jp}</div>
       <div class="tip">${card.type==="vocab"?"英語では?" : "どんな型で言う?"}</div>`;
    if(session.revealed){
      backHtml = `<div class="divider"></div><div class="answer">
           ${engBlock}${exHtml}${noteHtml}${memHtml}
           <button class="speak" id="sp">🔊</button></div>`;
    }
  }else{
    // 英語 → 日本語(認識)
    front = card.type==="vocab"
      ? `<div class="kicker">${isNew?"新しい単語":"単語"}</div>${engBlock}`
      : `<div class="kicker">${isNew?"新しい表現":"表現"}</div>${engBlock}`;
    if(session.revealed){
      backHtml = `<div class="divider"></div><div class="answer">
           <div class="jp">${card.jp}</div>${exHtml}${noteHtml}${memHtml}
           <button class="speak" id="sp">🔊</button></div>`;
    }
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

  // 表向きで自動読み上げ(英→日のときだけ。日→英は答えを隠すため鳴らさない)
  if(DB.settings.autoSpeak && !session.revealed && dir==="en2jp"){
    speak(card.type==="vocab"?card.term:stripSlot(card.frame), "en");
  }

  if(!session.revealed){
    document.getElementById("reveal").onclick = async ()=>{ session.revealed=true; renderStudy();
      // 答え表示時に読み上げ。日→英は答えの英語も読む
      if(DB.settings.autoSpeak){
        if(dir==="jp2en"){ await speak(card.type==="vocab"?card.term:stripSlot(card.frame),"en"); await wait(400); }
        if(exList[0]) speak(exList[0].en,"en");
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
//  聞き流しモード (複数音声を1本に連結して連続再生)
//  → 再生中にソースを切り替えないので、画面オフ・他アプリ中でも止まらない
// ============================================================
let listenState = { queue:[], idx:0, playing:false, offsets:[], url:null, ready:false, building:false };
let listenAudio = null;
let _actx = null;
let assembleToken = 0;

function getAudioEl(){
  if(!listenAudio){
    listenAudio = new Audio();
    listenAudio.preload = "auto";
    listenAudio.ontimeupdate = onListenTime;
    listenAudio.onended = ()=>{ if(listenState.ready){ stopListenPlayback(); if(VIEW==="listen") drawListen(); } };
  }
  return listenAudio;
}
function getAudioCtx(){
  if(!_actx){ const C = window.AudioContext||window.webkitAudioContext; if(C){ try{ _actx = new C(); }catch(e){} } }
  if(_actx && _actx.state==="suspended"){ _actx.resume().catch(()=>{}); }
  return _actx;
}
function audioSrc(id){ return "audio/" + id + ".mp3"; }

function stopListenPlayback(){
  listenState.playing = false;
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
  queue = queue.slice(0, 40); // 連結は重いので最大40枚
  if(listenState.url){ try{URL.revokeObjectURL(listenState.url);}catch(e){} }
  listenState = { queue, idx:0, playing:false, offsets:[], url:null, ready:false, building:false };
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
  const status = listenState.building
    ? `<div class="muted" style="font-size:12px">⏳ 音声を準備中…(初回のみ少し待ちます)</div>`
    : `<div class="muted" style="font-size:12px;max-width:300px">🔒 画面を消しても・他アプリ中でも再生が続きます。</div>`;
  app.innerHTML = `
    <div class="listen">
      ${head}${exHtml}
      <div class="listen-controls">
        <button class="lc" id="prev">⏮</button>
        <button class="lc main" id="play">${listenState.playing?"⏸":"▶"}</button>
        <button class="lc" id="next">⏭</button>
      </div>
      <div class="muted" style="margin-top:16px">${listenState.idx+1} / ${listenState.queue.length}</div>
      ${status}
    </div>`;
  document.getElementById("play").onclick = toggleListen;
  document.getElementById("next").onclick = ()=> gotoListen(1);
  document.getElementById("prev").onclick = ()=> gotoListen(-1);
}

function toggleListen(){
  if(listenState.playing){ stopListenPlayback(); drawListen(); return; }
  listenState.playing = true;
  const a = getAudioEl();
  setMediaSession(listenState.queue[listenState.idx]);
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  if(listenState.ready && listenState.url){
    if(a.src !== listenState.url) a.src = listenState.url;
    try{ a.currentTime = listenState.offsets[listenState.idx] || 0; }catch(e){}
    a.play().catch(()=>{});
    drawListen();
  }else{
    // 初回: ユーザー操作の瞬間に1語目を同期再生してロックを解除 → 裏で全部を連結して差し替え
    a.src = audioSrc(listenState.queue[listenState.idx].id);
    a.currentTime = 0;
    a.play().catch(()=>{ if(listenState.playing) fallbackSpeakLoop(); });
    drawListen();
    assembleAndPlay();
  }
}

async function assembleAndPlay(){
  const token = ++assembleToken;
  listenState.building = true;
  if(VIEW==="listen") drawListen();
  try{
    const ctx = getAudioCtx();
    const cards = listenState.queue;
    const parts = [], offsets = [];
    let t = 0;
    for(let i=0;i<cards.length;i++){
      const ab = await fetchArrayBuffer(audioSrc(cards[i].id));
      if(token!==assembleToken) return;
      parts.push(new Uint8Array(ab.slice(0)));
      offsets.push(t);
      let dur = 0;
      if(ctx){ dur = await decodeDuration(ctx, ab); }
      t += (dur || 6);
    }
    if(token!==assembleToken) return;
    const url = URL.createObjectURL(new Blob(parts, { type:"audio/mpeg" }));
    if(listenState.url){ try{URL.revokeObjectURL(listenState.url);}catch(e){} }
    listenState.url = url;
    listenState.offsets = offsets;
    listenState.ready = true;
    listenState.building = false;
    if(!listenState.playing){ if(VIEW==="listen") drawListen(); return; }
    const a = getAudioEl();
    const resumeAt = offsets[listenState.idx] || 0;
    a.src = url;
    await new Promise(res=>{ a.onloadedmetadata=()=>res(); setTimeout(res, 1500); });
    try{ a.currentTime = resumeAt; }catch(e){}
    a.play().catch(()=>{});
    if(VIEW==="listen") drawListen();
  }catch(e){
    listenState.building = false;
    if(VIEW==="listen") drawListen();
    if(listenState.playing) fallbackSpeakLoop(); // 連結失敗(未保存でオフライン等)→逐次読み上げ
  }
}

// 連続再生中、再生位置から今どのカードかを判定して表示を更新
function onListenTime(){
  if(!listenState.ready || !listenState.offsets.length) return;
  const ct = listenAudio.currentTime, offs = listenState.offsets;
  let idx = offs.length-1;
  for(let i=0;i<offs.length;i++){ if(ct < (offs[i+1] ?? Infinity)){ idx=i; break; } }
  if(idx !== listenState.idx){
    listenState.idx = idx;
    setMediaSession(listenState.queue[idx]);
    if(VIEW==="listen") drawListen();
  }
}

// 前へ/次へ: ソースは変えず、連結音声の中で再生位置を移動(=画面オフでも継続)
function gotoListen(delta){
  const ni = Math.min(listenState.queue.length-1, Math.max(0, listenState.idx+delta));
  listenState.idx = ni;
  setMediaSession(listenState.queue[ni]);
  if(listenState.ready && listenAudio && listenState.url){
    try{ listenAudio.currentTime = listenState.offsets[ni] || 0; }catch(e){}
  }
  if(VIEW==="listen") drawListen();
}

async function fetchArrayBuffer(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error("audio not available");
  return await r.arrayBuffer();
}
function decodeDuration(ctx, ab){
  return new Promise(res=>{
    try{ ctx.decodeAudioData(ab, b=>res(b.duration), ()=>res(0)); }
    catch(e){ res(0); }
  });
}

// フォールバック: 連結できないとき端末読み上げ(画面オフでは止まります)
let fbToken = 0;
async function fallbackSpeakLoop(){
  const my = ++fbToken;
  const gap = (DB.settings.listenGap||1.4)*1000;
  while(listenState.playing && listenState.idx < listenState.queue.length && my===fbToken){
    const card = listenState.queue[listenState.idx];
    setMediaSession(card);
    if(card.type==="vocab"){ await speak(card.term,"en"); if(my!==fbToken||!listenState.playing) return; await wait(gap*0.4); }
    await speak(card.jp,"ja"); if(my!==fbToken||!listenState.playing) return; await wait(gap*0.3);
    for(const e of examplesOf(card).slice(0,2)){ await speak(e.en,"en"); if(my!==fbToken||!listenState.playing) return; await wait(gap*0.5); }
    if(listenState.idx < listenState.queue.length-1){ listenState.idx++; if(VIEW==="listen") drawListen(); }
    else { stopListenPlayback(); if(VIEW==="listen") drawListen(); return; }
  }
}

function setMediaSession(card){
  if(!("mediaSession" in navigator)) return;
  const title = card.type==="vocab" ? card.term : card.frame;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist:card.jp, album:"English Trainer" });
  }catch(e){}
  navigator.mediaSession.setActionHandler("play", ()=>{ if(!listenState.playing) toggleListen(); });
  navigator.mediaSession.setActionHandler("pause", ()=>{ stopListenPlayback(); if(VIEW==="listen") drawListen(); });
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
