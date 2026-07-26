// ============================================================
//  間隔反復スケジューラ (SM-2ベース / Ankiの古典方式)
//  忘却曲線に沿って「忘れる直前」に再出題する
// ============================================================

const DAY = 24 * 60 * 60 * 1000;

// カードの学習状態を新規作成
function newCardState(id) {
  return {
    id,
    ease: 2.5,     // 易しさ係数
    interval: 0,   // 次回までの日数
    reps: 0,       // 連続正解回数
    lapses: 0,     // 忘れた回数
    due: Date.now(),
    state: "new",  // new / learning / review / retired
  };
}

// grade: 0=忘れた / 1=あやふや / 2=覚えた / 3=完璧(すぐ思い出せた)
// 返り値: 更新後の状態
function schedule(card, grade) {
  const c = { ...card };
  const now = Date.now();

  if (grade === 0) {
    // 忘れた → 最初からやり直し(短時間で再出題)
    c.reps = 0;
    c.lapses += 1;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.state = "learning";
    c.due = now + 1 * 60 * 1000; // 1分後(同セッション内で再出)
    return c;
  }

  // あやふや/覚えた/完璧
  if (c.state === "new" || c.state === "learning") {
    // 学習ステップ: 0日 → 1日 → 卒業
    if (grade === 1) {
      c.interval = 0;
      c.due = now + 5 * 60 * 1000; // 5分後
      c.state = "learning";
      return c;
    }
    c.reps += 1;
    if (c.reps === 1) {
      c.interval = 1;               // 明日 (もう"新規"ではない)
      c.state = "learning";
    } else {
      c.interval = grade === 3 ? 4 : 3; // 卒業
      c.state = "review";
    }
    c.due = now + c.interval * DAY;
    return c;
  }

  // review 状態: 通常のSM-2更新
  c.reps += 1;
  const factor = grade === 1 ? 1.2 : grade === 3 ? c.ease * 1.3 : c.ease;
  c.interval = Math.max(1, Math.round(c.interval * factor));
  // ease調整
  if (grade === 1) c.ease = Math.max(1.3, c.ease - 0.15);
  else if (grade === 3) c.ease = c.ease + 0.15;
  c.due = now + c.interval * DAY;
  c.state = "review";
  return c;
}

// 期限が来ているか
function isDue(card) {
  return card.state !== "retired" && card.due <= Date.now();
}

// 人が読める「次回」表示
function nextText(card) {
  if (card.state === "retired") return "習得済み";
  const diff = card.due - Date.now();
  if (diff <= 0) return "今すぐ";
  if (diff < 60 * 60 * 1000) return Math.round(diff / 60000) + "分後";
  if (diff < DAY) return Math.round(diff / 3600000) + "時間後";
  return Math.round(diff / DAY) + "日後";
}
