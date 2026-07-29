// data.js / examples2.js を読み込み、音声生成用の manifest を書き出す
const fs = require("fs");
const vm = require("vm");
const ctx = {};
vm.createContext(ctx);
// vm 内の const/let はコンテキストに漏れないので、宣言キーワードを外して暗黙グローバル化
const strip = s => s.replace(/\bconst\s+/g, "").replace(/\blet\s+/g, "");
vm.runInContext(strip(fs.readFileSync("data.js", "utf8")), ctx);
vm.runInContext(strip(fs.readFileSync("examples2.js", "utf8")), ctx);

const out = [];
for (const v of ctx.VOCAB) {
  const exs = [];
  if (v.ex) exs.push(v.ex);
  if (ctx.EX2[v.id]) exs.push(ctx.EX2[v.id].en);
  out.push({ id: v.id, type: "vocab", head: v.term, jp: v.jp, exs: exs.slice(0, 2) });
}
for (const e of ctx.EXPRESSIONS) {
  const exs = (e.examples || []).slice(0, 2).map(x => x.en);
  out.push({ id: e.id, type: "expr", head: "", jp: e.jp, exs });
}
fs.writeFileSync("_audio_manifest.json", JSON.stringify(out, null, 0));
console.log("manifest written:", out.length, "cards");
