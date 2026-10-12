// 日服更新公告抓取（GitHub Actions 每日執行）
// 讀取日服更新列表 → 抓最新幾篇公告 → 抽出維護時間同活動期間 → 換算成 GMT+8 → 寫入 data/jp_news.json
// 唔需要任何 Token；只用 Node 內置 fetch。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const LIST = "https://www.onmyojigame.jp/m/news/update/index.html";
const KEEP = 6; // 保留最新幾篇
const OUT = "data/jp_news.json";

// ---------- 工具 ----------
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr|dt|dd|section|article|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/：/g, ":").replace(/\r/g, "")
    .split("\n").map(s => s.replace(/[ \t　]+/g, " ").trim()).filter(Boolean).join("\n");
}
const pad = n => String(n).padStart(2, "0");

// 日本時間（GMT+9）→ GMT+8：減 1 小時；23:59 係「當日完」，兩邊伺服器都係各自 23:59，所以唔改
export function jstToGmt8(ymd, hm) {
  if (!hm || hm === "23:59") return { date: ymd, time: hm || "" };
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), h - 1, m));
  return { date: d.toISOString().slice(0, 10), time: pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) };
}

const yearFor = (m, baseY, baseM) => (m < baseM - 6 ? baseY + 1 : m > baseM + 6 ? baseY - 1 : baseY);
const DT = "(\\d{1,2})月(\\d{1,2})日\\s*(?:[（(][^）)]{1,3}[)）])?\\s*(\\d{1,2}:\\d{2})?\\s*(?:[（(][^）)]{1,3}[)）])?\\s*(メンテナンス後|メンテナンス前|メンテ後|メンテ前)?";

function tok(m, i, baseY, baseM) {
  if (!m[i]) return null;
  const mo = +m[i], d = +m[i + 1];
  return { ymd: `${yearFor(mo, baseY, baseM)}-${pad(mo)}-${pad(d)}`, hm: m[i + 2] ? pad(m[i + 2].split(":")[0]) + ":" + m[i + 2].split(":")[1] : "", mt: m[i + 3] ? (/後/.test(m[i + 3]) ? "後" : "前") : "" };
}

// 一行期間文字 → {date,time,end,endTime,perm?}
export function parseRange(s, baseY, baseM, maint) {
  const t = s.replace(/[～〜~]|-{1,2}|ー/g, "～");
  const r = t.match(new RegExp(DT + "\\s*～\\s*" + DT));
  const one = t.match(new RegExp(DT));
  if (!one) return null;
  const a = tok(r || one, 1, baseY, baseM), b = r ? tok(r, 5, baseY, baseM) : null;
  const ev = {};
  if (a.mt === "後") { ev.date = a.ymd; ev.time = "維護後"; }
  else { const c = jstToGmt8(a.ymd, a.hm); ev.date = c.date; ev.time = c.time; }
  if (!b) { ev.perm = true; return ev; }
  if (b.mt === "前") { ev.end = b.ymd; ev.endTime = maint && maint.date === b.ymd ? maint.start : "維護前"; }
  else { const c = jstToGmt8(b.ymd, b.hm || "23:59"); ev.end = c.date; ev.endTime = c.time; }
  return ev;
}

export function parseArticle(html, url, posted) {
  const text = htmlToText(html);
  const tm = String(html).match(/<title>([^<]*)<\/title>/i);
  const title = (tm ? tm[1] : text.split("\n")[0]).replace(/[|｜].*$/, "").replace(/\s*-\s*陰陽師.*$/, "").trim();
  const um = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  const pm = text.match(/掲載(?:時間|日時?)\s*:?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  const pdate = pm ? `${pm[1]}-${pad(pm[2])}-${pad(pm[3])}` : posted || (um ? `${um[1]}-${um[2]}-${um[3]}` : "");
  const baseY = +(pdate || new Date().toISOString()).slice(0, 4), baseM = +(pdate || new Date().toISOString()).slice(5, 7);

  let maint = null;
  const mm = text.match(/メンテナンス日時\s*:?\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:[（(][^）)]{1,3}[)）])?\s*(\d{1,2}:\d{2})\s*[～〜~\-ー]+\s*(\d{1,2}:\d{2})/)
    || text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:[（(][^）)]{1,3}[)）])?\s*(\d{1,2}:\d{2})\s*[～〜~\-ー]+\s*(\d{1,2}:\d{2})[^\n]{0,20}メンテナンス/);
  if (mm) {
    const y = mm[1] ? +mm[1] : yearFor(+mm[2], baseY, baseM), ymd = `${y}-${pad(mm[2])}-${pad(mm[3])}`;
    const s = jstToGmt8(ymd, pad(mm[4].split(":")[0]) + ":" + mm[4].split(":")[1]), e = jstToGmt8(ymd, pad(mm[5].split(":")[0]) + ":" + mm[5].split(":")[1]);
    maint = { date: s.date, start: s.time, end: e.time, raw: mm[0].replace(/^メンテナンス日時\s*:?\s*/, "") };
  }

  const lines = text.split("\n"), secs = [];
  let cur = null;
  for (const L of lines) {
    const h = L.match(/^(\d{1,2})\s*[.．、]\s*(.{2,60})$/);
    if (h && !/^\d{1,2}月/.test(L)) { cur = { name: h[2].trim(), lines: [] }; secs.push(cur); }
    else if (cur) cur.lines.push(L);
  }
  const events = [];
  for (const s of secs) {
    const body = s.lines.join("\n");
    const per = body.match(/(?:イベント|召喚|開催|販売|実施)?期間\s*:?\s*([^\n]+)/);
    if (!per) continue;
    const ev = parseRange(per[1], baseY, baseM, maint);
    if (!ev) continue;
    events.push(Object.assign({ name: s.name, raw: per[1].trim() }, ev));
  }
  return { title, url, posted: pdate, maint, events };
}

export function listLinks(html, base) {
  const out = [], seen = new Set();
  const re = /href=["']([^"']*\/news\/update\/\d{4}\/\d{2}\/\d{2}\/\d+_\d+\.html)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = new URL(m[1], base).href;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "yys-dimsum-calendar (GitHub Actions; once a day)" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let cs = (ct.match(/charset=([\w-]+)/) || [])[1];
  if (!cs) { const head = new TextDecoder("latin1").decode(buf.slice(0, 2000)); cs = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8"; }
  try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

async function main() {
  const listHtml = await get(LIST);
  const links = listLinks(listHtml, LIST).slice(0, KEEP);
  if (!links.length) throw new Error("列表頁搵唔到公告連結，可能網站改版");
  const items = [];
  for (const u of links) {
    try { items.push(parseArticle(await get(u), u)); }
    catch (e) { console.warn("略過", u, e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
  items.sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));
  const data = { source: LIST, tz: "GMT+8（已由日本時間減 1 小時；23:59 保持不變）", items };
  const old = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const same = old && JSON.stringify(JSON.parse(old).items) === JSON.stringify(items);
  if (same) { console.log("冇新內容"); return; }
  data.built = new Date().toISOString();
  mkdirSync("data", { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 1) + "\n");
  console.log(`已寫入 ${items.length} 篇，共 ${items.reduce((n, x) => n + x.events.length, 0)} 個活動`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
