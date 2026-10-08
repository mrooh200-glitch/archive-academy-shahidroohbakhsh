// تست سلامت Worker زنده: درخواست‌های پشت‌سرهم می‌فرستد و برای هر کدام
// وضعیت HTTP، هدرهای CORS و Retry-After، زمان اولین بایت، زمان کل، نتیجه
// (done/error) و ردِ debug را گزارش می‌کند. در GitHub Actions اجرا می‌شود
// (workflow: chat-probe.yml). خروجی فقط وضعیت و زمان است؛ هیچ کلید یا
// secretی در آن نیست.
//
// فیلدهای هر تست در فایل تنظیم (probe.json):
//  - name, repeat, pauseMs (فاصله بین تکرارها), waitAfterMs (صبر بعد از کل تست)
//  - path (پیش‌فرض /chat), method (پیش‌فرض POST), headers (مثلاً Origin)
//  - body: بدنهٔ درخواست
//  - archive: true → مثل کلاینت سایت عمل می‌کند: برای هر پرسش از لیست
//    questions، بردار را از /embed زنده می‌گیرد، ۵ تکهٔ نزدیک را از
//    embeddings.json همین مخزن پیدا می‌کند و با mode=grounded به /chat می‌فرستد.
//  - aggregate: true → به‌جای یک خط برای هر درخواست، فقط خلاصهٔ وضعیت‌ها
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || ".github/chat-probe/probe.json", "utf8"));
const BASE = cfg.baseUrl || "https://api.sroohbakhsh.ir";

let EMB = null;
function loadEmbeddings() {
  if (EMB) return EMB;
  const raw = JSON.parse(fs.readFileSync("embeddings.json", "utf8"));
  EMB = raw.map((it) => {
    const bytes = new Uint8Array(Buffer.from(it.vector, "base64")); // کپی، تا هم‌ترازی حافظه درست باشد
    return { book: it.book, source: it.source, text: it.text, vector: new Float32Array(bytes.buffer) };
  });
  return EMB;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// مثل semanticSearch در search-widget.js (بدون فیلتر کتاب)
async function archiveContext(question, headers) {
  const res = await fetch(BASE + "/embed", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: question }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("embed http " + res.status);
  const { vector } = await res.json();
  const scored = loadEmbeddings().map((it) => ({ it, score: cosine(vector, it.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

async function one(test, i) {
  const t0 = Date.now();
  const method = test.method || "POST";
  const path = test.path || "/chat";
  const headers = { "Content-Type": "application/json", ...(test.headers || {}) };
  const out = { http: 0, acao: null, retryAfter: null, ttfb: null, total: null, result: "?", chars: 0, attempts: null, msg: "", top: "" };
  try {
    let body = test.body;
    if (test.archive) {
      const q = test.questions[i % test.questions.length];
      out.q = q;
      const top = await archiveContext(q, headers);
      out.top = `top1=${top[0].it.book.slice(0, 28)}@${top[0].score.toFixed(3)}`;
      body = { question: q, context: top.map((t) => t.it.text), mode: "grounded", debug: true };
    }
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    out.http = res.status;
    out.acao = res.headers.get("access-control-allow-origin");
    out.retryAfter = res.headers.get("retry-after");
    let firstDelta = null;
    const handle = (line) => {
      if (!line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { out.msg = "non-json: " + line.slice(0, 80); return; }
      if (o.type === "debug") out.attempts = o.attempts;
      else if (o.type === "delta") { if (firstDelta === null) firstDelta = Date.now() - t0; out.chars += (o.text || "").length; }
      else if (o.type === "done") { out.result = "done"; out.refs = o.references; }
      else if (o.type === "error") { out.result = "error"; out.msg = o.message || ""; }
      else if (o.error) { out.result = "error"; out.msg = o.error; }
      else if (Array.isArray(o.vector)) { out.result = "embed-ok"; out.chars = o.vector.length; }
    };
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (out.ttfb === null) out.ttfb = Date.now() - t0;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        lines.forEach(handle);
      }
      handle(buf);
    }
    if (out.result === "?" && res.status === 204) out.result = "empty-204";
    out.firstDelta = firstDelta;
  } catch (e) {
    out.result = "exception";
    out.msg = String(e).slice(0, 120);
  }
  out.total = Date.now() - t0;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const all = [];
  let ok = 0, n = 0;
  const totals = [];
  for (const test of cfg.tests) {
    const lines = [];
    const statuses = [];
    for (let i = 0; i < (test.repeat || 1); i++) {
      const r = await one(test, i);
      n++;
      statuses.push(r.http);
      if (r.result === "done" && r.chars > 0) { ok++; totals.push(r.total); }
      const att = r.attempts ? r.attempts.map((a) => `${a.model}#${a.attempt}=${a.status}${a.reason ? "/" + a.reason : ""}(${a.ms}ms)`).join(" > ") : "no-debug";
      const origin = (test.headers && test.headers.Origin) || "-";
      lines.push(
        `${test.name}[${i + 1}] ${test.method || "POST"} ${test.path || "/chat"} origin=${origin} http=${r.http} acao=${r.acao || "-"} retryAfter=${r.retryAfter || "-"} ${r.result} chars=${r.chars}` +
          `${r.refs !== undefined && r.refs !== null ? " refs=" + JSON.stringify(r.refs) : ""} firstDelta=${r.firstDelta ?? "-"}ms total=${r.total}ms` +
          `${r.q ? " | q=«" + r.q + "» " + r.top : ""} | ${att}${r.msg ? " | " + r.msg : ""}`
      );
      if (test.pauseMs && i < (test.repeat || 1) - 1) await sleep(test.pauseMs);
    }
    let block = lines;
    if (test.aggregate) {
      const counts = {};
      statuses.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
      const first429 = statuses.indexOf(429) + 1;
      block = [`${test.name} AGGREGATE statuses=${JSON.stringify(counts)} first429_at_request=${first429 || "none"}`, lines[first429 ? first429 - 1 : lines.length - 1]];
    }
    all.push(...block);
    console.log(block.join("\n"));
    if (test.waitAfterMs) await sleep(test.waitAfterMs);
  }
  // GitHub فقط ۱۰ annotation (notice) برای هر step نگه می‌دارد؛ پس خروجی در
  // چند تکهٔ ۱۰ خطی می‌آید تا بدون بازکردن لاگ دیده شود.
  for (let k = 0; k < all.length && k < 100; k += 10) {
    const esc = all.slice(k, k + 10).join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=probe part ${k / 10 + 1}::${esc}`);
  }
  totals.sort((a, b) => a - b);
  const med = totals.length ? totals[Math.floor(totals.length / 2)] : null;
  console.log(`SUMMARY chat-done=${ok}/${n} median_total=${med}ms max_total=${totals.length ? totals[totals.length - 1] : null}ms`);
})();
