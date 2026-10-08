// ارزیابی کیفیت گفتگوی هوشمند (بازیابی + پاسخ /chat) روی مجموعهٔ scripts/eval-questions.json
//
// دو بخش دارد:
//  ۱) بازیابی: برای هر پرسش بردار را از /embed زنده می‌گیرد (یا از فایل نتیجهٔ
//     قبلی با --vectors)، با همان cosine کلاینت بر embeddings.json می‌سنجد و
//     می‌گوید آیا تکهٔ درست در تکه‌های انتخاب‌شدهٔ هر «واریانت» هست
//     (k5، k6، k8، k5n1 = ۵ تکه + همسایه‌های تکهٔ اول، ...).
//  ۲) پاسخ: برای واریانت انتخاب‌شده، /chat زنده را با debug:true صدا می‌زند و
//     پاسخ کامل، مآخذ، مدل، زمان و توکن مصرفی را ذخیره می‌کند.
//
// اجرا (در GitHub Actions، چون شبکهٔ محیط توسعه api.sroohbakhsh.ir را می‌بندد):
//   node scripts/eval-chat.js --label baseline --chat in,off,adjacent,follow --variant k5
// فقط بازیابی روی بردارهای ذخیره‌شده (بدون شبکه):
//   node scripts/eval-chat.js --label re --vectors eval-results/baseline.json --chat none
//
// خروجی: eval-results/<label>.json (پاسخ‌های کامل و بردارها) و خلاصهٔ چاپ‌شده.
// هیچ کلید یا secretی در خروجی نیست.
const fs = require("fs");
const path = require("path");

// ---------- آرگومان‌ها ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
}
const LABEL = args.label || "run";
const BASE = args.base || "https://api.sroohbakhsh.ir";
const CHAT_SET = new Set(String(args.chat === undefined ? "in,off,adjacent,follow" : args.chat).split(",").filter((s) => s && s !== "none"));
const CHAT_VARIANT = args.variant || "k5";
const RETRIEVAL_VARIANTS = String(args.variants || "k5,k6,k8,k5n1,k5n2,k8n1").split(",");
const QUESTIONS_FILE = args.questions || "scripts/eval-questions.json";
const PAUSE_MS = Number(args.pause || 6000);
// خطاهای موقتیِ Gemini (سهمیه/شلوغی/تایم‌اوت) باعث می‌شود کیفیت پاسخ اندازه‌گیری نشود؛ پس
// هر پرسش تا RETRY بار دوباره امتحان می‌شود و تعداد تلاش جدا گزارش می‌شود.
const RETRY = Number(args.retry === undefined ? 2 : args.retry);
const RETRY_WAIT_MS = Number(args.retryWait || 20000);
const TRANSIENT_CODES = new Set(["busy", "quota", "timeout", "network", "stream_interrupted"]);
const ORIGIN = args.origin || "https://sroohbakhsh.ir";
// پرسش‌هایی که فقط به‌خاطر انتخاب زیرمجموعه اجرا شوند (جداشده با کاما)
const ONLY_IDS = args.ids ? new Set(String(args.ids).split(",")) : null;

// ---------- همان منطق کلاینت (از خود search-widget.js خوانده می‌شود تا جدا نشود) ----------
const widgetSrc = fs.readFileSync("search-widget.js", "utf8");
const FOLLOW_UP_MARKERS = new Function("return " + widgetSrc.match(/const FOLLOW_UP_MARKERS_AI = (\/.*\/);/)[1])();
const answerIndicatesNotFound = new Function(widgetSrc.match(/function answerIndicatesNotFoundAi\([\s\S]*?\n}\n/)[0] + "; return answerIndicatesNotFoundAi;")();
function buildFollowUpSearchQuery(question, history) {
  if (!Array.isArray(history) || history.length === 0) return question;
  if (question.length > 60 || !FOLLOW_UP_MARKERS.test(question)) return question;
  const previous = history[history.length - 1].question;
  if (!previous) return question;
  return `${previous.slice(0, 300)}\n${question}`;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const toB64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
const fromB64 = (s) => { const u = new Uint8Array(Buffer.from(s, "base64")); return new Float32Array(u.buffer); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "-");
const r3 = (x) => (x === null || x === undefined ? "-" : Number(x).toFixed(3));
const fold = (s) => String(s || "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ");

// ---------- داده‌ها ----------
const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8")).questions.filter((q) => !ONLY_IDS || ONLY_IDS.has(q.id));
const raw = JSON.parse(fs.readFileSync("embeddings.json", "utf8"));
const EMB = raw.map((it) => ({ book: it.book, source: it.source, text: it.text, vector: fromB64(it.vector) }));

// واریانت بازیابی: k{K} = K تکهٔ نزدیک؛ n{M} = همسایهٔ قبل و بعدِ M تکهٔ اول (هم‌منبع) کنار هر کدام.
function selectContext(scored, variant) {
  const m = variant.match(/^k(\d+)(?:n(\d+))?$/);
  if (!m) throw new Error("واریانت نامعتبر: " + variant);
  const K = Number(m[1]);
  const M = Number(m[2] || 0);
  const top = scored.slice(0, K);
  const out = [];
  const seen = new Set();
  const push = (idx, via) => {
    if (idx < 0 || idx >= EMB.length || seen.has(idx)) return;
    seen.add(idx);
    out.push({ idx, via });
  };
  top.forEach((t, rank) => {
    if (rank < M) {
      const prev = t.idx - 1, next = t.idx + 1;
      if (prev >= 0 && EMB[prev].source === EMB[t.idx].source) push(prev, "nb");
      push(t.idx, "hit");
      if (next < EMB.length && EMB[next].source === EMB[t.idx].source) push(next, "nb");
    } else {
      push(t.idx, "hit");
    }
  });
  return out;
}

const matchesExpect = (text, expect) => (expect || []).some((s) => text.includes(s));

// ---------- گرفتن بردار پرسش ----------
async function embedQuery(text) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(BASE + "/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ query: text }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) { await sleep(Math.min(Number(res.headers.get("retry-after") || 5), 20) * 1000); continue; }
    if (!res.ok) throw new Error("embed http " + res.status);
    return new Float32Array((await res.json()).vector);
  }
  throw new Error("embed rate-limited");
}

// ---------- یک تماس /chat ----------
async function callChat(body) {
  const t0 = Date.now();
  const out = { http: 0, answer: "", refs: undefined, error: null, code: null, ttfb: null, firstDelta: null, total: null, attempts: null, usage: null, model: null, rawDebug: [] };
  try {
    const res = await fetch(BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    out.http = res.status;
    const handle = (line) => {
      if (!line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === "debug") {
        out.rawDebug.push(o);
        if (o.attempts) out.attempts = o.attempts;
        if (o.usage) out.usage = o.usage;
        if (o.model) out.model = o.model;
      } else if (o.type === "delta") {
        if (out.firstDelta === null) out.firstDelta = Date.now() - t0;
        out.answer += o.text || "";
      } else if (o.type === "done") out.refs = o.references;
      else if (o.type === "error") { out.error = o.message || "error"; out.code = o.code || null; }
      else if (o.error) out.error = o.error;
    };
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
  } catch (e) {
    out.error = "exception: " + String(e).slice(0, 120);
  }
  out.total = Date.now() - t0;
  if (!out.model && out.attempts) { const ok = out.attempts.find((a) => a.status === 200); if (ok) out.model = ok.model; }
  return out;
}

(async () => {
  const result = { label: LABEL, startedAt: new Date().toISOString(), base: BASE, chatVariant: CHAT_VARIANT, vectors: {}, retrieval: {}, chat: {} };

  // ۱) بردارها
  let cached = {};
  if (args.vectors) {
    const prev = JSON.parse(fs.readFileSync(args.vectors, "utf8"));
    cached = prev.vectors || {};
  }
  for (const q of questions) {
    const searchText = buildFollowUpSearchQuery(q.question, q.history || []);
    q._searchText = searchText;
    const key = q.id;
    if (cached[key] && (args.loose || cached[key].text === searchText)) {
      result.vectors[key] = cached[key];
    } else if (args.offline) {
      throw new Error("بردار ذخیره‌شده برای " + key + " نیست یا متن جست‌وجو فرق دارد");
    } else {
      const v = await embedQuery(searchText);
      result.vectors[key] = { text: searchText, b64: toB64(v) };
      await sleep(300);
    }
  }

  // ۲) بازیابی برای همهٔ واریانت‌ها
  const lines = [];
  const scoredByQ = {};
  for (const q of questions) {
    const qv = fromB64(result.vectors[q.id].b64);
    const scored = EMB.map((it, idx) => ({ idx, score: cosine(qv, it.vector) }));
    scored.sort((a, b) => b.score - a.score);
    scoredByQ[q.id] = scored;
    // رتبهٔ اولین تکهٔ درست در ۵۰ تکهٔ برتر
    let rank = null;
    if (q.expect) for (let i = 0; i < 50; i++) if (matchesExpect(EMB[scored[i].idx].text, q.expect)) { rank = i + 1; break; }
    result.retrieval[q.id] = {
      category: q.category,
      top1: scored[0].score,
      top5mean: mean(scored.slice(0, 5).map((s) => s.score)),
      gap12: scored[0].score - scored[1].score,
      rank,
      top1book: EMB[scored[0].idx].book.slice(0, 20),
      variants: {},
    };
    for (const v of RETRIEVAL_VARIANTS) {
      const ctx = selectContext(scored, v);
      const hit = q.expect ? ctx.some((c) => matchesExpect(EMB[c.idx].text, q.expect)) : null;
      const chars = ctx.reduce((s, c) => s + EMB[c.idx].text.length, 0);
      result.retrieval[q.id].variants[v] = { hit, n: ctx.length, chars };
    }
  }

  // خلاصهٔ بازیابی
  const withExpect = questions.filter((q) => q.expect);
  lines.push(`== RETRIEVAL (${withExpect.length} پرسش آرشیوی/پیگیری) ==`);
  for (const v of RETRIEVAL_VARIANTS) {
    const hits = withExpect.filter((q) => result.retrieval[q.id].variants[v].hit).length;
    const ns = withExpect.map((q) => result.retrieval[q.id].variants[v].n);
    const cs = withExpect.map((q) => result.retrieval[q.id].variants[v].chars);
    lines.push(`variant=${v} hit=${hits}/${withExpect.length} (${pct(hits, withExpect.length)}) chunks_avg=${mean(ns).toFixed(1)} chars_avg=${Math.round(mean(cs))}`);
  }
  const rankMiss = withExpect.filter((q) => result.retrieval[q.id].rank === null).length;
  lines.push(`rank_of_first_correct: median=${median(withExpect.map((q) => result.retrieval[q.id].rank).filter((x) => x !== null))} not_in_top50=${rankMiss}`);
  lines.push("== SCORES (top1 / top5mean / gap12 / rank) ==");
  for (const q of questions) {
    const r = result.retrieval[q.id];
    lines.push(`${q.category.padEnd(8)} ${q.id.padEnd(20)} top1=${r3(r.top1)} top5mean=${r3(r.top5mean)} gap=${r3(r.gap12)} rank=${r.rank ?? "-"} k5hit=${r.variants.k5 ? r.variants.k5.hit : "-"} top1book=${r.top1book}`);
  }

  // ۳) پاسخ‌های /chat
  if (CHAT_SET.size > 0) {
    lines.push(`== CHAT (variant=${CHAT_VARIANT}) ==`);
    for (const q of questions) {
      if (!CHAT_SET.has(q.category)) continue;
      const scored = scoredByQ[q.id];
      const ctx = selectContext(scored, CHAT_VARIANT);
      const body = {
        question: q.question,
        context: ctx.map((c) => EMB[c.idx].text),
        history: q.history || [],
        mode: "grounded",
        debug: true,
        // --nogate: topScore نفرستد تا رفتار «قبل از گیت آستانه» روی همان Worker زنده اندازه‌گیری شود.
        topScore: args.nogate ? undefined : scored[0].score,
        topScores: scored.slice(0, 5).map((s) => Number(s.score.toFixed(4))),
      };
      let r = await callChat(body);
      let tries = 1;
      const firstError = r.error ? r.code || "error" : null;
      while (r.error && tries <= RETRY && (!r.code || TRANSIENT_CODES.has(r.code))) {
        await sleep(RETRY_WAIT_MS);
        r = await callChat(body);
        tries++;
      }
      const ans = fold(r.answer);
      const notFound = answerIndicatesNotFound(r.answer);
      const kwGroups = q.keywords || [];
      const kwMatched = kwGroups.filter((g) => new RegExp(g).test(ans)).length;
      const refsList = Array.isArray(r.refs) ? r.refs : null;
      const refsCorrect = q.expect && refsList ? refsList.some((n) => ctx[n - 1] && matchesExpect(EMB[ctx[n - 1].idx].text, q.expect)) : null;
      const rec = {
        category: q.category,
        tries, firstError,
        http: r.http, error: r.error, answer: r.answer, refs: r.refs === undefined ? "no-done" : r.refs,
        notFound, leak: /REFERENCES/i.test(r.answer), len: r.answer.length,
        kw: kwGroups.length ? `${kwMatched}/${kwGroups.length}` : null,
        kwOk: kwGroups.length ? kwMatched >= Math.ceil(kwGroups.length / 2) : null,
        refsCorrect,
        ctxHit: q.expect ? ctx.some((c) => matchesExpect(EMB[c.idx].text, q.expect)) : null,
        ttfb: r.ttfb, firstDelta: r.firstDelta, total: r.total, model: r.model, usage: r.usage,
        attempts: r.attempts,
        gated: r.rawDebug.some((d) => d.gate === "below_threshold"),
      };
      result.chat[q.id] = rec;
      const att = (r.attempts || []).map((a) => `${a.model.replace("gemini-", "")}=${a.status}`).join(">");
      lines.push(
        `${q.category.padEnd(8)} ${q.id.padEnd(20)} http=${r.http} ${r.error ? "ERR[" + r.error.slice(0, 60) + "]" : "ok"} len=${rec.len} notFound=${notFound} refs=${JSON.stringify(rec.refs)} refsOk=${refsCorrect} kw=${rec.kw ?? "-"} leak=${rec.leak} ` +
          `gated=${rec.gated} tries=${tries} t=${r.total}ms first=${r.firstDelta ?? "-"}ms tok(in/out/think)=${r.usage ? `${r.usage.prompt}/${r.usage.output}/${r.usage.thoughts ?? 0}` : "-"} ${att}`
      );
      await sleep(PAUSE_MS);
    }

    // خلاصهٔ پاسخ‌ها
    const recs = Object.entries(result.chat);
    const grp = (cats) => recs.filter(([, r]) => cats.includes(r.category)).map(([id, r]) => ({ id, ...r }));
    const pos = grp(["in", "follow"]);
    const neg = grp(["off", "adjacent"]);
    lines.push("== CHAT SUMMARY ==");
    if (pos.length) {
      const answered = pos.filter((r) => !r.error && !r.notFound && r.len > 40);
      lines.push(
        `positives n=${pos.length}: answered=${pos.filter((r) => !r.error && !r.notFound).length} (${pct(pos.filter((r) => !r.error && !r.notFound).length, pos.length)}) ` +
          `kwOk=${pos.filter((r) => r.kwOk).length} (${pct(pos.filter((r) => r.kwOk).length, pos.length)}) ` +
          `ctxHit=${pos.filter((r) => r.ctxHit).length} refsCorrect=${pos.filter((r) => r.refsCorrect).length} leaks=${pos.filter((r) => r.leak).length} errors=${pos.filter((r) => r.error).length} first_try_failures=${pos.filter((r) => r.firstError).length} ` +
          `median_t=${median(pos.map((r) => r.total))}ms tokens_in_avg=${Math.round(mean(pos.filter((r) => r.usage).map((r) => r.usage.prompt)) || 0)} out_avg=${Math.round(mean(pos.filter((r) => r.usage).map((r) => r.usage.output)) || 0)}`
      );
      void answered;
    }
    if (neg.length) {
      lines.push(
        `negatives n=${neg.length}: correct_notFound=${neg.filter((r) => !r.error && r.notFound).length} (${pct(neg.filter((r) => !r.error && r.notFound).length, neg.length)}) ` +
          `answered_anyway=${neg.filter((r) => !r.error && !r.notFound).length} leaks=${neg.filter((r) => r.leak).length} errors=${neg.filter((r) => r.error).length} first_try_failures=${neg.filter((r) => r.firstError).length} ` +
          `median_t=${median(neg.map((r) => r.total))}ms tokens_in_avg=${Math.round(mean(neg.filter((r) => r.usage).map((r) => r.usage.prompt)) || 0)}`
      );
    }
  }

  result.summaryLines = lines;
  fs.mkdirSync("eval-results", { recursive: true });
  fs.writeFileSync(path.join("eval-results", LABEL + ".json"), JSON.stringify(result));
  console.log(lines.join("\n"));
  // GitHub فقط ۱۰ annotation برای هر step نگه می‌دارد؛ خلاصه را در تکه‌های ۱۰ خطی می‌فرستیم.
  for (let k = 0; k < lines.length && k < 100; k += 10) {
    const esc = lines.slice(k, k + 10).join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=eval ${LABEL} part ${k / 10 + 1}::${esc}`);
  }
})().catch((e) => { console.error(e); console.log("::error title=eval failed::" + String(e && e.stack || e).slice(0, 500).replace(/%/g, "%25").replace(/\n/g, "%0A")); process.exit(1); });
