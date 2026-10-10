// تست قانون Rate Limiting کلودفلر روی POST /chat (workflow: rl-test.yml).
// بدنهٔ نامعتبر (بدون question) می‌فرستد تا Worker ۴۰۰ بدهد و سهمیهٔ Gemini
// خرج نشود. هر پاسخ را با وضعیت، نوع محتوا، هدر server/cf-ray و ابتدای
// بدنه ثبت می‌کند تا «۴۲۹ Worker» از «مسدودی کلودفلر» جدا شود.
// فقط وضعیت و هدرهای عمومی چاپ می‌شود؛ هیچ کلید و secretی در کار نیست.
const BASE = process.env.RL_BASE || "https://api.sroohbakhsh.ir";
const N = Number(process.env.RL_N || 30);
const WAIT_MS = Number(process.env.RL_WAIT || 15000);

async function hit() {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://sroohbakhsh.ir" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    const text = (await res.text()).replace(/\s+/g, " ").slice(0, 90);
    return {
      status: res.status,
      ct: (res.headers.get("content-type") || "").split(";")[0],
      server: res.headers.get("server") || "-",
      cfray: res.headers.has("cf-ray") ? "cf-ray" : "no-cf-ray",
      retry: res.headers.get("retry-after") || "-",
      body: text,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { status: 0, ct: "-", server: "-", cfray: "-", retry: "-", body: "EXC " + String(e).slice(0, 60), ms: Date.now() - t0 };
  }
}

// دسته‌بندی: ۴۰۰ JSON = پاسخ عادی Worker؛ ۴۲۹ با JSON فارسی = محدودیت درون‌حافظهٔ Worker؛
// بقیه (۴۲۹/۴۰۳/HTML/متن) = کلودفلر.
function kind(r) {
  if (r.status === 400 && /json/.test(r.ct)) return "worker-400";
  if (r.status === 429 && /json/.test(r.ct) && /[؀-ۿ]/.test(r.body)) return "worker-429-memory";
  if (r.status === 0) return "network-error";
  return "cloudflare-or-other";
}

(async () => {
  const lines = [];
  const rows = [];
  const t0 = Date.now();
  for (let i = 1; i <= N; i++) rows.push({ i, ...(await hit()) });
  const span = Date.now() - t0;
  const count = {};
  rows.forEach((r) => { const k = `${kind(r)}(${r.status})`; count[k] = (count[k] || 0) + 1; });
  lines.push(`BURST n=${N} total_time=${span}ms`);
  lines.push("COUNTS " + JSON.stringify(count));
  const firstBlock = rows.find((r) => r.status !== 400);
  lines.push("FIRST_NON_400 " + (firstBlock ? `#${firstBlock.i} status=${firstBlock.status} kind=${kind(firstBlock)}` : "none"));
  rows.forEach((r) => lines.push(`#${String(r.i).padStart(2, "0")} ${r.status} ${kind(r)} ct=${r.ct} server=${r.server} ${r.cfray} retry=${r.retry} ${r.ms}ms | ${r.body}`));
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const after = await hit();
  lines.push(`AFTER_WAIT ${WAIT_MS}ms: status=${after.status} kind=${kind(after)} ct=${after.ct} | ${after.body}`);
  console.log(lines.join("\n"));
  for (let k = 0; k < lines.length; k += 10) {
    const esc = lines.slice(k, k + 10).join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::notice title=rl-test part ${k / 10 + 1}::${esc}`);
  }
})();
