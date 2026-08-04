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
    if (grade === 1) {
      // あやふや → 同じ日のうちにもう一度
      c.interval = 0;
      c.due = now + 5 * 60 * 1000; // 5分後
      c.state = "learning";
      return c;
    }
    // 覚えた/完璧 → 「数日後」に必ず再チェック(覚え違いを防ぐ)。すぐには卒業させない
    c.reps += 1;
    if (c.reps === 1) {
      c.interval = grade === 3 ? 3 : 2;  // 完璧=3日後 / 覚えた=2日後
      c.state = "learning";              // もう一度確認するまで卒業しない
    } else {
      c.interval = grade === 3 ? 6 : 4;  // さらに数日後 → 復習フェーズへ
      c.state = "review";
    }
    c.due = now + c.interval * DAY;
    return c;
  }

  // review 状態: 間隔を伸ばす(「覚えた」は控えめに伸ばして再確認を多めに)
  c.reps += 1;
  const factor = grade === 1 ? 1.3 : grade === 3 ? c.ease : c.ease * 0.8;
  c.interval = Math.min(180, Math.max(2, Math.round(c.interval * factor))); // 最長でも半年で必ず再確認
  // ease調整
  if (grade === 1) c.ease = Math.max(1.3, c.ease - 0.15);
  else if (grade === 3) c.ease = c.ease + 0.1;
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
