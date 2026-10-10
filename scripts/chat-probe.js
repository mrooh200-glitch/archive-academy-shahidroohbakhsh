// تست سلامت /chat روی Worker زنده: چند درخواست پشت‌سرهم می‌فرستد و برای
// هر کدام زمان اولین بایت، زمان کل، نتیجه (done/error) و ردِ debug را
// گزارش می‌کند. در GitHub Actions اجرا می‌شود (workflow: chat-probe.yml).
// خروجی فقط شامل وضعیت و زمان است؛ هیچ کلید یا secretی در آن نیست.
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync(process.argv[2] || ".github/chat-probe/probe.json", "utf8"));
const BASE = cfg.baseUrl || "https://api.sroohbakhsh.ir";

async function one(body) {
  const t0 = Date.now();
  const out = { http: 0, ttfb: null, total: null, result: "?", chars: 0, attempts: null, msg: "" };
  try {
    const res = await fetch(BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    out.http = res.status;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
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
    };
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
    out.firstDelta = firstDelta;
  } catch (e) {
    out.result = "exception";
    out.msg = String(e).slice(0, 120);
  }
  out.total = Date.now() - t0;
  return out;
}

(async () => {
  const lines = [];
  let ok = 0, n = 0;
  const totals = [];
  for (const test of cfg.tests) {
    for (let i = 0; i < (test.repeat || 1); i++) {
      const r = await one(test.body);
      n++;
      if (r.result === "done" && r.chars > 0) { ok++; totals.push(r.total); }
      const att = r.attempts ? r.attempts.map((a) => `${a.model}#${a.attempt}=${a.status}${a.reason ? "/" + a.reason : ""}(${a.ms}ms)`).join(" > ") : "no-debug";
      lines.push(`${test.name}[${i + 1}] http=${r.http} ${r.result} chars=${r.chars}${r.refs !== undefined && r.refs !== null ? " refs=" + JSON.stringify(r.refs) : ""} firstDelta=${r.firstDelta}ms total=${r.total}ms | ${att}${r.msg ? " | " + r.msg : ""}`);
      if (test.pauseMs) await new Promise((res) => setTimeout(res, test.pauseMs));
    }
  }
  totals.sort((a, b) => a - b);
  const med = totals.length ? totals[Math.floor(totals.length / 2)] : null;
  lines.push(`SUMMARY ok=${ok}/${n} median_total=${med}ms max_total=${totals.length ? totals[totals.length - 1] : null}ms`);
  console.log(lines.join("\n"));
  // یک annotation تا نتیجه بدون بازکردن لاگ هم دیده شود.
  const esc = lines.join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::notice title=chat-probe::${esc}`);
})();
