/**
 * search-widget.js
 *
 * این فایل رو در سایتت (کنار فایل‌های htm) قرار بده و با یک تگ <script> در index.html
 * لینکش کن. دو قابلیت اضافه می‌کنه: جست‌وجوی معنایی و گفت‌وگو با آرشیو.
 *
 * قبل از استفاده، مقدار WORKER_URL رو زیر با آدرس واقعی Workerـت (بعد از deploy) عوض کن.
 * آدرس چیزی شبیه این می‌شه: https://roohbakhsh-archive-ai.YOUR-SUBDOMAIN.workers.dev
 */

// آدرس قبلی (roohbakhsh-archive-ai.mrooh200.workers.dev) از شبکهٔ فعلی اصلاً
// در دسترس نبود (حتی Worker قدیمیِ سایت میلانی هم با همین الگوی دامنه به
// همین مشکل می‌خورد) - به همین خاطر یک Custom Domain برای همین Worker ساخته شد.
// (۱۴۰۵/۰۷/۱۰ - ۲۰۲۶-۱۰-۰۲): از زیر ostadmilani.ir به api.sroohbakhsh.ir
// (دامنهٔ خودِ همین سایت) منتقل شد، چون دامنهٔ سایت حالا ساخته شده است.
const WORKER_URL = "https://api.sroohbakhsh.ir";

let EMBEDDINGS = null; // کل داده‌های embeddings.json بعد از بارگذاری اینجا نگه داشته می‌شه
let embeddingsLoadingPromise = null; // جلوگیری از دانلود همزمان/تکراری وقتی چند جست‌وجو هم‌پوشانی دارن

const DB_NAME = "roohbakhsh-ai-cache";
const STORE_NAME = "embeddings";
const CACHE_KEY = "embeddings-data";

// ---------- باز کردن (یا ساخت) پایگاه‌دادهٔ محلی مرورگر ----------
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedEmbeddings() {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // اگه IndexedDB در دسترس نبود، بی‌خیال کش می‌شیم، مشکلی نیست
  }
}

async function setCachedEmbeddings(record) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, CACHE_KEY);
  } catch {
    // ذخیره‌نشدن کش خطای مهمی نیست، جست‌وجو همچنان کار می‌کنه
  }
}

// ---------- تبدیل رشتهٔ base64 به بردار عددی (Float32Array) ----------
// چون build-embeddings.js بردارها رو فشرده (base64) ذخیره می‌کنه تا حجم فایل کم بشه،
// اینجا باید دوباره به آرایهٔ عددی قابل‌استفاده تبدیلشون کنیم.
function base64ToVector(b64) {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ---------- گرفتن نسخهٔ فعلی از فایل کوچک نسخه ----------
// به‌جای تکیه به هدرهای HTTP (etag/last-modified) که روی GitHub Pages همیشه
// قابل‌اعتماد نیستن، یک فایل کوچک جدا به اسم embeddings-version.json داریم که
// خودِ build-embeddings.js هر بار با هش واقعی محتوای جدید می‌سازه.
async function getRemoteVersion() {
  try {
    const res = await fetch("embeddings-version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return json.version || null;
  } catch {
    return null;
  }
}

// ---------- بارگذاری embeddings.json با کش محلی ----------
// اول فایل کوچک نسخه رو می‌خونیم. اگه با نسخهٔ ذخیره‌شده در مرورگر (IndexedDB)
// یکی بود، از همون کش استفاده می‌کنیم؛ دیگه نه دانلود کامل لازمه، نه
// دوباره‌کدگذاری بردارها. علاوه بر این، اگه چند جست‌وجو هم‌زمان (یا با هم‌پوشانی)
// این تابع رو صدا بزنن، همه به یک Promise در حال اجرا وصل می‌شن تا فایل
// حجیم embeddings.json به‌جای یک‌بار، چندبار موازی دانلود نشه.
async function loadEmbeddings() {
  if (EMBEDDINGS) return EMBEDDINGS;
  if (embeddingsLoadingPromise) return embeddingsLoadingPromise;

  embeddingsLoadingPromise = (async () => {
    const currentVersion = await getRemoteVersion();

    const cached = await getCachedEmbeddings();
    if (cached && currentVersion && cached.version === currentVersion) {
      EMBEDDINGS = cached.data; // از کش استفاده کن، نیازی به دانلود نیست
      return EMBEDDINGS;
    }

    // شماره‌نسخه رو به‌عنوان query string به آدرس اضافه می‌کنیم تا وقتی محتوا عوض
    // می‌شه، آدرس درخواست هم عوض بشه — این‌جوری نه کش مرورگر، نه کش سرویس‌دهندهٔ
    // GitHub Pages (که با هدر cache به‌تنهایی کنترل نمی‌شه) نمی‌تونه جواب قدیمی
    // برگردونه، چون از نظر فنی این یه URL کاملاً متفاوته. اگه گرفتن نسخه شکست
    // خورده باشه (currentVersion خالیه)، مثل قبل بدون query string درخواست می‌دیم.
    const embeddingsUrl = currentVersion
      ? `embeddings.json?v=${encodeURIComponent(currentVersion)}`
      : "embeddings.json";
    // فایل حدود ۲۵ مگابایتی روی اینترنت ضعیف گاهی وسط راه قطع می‌شود؛ تا
    // ۳ بار با وقفه تلاش می‌کنیم و در نهایت به‌جای خطای خام «Failed to
    // fetch» پیام روشن فارسی می‌دهیم.
    let raw = null;
    for (let attempt = 1; attempt <= 3 && !raw; attempt++) {
      try {
        const res = await fetch(embeddingsUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
      } catch (err) {
        if (attempt === 3) {
          throw new Error("بارگذاری پایگاه جست‌وجو کامل نشد (اتصال ضعیف یا قطع است). لطفاً دوباره تلاش کنید.");
        }
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    const decoded = raw.map((item) => ({ ...item, vector: base64ToVector(item.vector) }));

    EMBEDDINGS = decoded;

    if (currentVersion) {
      setCachedEmbeddings({ version: currentVersion, data: decoded }); // برای دفعات بعد ذخیره کن
    }

    return EMBEDDINGS;
  })();

  try {
    return await embeddingsLoadingPromise;
  } finally {
    embeddingsLoadingPromise = null; // اگه خطا داد، دفعهٔ بعد اجازهٔ تلاش دوباره بده
  }
}

// ---------- محاسبهٔ شباهت کسینوسی بین دو بردار ----------
function cosineSimilarity(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- جست‌وجوی معنایی ----------
// query: متن جست‌وجوی کاربر
// topK: چند نتیجهٔ برتر برگردونده بشه
// bookFilter: (اختیاری) Set از اسم کتاب‌هایی که جست‌وجو باید فقط
// محدود به اون‌ها باشه - برای «محدودهٔ جست‌وجو» (بند ب). اگه خالی یا
// undefined باشه، مثل قبل رو کل آرشیو جست‌وجو می‌کنه.
async function embedQuery(query) {
  // گرفتن بردار عبارت جست‌وجو از Worker
  const embedRes = await fetch(`${WORKER_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!embedRes.ok) {
    // اگه Worker یه پیام فارسی مشخص برگردونده (مثلاً سهمیهٔ روزانه تموم شده
    // یا سرویس موقتاً شلوغه)، همون رو نشون بده؛ وگرنه پیام عمومی.
    let message = "خطا در دریافت بردار جست‌وجو";
    try {
      const errBody = await embedRes.json();
      if (errBody && errBody.error) message = errBody.error;
    } catch {
      // بدنهٔ خطا JSON نبود، از پیام پیش‌فرض استفاده کن
    }
    throw new Error(message);
  }
  const { vector } = await embedRes.json();
  return vector;
}

// امتیاز cosine همهٔ تکه‌های داخل محدوده (برای چند نسخهٔ پرسش: بیشینهٔ cosine)، مرتب از بیشترین؛ هر ردیف
// {index: جای تکه در EMBEDDINGS، score}.
async function scoreAllChunks(queries, bookFilter = null) {
  const list = Array.isArray(queries) ? queries : [queries];
  const data = await loadEmbeddings();
  // بردار پرسش اصلی باید موفق شود؛ بردار نسخه‌های بازنویسی‌شده اختیاری است.
  const [mainVector, ...extraVectors] = await Promise.all(
    list.map((q, i) => (i === 0 ? embedQuery(q) : embedQuery(q).catch(() => null)))
  );
  const vectors = [mainVector, ...extraVectors.filter(Boolean)];
  const scored = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (bookFilter && bookFilter.size > 0 && !bookFilter.has(item.book)) continue;
    let best = -1;
    for (const v of vectors) {
      const c = cosineSimilarity(v, item.vector);
      if (c > best) best = c;
    }
    scored.push({ index: i, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function semanticSearch(query, topK = 5, bookFilter = null) {
  const data = await loadEmbeddings();
  const scored = await scoreAllChunks(query, bookFilter);
  return scored.slice(0, topK).map((row) => ({ ...data[row.index], score: row.score }));
}

// ---------- بازیابی برای گفتگو: ۴۰ نامزد ← reranker ← ۸ تکه ----------
// ارزیابی (scripts/eval-chat.js روی eval-questions.json): با ۵ تکه، تکهٔ درست
// در ۲۷ از ۳۳ پرسش آرشیوی به چت می‌رسید و با ۸ تکه در ۲۹ از ۳۳؛ چند پاسخ
// درست در رتبهٔ ۸ تا ۴۰ بود. پس نامزدها را وسیع می‌گیریم و /rerank (Worker)
// سؤال و هر نامزد را با هم می‌خواند و ۸ تای مرتبط‌تر را برمی‌گرداند. اگر
// reranker خطا داد، دیر کرد یا جواب نامعتبر داد، بی‌صدا ۸ تکهٔ اول cosine
// استفاده می‌شود؛ گفتگو هیچ‌وقت به‌خاطر این مرحله قطع نمی‌شود.
const CHAT_CONTEXT_CHUNKS = 8;
const RERANK_CANDIDATES = 40;
// هم‌تراز MIN_TOP_SCORE در worker/src/index.js؛ زیر آن Worker بدون Gemini «یافت نشد» می‌دهد.
const CHAT_RERANK_MIN_TOP_SCORE = 0.5;
const RERANK_CLIENT_TIMEOUT_MS = 10000;

async function rerankCandidatesAi(query, candidates) {
  try {
    const res = await fetch(`${WORKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, candidates: candidates.map((c) => c.text) }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(RERANK_CLIENT_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.order)) return null;
    const ordered = [];
    const seen = new Set();
    for (const row of data.order) {
      const c = row && Number.isInteger(row.id) ? candidates[row.id] : null;
      if (c && !seen.has(row.id)) {
        seen.add(row.id);
        ordered.push(c);
      }
    }
    return ordered.length > 0 ? ordered : null;
  } catch {
    return null;
  }
}

// خروجی: { relevant: تکه‌های نهایی برای چت، topScore: بالاترین cosine (برای گیت آستانه) }
async function retrieveForChatAi(query, bookFilter) {
  const candidates = await semanticSearch(query, RERANK_CANDIDATES, bookFilter);
  const topScore = candidates.length > 0 ? candidates[0].score : undefined;
  const fallback = candidates.slice(0, CHAT_CONTEXT_CHUNKS);
  // زیر آستانهٔ Worker (یا وقتی نامزد کم است) rerank بی‌فایده و فقط مصرف سهمیه است.
  if (candidates.length <= CHAT_CONTEXT_CHUNKS || topScore < CHAT_RERANK_MIN_TOP_SCORE) {
    return { relevant: fallback, topScore };
  }
  const reranked = await rerankCandidatesAi(query, candidates);
  return { relevant: reranked ? reranked.slice(0, CHAT_CONTEXT_CHUNKS) : fallback, topScore };
}

// ---------- ساخت لینک به همان قطعهٔ متنی داخل صفحه (Text Fragment مرورگر) ----------
// این یه ویژگی استاندارد مرورگرهاست: با اضافه‌کردن #:~:text=... به انتهای لینک،

// ---------- جست‌وجوی کلیدواژه‌ای (BM25) برای جست‌وجوی ترکیبی ----------
// جست‌وجوی برداری معنا را می‌گیرد ولی نام‌ها و عبارت‌های دقیق (مثلاً «شقشقیه»)
// را ممکن است گم کند. BM25 روی همان تکه‌های embeddings.json در مرورگر ساخته
// می‌شود (بدون Worker و بدون بازسازی embeddings) و با RRF با نتیجهٔ برداری
// ادغام می‌شود.
const KEYWORD_STOPWORDS = new Set(
  ("و در به از که این آن را با برای است بود شد شده می های ها هم یا تا بر هر نیز اما اگر چه چرا " +
   "چون پس همه کرد کنید کند کرده باشد باشند است‌ هست نیست یک دو بین بعد قبل خود ای " +
   "من تو او ما شما ایشان آنها ان ای الی علی فی من عن ما لا هذا هذه ذلک الذی التی و")
    .split(/\s+/)
);

function keywordNormalize(text) {
  return String(text || "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // اعراب و کشیده
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200c/g, " ")
    .toLowerCase();
}

function keywordTokens(text) {
  const out = [];
  for (const t of keywordNormalize(text).split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 2 && !KEYWORD_STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

let keywordIndex = null; // {source: EMBEDDINGS، docs: [Map(term→tf)], len: [..], df: Map, avgLen}

function getKeywordIndex(data) {
  if (keywordIndex && keywordIndex.source === data) return keywordIndex;
  const docs = new Array(data.length);
  const len = new Array(data.length);
  const df = new Map();
  let total = 0;
  for (let i = 0; i < data.length; i++) {
    const tf = new Map();
    const tokens = keywordTokens(data[i].text);
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs[i] = tf;
    len[i] = tokens.length;
    total += tokens.length;
  }
  keywordIndex = { source: data, docs, len, df, avgLen: total / Math.max(1, data.length) || 1 };
  return keywordIndex;
}

// خروجی: { hits: [{index, bm25, coverage}] مرتب، terms: تعداد واژه‌های یکتای پرسش }
function keywordSearch(data, query, bookFilter, limit) {
  const idx = getKeywordIndex(data);
  const terms = [...new Set(keywordTokens(query))];
  if (terms.length === 0) return { hits: [], terms: 0 };
  const N = data.length;
  const K1 = 1.5;
  const B = 0.75;
  const idf = terms.map((t) => {
    const n = idx.df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  });
  const idfSum = idf.reduce((a, b) => a + b, 0);
  const hits = [];
  for (let i = 0; i < N; i++) {
    if (bookFilter && bookFilter.size > 0 && !bookFilter.has(data[i].book)) continue;
    const tf = idx.docs[i];
    let score = 0;
    let matchedIdf = 0;
    for (let k = 0; k < terms.length; k++) {
      const f = tf.get(terms[k]);
      if (!f) continue;
      matchedIdf += idf[k];
      score += idf[k] * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * idx.len[i]) / idx.avgLen)));
    }
    // پوشش وزن‌دار با idf: واژهٔ کمیاب (یا ناموجود در آرشیو) بیشتر از واژهٔ رایج وزن دارد.
    if (matchedIdf > 0) hits.push({ index: i, bm25: score, coverage: matchedIdf / idfSum });
  }
  hits.sort((a, b) => b.bm25 - a.bm25);
  return { hits: hits.slice(0, limit), terms: terms.length };
}

// ---------- بازیابی برای تب جست‌وجوی مفهومی: ترکیبی + آستانه + reranker ----------
// ۱) ۴۰ نامزد برداری (cosine) و ۴۰ نامزد کلیدواژه‌ای (BM25) با RRF ادغام می‌شوند.
// ۲) آستانه: اگر نه بالاترین cosine به حد آستانه می‌رسد و نه تکه‌ای با پوشش
//    دست‌کم ۷۵٪ (وزن‌دار با idf) واژه‌های پرسش پیدا شده، نتیجه‌ای نشان داده نمی‌شود.
// ۳) reranker نامزدهای ادغام‌شده را مرتب می‌کند؛ اگر خطا داد، ترتیب RRF می‌ماند.
const RRF_K = 60;
const KEYWORD_STRONG_COVERAGE = 0.75;

async function semanticSearchPrecise(query, topK = 5, bookFilter = null, extraQueries = []) {
  const data = await loadEmbeddings();
  const queries = [query, ...extraQueries];
  const scored = await scoreAllChunks(queries, bookFilter);
  if (scored.length === 0) return { results: [], belowThreshold: false };

  const vectorTop = scored.slice(0, RERANK_CANDIDATES);
  // کلیدواژه‌ای: برای هر نسخهٔ پرسش جدا جست‌وجو و نتیجه با بیشینهٔ امتیاز ادغام می‌شود.
  const keywordByIndex = new Map();
  for (const q of queries) {
    for (const h of keywordSearch(data, q, bookFilter, RERANK_CANDIDATES).hits) {
      const prev = keywordByIndex.get(h.index);
      if (!prev) keywordByIndex.set(h.index, { ...h });
      else {
        prev.bm25 = Math.max(prev.bm25, h.bm25);
        prev.coverage = Math.max(prev.coverage, h.coverage);
      }
    }
  }
  const keyword = { hits: [...keywordByIndex.values()].sort((a, b) => b.bm25 - a.bm25).slice(0, RERANK_CANDIDATES) };
  const keywordStrong = keyword.hits.some((h) => h.coverage >= KEYWORD_STRONG_COVERAGE);

  if (vectorTop[0].score < CHAT_RERANK_MIN_TOP_SCORE && !keywordStrong) {
    return { results: [], belowThreshold: true };
  }

  const cosineByIndex = new Map(scored.map((row) => [row.index, row.score]));
  const rrf = new Map();
  const addRanks = (rows) =>
    rows.forEach((row, rank) => rrf.set(row.index, (rrf.get(row.index) || 0) + 1 / (RRF_K + rank + 1)));
  addRanks(vectorTop);
  addRanks(keyword.hits);

  const merged = [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RERANK_CANDIDATES)
    .map(([index]) => ({ ...data[index], score: cosineByIndex.get(index) ?? 0 }));

  if (merged.length <= topK) return { results: merged, belowThreshold: false };
  const reranked = await rerankCandidatesAi(query, merged);
  return { results: (reranked || merged).slice(0, topK), belowThreshold: false };
}

// ---------- بازنویسی سؤال (Worker: /rewrite) ----------
// فقط برای پرسش‌های دست‌کم ۳ کلمه‌ای؛ خروجی: آرایه‌ای از نسخه‌های اضافه (فارسی
// روشن‌تر و عربی). هر خطا، تایم‌اوت یا پاسخ نامعتبر → [] و جست‌وجوی معمولی می‌ماند.
const REWRITE_MIN_WORDS = 3;
const REWRITE_CLIENT_TIMEOUT_MS = 4000;

async function rewriteQueryAi(query) {
  if (query.split(/\s+/).filter(Boolean).length < REWRITE_MIN_WORDS) return [];
  try {
    const res = await fetch(`${WORKER_URL}/rewrite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(REWRITE_CLIENT_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.queries)) return [];
    return data.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, 2);
  } catch {
    return [];
  }
}

// ---------- فیلتر کتاب‌ها بر اساس عنوان / نویسنده / موضوع (مشترک بین سه پنل 📚) ----------
// متادیتای هر کتاب از data-author و data-subject روی <li class="searchable-item">
// در index.htm می‌آید. field یکی از all|title|author|subject است.
function bookFilterNormalize(text) {
  return String(text || "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function bookMatchesFilter(meta, field, query) {
  const q = bookFilterNormalize(query);
  if (!q) return true;
  const fields = field === "all" || !field ? ["title", "author", "subject"] : [field];
  return fields.some((f) => bookFilterNormalize(meta[f]).includes(q));
}

// متادیتای کتاب‌ها بر اساس عنوان (کلید گروه‌بندی در embeddings.json = عنوان کتاب)
function getBookMetaByTitle() {
  const map = new Map();
  document.querySelectorAll(".searchable-item").forEach((li) => {
    const title = li.dataset.title || (li.querySelector("a") ? li.querySelector("a").textContent.trim() : "");
    if (title) map.set(title, { title, author: li.dataset.author || "", subject: li.dataset.subject || "" });
  });
  return map;
}

// یک ردیف «بر اساس [عنوان/نویسنده/موضوع] + کادر عبارت» قبل از فهرست کتاب‌ها می‌گذارد.
// applyFilter(field, query) باید true برگرداند اگر اعمال شد، false اگر هیچ کتابی منطبق نبود.
function attachBookFilter(listEl, applyFilter) {
  if (!listEl || listEl.parentNode.querySelector(":scope > .book-filter-row")) return;
  const row = document.createElement("div");
  row.className = "book-filter-row";
  row.innerHTML = `
    <select aria-label="فیلتر بر اساس">
      <option value="all">همه</option>
      <option value="title">عنوان</option>
      <option value="author">نویسنده</option>
      <option value="subject">موضوع</option>
    </select>
    <input type="search" placeholder="فیلتر کتاب‌ها…" aria-label="عبارت فیلتر کتاب‌ها">`;
  const empty = document.createElement("p");
  empty.className = "book-filter-empty";
  empty.textContent = "کتابی با این مشخصات یافت نشد.";
  empty.hidden = true;
  listEl.parentNode.insertBefore(row, listEl);
  listEl.parentNode.insertBefore(empty, listEl);

  const select = row.querySelector("select");
  const input = row.querySelector("input");
  const run = () => {
    const query = input.value.trim();
    empty.hidden = applyFilter(select.value, query) !== false;
  };
  input.addEventListener("input", run);
  select.addEventListener("change", run);
}

// ---------- دیده‌شدن کامل جعبهٔ انتخاب کتاب هنگام باز شدن ----------
// وقتی کادر جست‌وجو پایین صفحه است (مثلاً قبل از اولین جست‌وجو)، جعبه‌ای که
// زیرش باز می‌شود از پایین نمایشگر بریده می‌شود. این تابع صفحه را به‌اندازهٔ
// لازم پایین می‌برد (مثل وقتی که بنرهای بالای صفحه بعد از جست‌وجو بالا می‌روند)
// تا کل جعبه دیده شود. اگر خودِ صفحه آن‌قدر بلند نیست که اسکرول شود، یک فاصلهٔ
// موقت زیر صفحه اضافه می‌کند که با بسته‌شدن جعبه برداشته می‌شود.
function revealPanelInViewport(panelEl) {
  removeRevealSpacer();
  if (!panelEl) return;
  const MARGIN = 12;

  const pass = (behavior) => {
    if (!panelEl.isConnected) return;
    const over = panelEl.getBoundingClientRect().bottom - (window.innerHeight - MARGIN);
    if (over <= 1) return;

    // برای این‌که اسکرول به اندازهٔ لازم ممکن شود، باید «پایان محتوای واقعی
    // صفحه» (نه پایان body که ممکن است به‌خاطر min-height بزرگ‌تر از محتوا
    // باشد) به‌اندازهٔ کافی پایین‌تر برود. یک فاصلهٔ موقت در انتهای body
    // می‌گذاریم و ارتفاعش را از روی جای خودش (= پایان واقعی محتوا) حساب
    // می‌کنیم.
    const needEnd = window.scrollY + window.innerHeight + over;
    let spacer = document.getElementById("scopeRevealSpacer");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.id = "scopeRevealSpacer";
      spacer.setAttribute("aria-hidden", "true");
      spacer.style.cssText = "pointer-events:none;height:0px;";
      document.body.appendChild(spacer);
    }
    const contentEnd = spacer.getBoundingClientRect().top + window.scrollY;
    const curH = parseFloat(spacer.style.height) || 0;
    const neededH = Math.ceil(needEnd - contentEnd);
    if (neededH > curH) spacer.style.height = `${neededH}px`;
    window.scrollBy({ top: over, behavior });
  };

  pass("smooth");
  // بعد از پایان اسکرول نرم، یک بار دیگر (بدون انیمیشن) بررسی می‌کنیم تا
  // حاشیهٔ پایین جعبه هم تأمین شود.
  setTimeout(() => pass("auto"), 900);
}

function removeRevealSpacer() {
  const spacer = document.getElementById("scopeRevealSpacer");
  if (spacer) spacer.remove();
}

// آیتم ب: راه‌اندازی مشترک پنل «محدودهٔ جست‌وجو/گفتگو» - فهرست تیک‌خور
// کتاب‌ها رو از embeddings.json (بعد از بارگذاری، فقط یک‌بار) می‌سازه و
// یه Set از اسم کتاب‌های تیک‌خورده رو برمی‌گردونه؛ این Set همیشه به‌روزه
// (با تیک‌زدن/برداشتن هر کتاب، خودش تغییر می‌کنه) - خالی‌بودنش یعنی
// «بدون محدودیت، جست‌وجو تو کل آرشیو».
function setupScopeSelector(toggleId, panelId, listId, onToggle) {
  const selectedBooks = new Set();
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  const list = document.getElementById(listId);

  if (!toggle || !panel || !list) return selectedBooks;

  let populated = false;

  async function populateList() {
    if (populated) return;
    populated = true;
    list.innerHTML = `<p>در حال بارگذاری فهرست کتاب‌ها…</p>`;
    try {
      const data = await loadEmbeddings();
      const books = [...new Set(data.map((item) => item.book))].sort((a, b) => a.localeCompare(b, "fa"));

      // آیتم جدید: پیش‌فرض این باشه که همه‌ی کتاب‌ها تیک خورده‌ن - هم
      // تو ظاهر چک‌باکس‌ها، هم تو خودِ Set انتخاب‌شده (که از قبل خالی
      // بود و به‌طور ضمنی یعنی «همه»؛ الان صریح و قابل‌مشاهده‌ست).
      books.forEach((book) => selectedBooks.add(book));

      list.innerHTML = books
        .map(
          (book) => `
          <label>
            <input type="checkbox" class="ai-scope-checkbox" value="${book.replace(/"/g, "&quot;")}" checked>
            ${book}
          </label>
        `
        )
        .join("");

      list.querySelectorAll(".ai-scope-checkbox").forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            selectedBooks.add(checkbox.value);
          } else {
            selectedBooks.delete(checkbox.value);
          }
        });
      });

      // فیلتر عنوان/نویسنده/موضوع: فقط کتاب‌های منطبق در فهرست و در دامنه می‌مانند.
      const metaByTitle = getBookMetaByTitle();
      attachBookFilter(list, (field, query) => {
        const boxes = [...list.querySelectorAll(".ai-scope-checkbox")];
        const matched = boxes.filter((cb) =>
          !query || bookMatchesFilter(metaByTitle.get(cb.value) || { title: cb.value }, field, query)
        );
        if (matched.length === 0) return false;
        boxes.forEach((cb) => {
          const isMatch = matched.includes(cb);
          cb.closest("label").hidden = !isMatch;
          cb.checked = isMatch;
          if (isMatch) selectedBooks.add(cb.value);
          else selectedBooks.delete(cb.value);
        });
        return true;
      });
    } catch {
      list.innerHTML = `<p style="color:#b91c1c;">خطا در بارگذاری فهرست کتاب‌ها</p>`;
    }
  }

  toggle.addEventListener("click", async () => {
    const isOpen = panel.style.display !== "none";
    if (isOpen) {
      panel.style.display = "none";
      toggle.setAttribute("aria-expanded", "false");
      removeRevealSpacer();
      if (onToggle) onToggle(false);
      return;
    }
    await populateList();
    panel.style.display = "flex";
    toggle.setAttribute("aria-expanded", "true");
    revealPanelInViewport(panel);
    if (onToggle) onToggle(true);
  });

  document.addEventListener("click", (event) => {
    if (panel.style.display !== "none" && !panel.contains(event.target) && event.target !== toggle) {
      panel.style.display = "none";
      toggle.setAttribute("aria-expanded", "false");
      removeRevealSpacer();
      if (onToggle) onToggle(false);
    }
  });

  panel.querySelectorAll("[data-scope-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const checkAll = button.dataset.scopeAction === "all";
      list.querySelectorAll(".ai-scope-checkbox").forEach((checkbox) => {
        if (checkbox.closest("label").hidden) return; // کتاب‌های فیلترشده دست نمی‌خورند
        checkbox.checked = checkAll;
        if (checkAll) {
          selectedBooks.add(checkbox.value);
        } else {
          selectedBooks.delete(checkbox.value);
        }
      });
    });
  });

  return selectedBooks;
}
// مرورگر خودش صفحه رو تا اون متن اسکرول و هایلایتش می‌کنه — بدون نیاز به id یا
// هیچ تغییری تو فایل‌های htm کتاب‌ها. چون متن‌های تکه‌ها می‌تونن طولانی باشن،
// به‌جای کل متن، فقط چند کلمهٔ اول و چند کلمهٔ آخرش رو به‌عنوان «شروع» و «پایان»
// بازه‌ی هایلایت می‌فرستیم؛ مرورگر خودش بین این دو رو کامل هایلایت می‌کنه.
function textFragmentUrl(baseUrl, text, page) {
  // Item جدید (رفع باگ: نشانه‌ها به صفحهٔ اول کتاب می‌رفتن، نه بخش
  // انتخاب‌شده؛ و لینک منبع تو فایل‌های خروجی فعال نبود): baseUrl تا
  // این‌جا یه مسیر نسبی بود (مثل "Osoul....htm") - برای نمایش زندهٔ
  // نتیجه تو خودِ سایت کافی بود، ولی وقتی همین آدرس تو یه نشانه ذخیره
  // می‌شه یا تو یه فایل Word/PDF صادر می‌شه، دیگه بافتِ «تو کدوم صفحه‌
  // ایم» رو نداره - پس باید از همون‌جا مطلق (با دامنهٔ کامل) ساخته بشه.
  let absoluteBase;
  try {
    absoluteBase = new URL(baseUrl, location.href).href;
  } catch {
    absoluteBase = baseUrl;
  }

  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return absoluteBase;

  const startWords = words.slice(0, 6).join(" ");

  // Item جدید (رفع باگ: بازکردن نشانه/منبع، کل متن را رنگی می‌کرد):
  // این تابع قبلاً علاوه بر q/frag/occ (که هایلایت دقیق و تک‌موردیِ
  // خودِ سایت رو کنترل می‌کنن)، یک #:~:text=شروع,پایان هم به انتهای
  // لینک اضافه می‌کرد - ویژگیِ بومیِ خودِ مرورگر که برای متن‌های
  // بلند (بیش از ۱۲ کلمه)، *کل بازهٔ بین شروع و پایان* رو هایلایت
  // می‌کنه، نه فقط همون تکه‌ی مدنظر؛ این یعنی هرجا این بازه چند
  // پاراگراف رو در بر می‌گرفت، مرورگر همهٔ اون پاراگراف‌ها رو (با
  // رنگ بنفشِ پیش‌فرض خودش) رنگی می‌کرد - کاملاً مستقل از هایلایت
  // دقیق و زردرنگِ خودِ سایت. چون هایلایتِ خودِ سایت (بر پایهٔ q/frag/
  // occ) از قبل دقیق و کافیه، این بخشِ بومیِ مرورگر دیگه لازم نیست و
  // حذف شد.
  let urlWithParams;
  try {
    const urlObj = new URL(absoluteBase);
    urlObj.searchParams.set("q", startWords);
    urlObj.searchParams.set("frag", startWords);
    urlObj.searchParams.set("occ", "1");
    if (page) urlObj.searchParams.set("page", String(page));
    urlWithParams = urlObj.href;
  } catch {
    urlWithParams = absoluteBase;
  }

  return urlWithParams;
}

// ---------- گفت‌وگو (پرسش‌وپاسخ بر اساس متن‌های مرتبط) ----------
// Item جدید (گفتگوی ادامه‌دار): history آرایه‌ای از تبادل‌های قبلی همین
// نشست است ({question, answer})، نه شامل سؤال فعلی. این آرایه به Worker
// فرستاده می‌شود تا (بعد از این‌که سمت worker/src/index.js هم همین
// تاریخچه را به پرامپت Gemini اضافه کند) پاسخ بعدی واقعاً با در نظر
// گرفتن سؤال‌های قبلی همین گفتگو ساخته شود - نه این‌که هر پرسش، بی‌خبر
// از پرسش‌های قبلی، از صفر پاسخ داده شود.
// بهبود بازیابی برای سؤال‌های پیگیری: عبارتی مثل «همان را ساده‌تر بگو» یا
// «چرا؟» به‌تنهایی امبدینگ بی‌معنایی می‌دهد و تکه‌های بی‌ربط می‌آورد. اگر
// سؤال کوتاه است و نشانهٔ ارجاع به گفتگوی قبلی دارد، سؤال قبلی را هم به
// متن جست‌وجو اضافه می‌کنیم (فقط برای جست‌وجو؛ متن واقعی سؤال دست‌نخورده
// به مدل می‌رسد). بدون تماس اضافه با مدل، پس هزینه و تأخیری ندارد.
const FOLLOW_UP_MARKERS_AI = /(^|\s)(آن|این|همان|همین|اون|اینو|اونو|بیشتر|ادامه|چرا|چطور|چگونه|مثال|ساده‌تر|ساده تر|توضیح|دلیلش|دلیل|یعنی چی|باز کن|مفصل)(\s|$|؟|\?|،)/;

function buildFollowUpSearchQueryAi(question, history) {
  if (!Array.isArray(history) || history.length === 0) return question;
  if (question.length > 60 || !FOLLOW_UP_MARKERS_AI.test(question)) return question;
  const previous = history[history.length - 1].question;
  if (!previous) return question;
  return `${previous.slice(0, 300)}\n${question}`;
}

async function askQuestion(question, history = [], mode = "grounded", image = null, bookFilter = null, onDelta = null) {
  // آمار سایت: این تابع تنها نقطه‌ای‌ست که واقعاً سؤال کاربر رو به
  // Worker می‌فرسته (یک نقطه‌ی فراخوانی، رجوع کنید به renderChatTurns)،
  // پس بهترین جا برای ثبتِ «یک پرسشِ تبِ گفتگو»ست.
  if (typeof trackEvent === "function") {
    trackEvent("chat", question);
  }

  // Item جدید (پاسخ آزاد): تو این حالت، پاسخ قرار نیست به متون آرشیو
  // محدود باشه - پس نیازی به جست‌وجوی معنایی (که یه تماس شبکه‌ی اضافه‌ست)
  // نیست؛ context خالی می‌مونه و مآخذی هم نشون داده نمی‌شه.
  const searchQuery = buildFollowUpSearchQueryAi(question, history);
  const retrieved = mode === "general" ? { relevant: [], topScore: undefined } : await retrieveForChatAi(searchQuery, bookFilter);
  const relevant = retrieved.relevant;
  const contextTexts = relevant.map((r) => r.text);

  // قطعیِ اتصال (offline، فیلتر، DNS) با پیام انگلیسیِ خامِ مرورگر نشون داده
  // نمی‌شه؛ پیام روشن فارسی می‌گیره. سقف انتظارِ کل درخواست هم ۶۰ ثانیه‌ست.
  let chatRes;
  try {
    chatRes = await fetch(`${WORKER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        context: contextTexts,
        history,
        mode,
        image,
        // بالاترین شباهتِ cosine بین همهٔ نامزدها (نه تکهٔ اول بعد از rerank)؛ Worker زیر آستانه بدون Gemini «یافت نشد» می‌دهد.
        topScore: mode === "general" || relevant.length === 0 ? undefined : retrieved.topScore,
        // Item ۱۲: خصوصیاتِ دلخواهِ ذخیره‌شدهٔ کاربر (اگر تنظیم کرده باشد)
        customInstructions: getAiCustomInstructionsAi() || undefined,
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
    });
  } catch {
    throw new Error("اتصال به دستیار برقرار نشد. اینترنت‌تون رو بررسی کنید و دوباره بپرسید.");
  }

  if (!chatRes.ok) {
    let message = "خطا در دریافت پاسخ از دستیار";
    try {
      const errBody = await chatRes.json();
      if (errBody && errBody.error) message = errBody.error;
    } catch {
      // بدنهٔ خطا JSON نبود، از پیام پیش‌فرض استفاده کن
    }
    throw new Error(message);
  }

  // Item جدید (پخش تدریجی): Worker پاسخ رو به‌صورت چند خط JSON مستقل
  // (ndjson) پخش می‌کنه - هر خط یکی از {type:"delta"}, {type:"done"},
  // {type:"error"}. اینجا خط‌به‌خط می‌خونیم، برای هر «delta» بلافاصله
  // onDelta (اگه داده شده) رو صدا می‌زنیم تا حباب پاسخ تو رابط کاربری
  // همون لحظه به‌روز بشه، و در پایان متن کامل رو برمی‌گردونیم - دقیقاً
  // مثل قبل، برای این‌که بقیهٔ کد (منابع، آرشیو گفتگو و غیره) بدون
  // تغییر کار کنه.
  const reader = chatRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let usedReferences = null;

  let gotDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (msg.type === "delta" && typeof msg.text === "string") {
          answer += msg.text;
          if (typeof onDelta === "function") onDelta(msg.text, answer);
        } else if (msg.type === "done") {
          gotDone = true;
          usedReferences = msg.references ?? null;
        } else if (msg.type === "error") {
          throw new Error(msg.message || "خطا در دریافت پاسخ از دستیار");
        }
      }
    }
  } catch (err) {
    // پیام‌های خودِ Worker (type:"error") دست‌نخورده می‌رسن؛ فقط قطعیِ
    // اتصال حین پخش به پیام فارسی تبدیل می‌شه.
    if (err instanceof TypeError || (err && err.name === "AbortError")) {
      throw new Error("اتصال حین دریافت پاسخ قطع شد. لطفاً دوباره بپرسید.");
    }
    throw err;
  }

  // پخش بدون «done» یعنی پاسخ وسط راه قطع شده؛ پاسخ ناقص رو به‌عنوان
  // پاسخ کامل ذخیره نمی‌کنیم و منبع‌های نامرتبط هم نشون نمی‌دیم.
  if (!gotDone) {
    throw new Error("پاسخ کامل دریافت نشد (اتصال قطع شد). لطفاً دوباره بپرسید.");
  }
  if (!answer.trim()) {
    throw new Error("دستیار پاسخی تولید نکرد. لطفاً سؤال را کمی متفاوت بپرسید یا دوباره تلاش کنید.");
  }

  // آیتم ۱۰ (فیلتر ارتباط): اگه Worker گفته کدوم بخش‌ها رو واقعاً
  // استفاده کرده، فقط همونا رو به‌عنوان منبع برمی‌گردونیم - نه کل
  // نتایج خامِ جست‌وجوی معنایی (که ممکنه بعضیاشون اصلاً مرتبط نبوده باشن).
  const sources = Array.isArray(usedReferences)
    ? relevant.filter((_, i) => usedReferences.includes(i + 1))
    : relevant;

  return { answer, sources };
}

// ============================================================
// Item جدید: کپی، خروجی‌های سه‌گانه (Text/Word/PDF)، و افزودن به نشانه‌ها
// برای جست‌وجوی معنایی و گفت‌وگو — هم‌خانواده با قابلیت مشابهی که قبلاً
// برای جست‌وجوی متنی سایت (index.htm) ساخته شده. از همون کلید
// localStorage استفاده می‌کنیم تا این نتایج هم توی همون پنل «نشانه‌ها»ی
// سایت، کنار نتایج جست‌وجوی متنی، نشون داده بشن.
//
// رفع اشکال بحرانی: قبلاً این‌جا اشتباهاً از کلید آرشیو
// ("roohbakhshSearchResultsArchive") استفاده می‌شد، نه کلید واقعی نشانه‌ها
// ("roohbakhshBookmarks" — همون چیزی که in-page-search.js و دکمهٔ
// «🔖 نشانه‌ها» می‌خونن). یعنی دکمهٔ «افزودن به نشانه» تو این بخش،
// درواقع داشت آیتم رو تو آرشیو ذخیره می‌کرد، نه نشانه‌ها — برای همین
// چیزی که اضافه می‌شد، هیچ‌وقت تو پنل «نشانه‌ها» دیده نمی‌شد.
// ============================================================

const AI_BOOKMARKS_STORAGE_KEY = "roohbakhshBookmarks";

// Item ۱۲ (خصوصیاتِ شخصی‌سازیِ گفتگو): متنِ دلخواهی که کاربر یک‌بار
// ذخیره می‌کند و هوش با هر سؤال آن را می‌بیند - مثل «همیشه به زبان ساده
// جواب بده» یا «پاسخ‌ها کوتاه باشد». محلی روی همین مرورگر ذخیره می‌شود
// (بین گفتگوها/جلسات باقی می‌ماند، اما بین دستگاه‌های مختلف کاربر
// همگام نمی‌شود).
const AI_CUSTOM_INSTRUCTIONS_KEY = "roohbakhshAiCustomInstructions";

function getAiCustomInstructionsAi() {
  try {
    return localStorage.getItem(AI_CUSTOM_INSTRUCTIONS_KEY) || "";
  } catch {
    return "";
  }
}

function setAiCustomInstructionsAi(text) {
  try {
    if (text) {
      localStorage.setItem(AI_CUSTOM_INSTRUCTIONS_KEY, text);
    } else {
      localStorage.removeItem(AI_CUSTOM_INSTRUCTIONS_KEY);
    }
  } catch {
    // ذخیره‌سازی محلی در دسترس نبود (حالت خصوصی/ناشناس و مانند آن) -
    // بی‌سروصدا نادیده گرفته می‌شود، مثل بقیهٔ استفاده‌های localStorage
    // در این فایل.
  }
}

function escapeHtmlAi(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Item جدید (رفع باگ ۱۱: لینک‌هایی که هوش در گفتگوی آزاد می‌فرستاد، روی
// خودِ سایت کلیک‌پذیر نبودند): پاسخِ خام مستقیماً از سرور می‌آید و نه
// لینک‌های به‌سبک مارک‌داون ([متن](آدرس)) نه آدرس‌های خامِ ساده به <a>
// تبدیل می‌شوند - فقط متن ساده روی صفحه می‌نشینند (برای همین در کپی‌کردن
// به یک ادیتور دیگر که خودش این‌ها را تشخیص می‌دهد، کلیک‌پذیر به‌نظر
// می‌رسیدند، ولی خودِ سایت هیچ‌کدام را تبدیل نمی‌کرد). این تابع هر دو
// حالت را به لینک واقعی و کلیک‌پذیر تبدیل می‌کند - دقیقاً مثل محیط‌های
// چت معمولی.
function linkifyAnswerAi(text) {
  if (!text) return text;

  // امنیت (XSS): پاسخ از مدل می‌آید و می‌تواند تحت‌تأثیر متن‌های آرشیو یا
  // پیام کاربر باشد. پس اول کلِ متن escape می‌شود - برچسب و نقل‌قولِ
  // خام هیچ‌وقت به DOM نمی‌رسند - و فقط بعد از آن، لینک‌های http/https به
  // <a> تبدیل می‌شوند. (" هم escape شده، پس آدرس نمی‌تواند از href بیرون بزند.)
  const escaped = escapeHtmlAi(text);

  // اول لینک‌های به‌سبک مارک‌داون: [متن](آدرس)
  let result = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
  );

  // بعد هر آدرس خامی که از قبل داخل یک href="..." نیست (تا لینک‌هایی که
  // همین بالا ساختیم دوباره لینک نشن).
  result = result.replace(
    /(^|[^"'>])(https?:\/\/[^\s<]+[^\s<.,;:!؟)\]}"'])/g,
    (match, prefix, url) => `${prefix}<a href="${url}" target="_blank" rel="noopener">${url}</a>`
  );

  return result;
}

function downloadTextFileAi(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboardAi(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // به روش قدیمی‌تر زیر برمی‌گردیم
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// کپی به‌صورت متن غنی، تا هرجا پیست بشه (جیمیل، Word، واتس‌اپ وب) یه
// لینک کوتاه و کلیک‌پذیر «لینک منبع» نشون بده، نه آدرس کامل و طولانی.
async function copyRichTextAi(plainText, html) {
  try {
    if (navigator.clipboard && window.isSecureContext && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch {
    // به روش قدیمی‌تر زیر برمی‌گردیم
  }
  try {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.style.position = "fixed";
    container.style.opacity = "0";
    container.style.direction = "rtl";
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("copy");
    selection.removeAllRanges();
    document.body.removeChild(container);
    return ok;
  } catch {
    return copyTextToClipboardAi(plainText);
  }
}

function loadBookmarksAi() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_BOOKMARKS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBookmarksAi(items) {
  try {
    localStorage.setItem(AI_BOOKMARKS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ذخیره‌نشدن نشانه خطای مهمی نیست، کاربر می‌تونه دوباره امتحان کنه
  }
}

function addItemsToBookmarksAi(items, tags) {
  const bookmarks = loadBookmarksAi();
  items.forEach((item) => {
    bookmarks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: item.title,
      text: item.text,
      url: item.url,
      // این فیلدها رو هم‌شکل با نشانه‌های ساخته‌شده تو in-page-search.js
      // نگه می‌داریم (حتی اگه اینجا همیشه خالی/پیش‌فرض باشن) تا پنل
      // مشترک «نشانه‌ها» بدون فرض اضافه، هر دو نوع نشانه رو یکسان رندر کنه.
      tags: Array.isArray(tags) ? tags : [],
      links: [],
      occurrenceIndex: 1,
      page: item.page || null,
      // Item جدید (رفع باگ ۱: چند آدرسِ استنادشده در گفتگو، به‌صورت
      // لینک‌های جدا در بلوک نشانه‌ها دیده نمی‌شدن): این تابع تا این‌جا
      // sourcesInfo رو از item کپی نمی‌کرد - با این‌که خودِ item
      // (ساخته‌شده تو chatToolbar) این فیلد رو داشت. نبودِ این فیلد
      // تو نشانهٔ ذخیره‌شده باعث می‌شد bookmarkSourceLinksHtml (در
      // index.htm) هیچ‌وقت نتونه لینک‌های جداگانه بسازه - چون آدرس‌های
      // واقعی هیچ‌وقت واقعاً ذخیره نمی‌شدن، فقط اولین‌شون (تو url) و
      // یک برچسبِ متنیِ ساده (تو title، برای عنوانِ گروه‌بندی) باقی
      // می‌موند.
      sourcesInfo: Array.isArray(item.sourcesInfo) ? item.sourcesInfo : null,
      hasRealSource: item.hasRealSource !== false,
      savedAt: new Date().toISOString(),
    });

    // آمار سایت: این تابع، مسیرِ مشترکِ افزودنِ نشانه از تب‌های گفتگو و
    // جست‌وجوی مفهومیه (هر دو مسیر فراخوانی در chatToolbar به همینجا
    // می‌رسن)، پس تک‌جای درستیه برای ثبتِ «یک نشانه».
    if (typeof trackEvent === "function") {
      trackEvent("bookmark", item.title || "");
    }
  });
  saveBookmarksAi(bookmarks);
}

// ---------- آرشیو گفتگوها (تاریخچهٔ کامل گفتگوهای پیشین با دستیار) ----------
const AI_CHAT_ARCHIVE_STORAGE_KEY = "roohbakhshChatConversationsArchive";

function loadChatArchiveAi() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHAT_ARCHIVE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatArchiveAi(items) {
  try {
    localStorage.setItem(AI_CHAT_ARCHIVE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ذخیره‌نشدن آرشیو گفتگو خطای مهمی نیست
  }
}

// Item جدید: فهرست یکتای همهٔ کتاب‌هایی که در طول کل گفتگو (همهٔ
// تبادل‌ها، نه فقط آخری) به‌عنوان منبع استفاده شدن، هرکدوم با شماره
// صفحه‌اش - دقیقاً همون چیزی که برای عنوان آیتم آرشیوشده لازمه.
function collectConversationSourcesAi(chatTurns) {
  const sourcesInfo = [];
  const bookIndexMap = new Map();

  chatTurns.forEach((turn) => {
    (turn.sourcesInfo || []).forEach((s) => {
      if (!bookIndexMap.has(s.book)) {
        bookIndexMap.set(s.book, sourcesInfo.length);
        sourcesInfo.push({ book: s.book, entries: [...(s.entries || [])] });
        return;
      }

      const existing = sourcesInfo[bookIndexMap.get(s.book)];
      (s.entries || []).forEach((entry) => {
        if (!existing.entries.some((e) => e.page === entry.page && e.url === entry.url)) {
          existing.entries.push(entry);
        }
      });
    });
  });

  return sourcesInfo;
}

// اگه گفتگوی فعلی خالی نباشه، کل آن رو به‌عنوان یک آیتم به آرشیو
// گفتگوها اضافه می‌کنه؛ گفتگوی خالی (هیچ سؤالی پرسیده نشده) ذخیره نمی‌شه.
function archiveCurrentChatConversationAi(chatTurns) {
  if (!chatTurns || chatTurns.length === 0) return;

  const archive = loadChatArchiveAi();
  archive.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turns: chatTurns.map((turn) => ({
      question: turn.question,
      answer: turn.answer,
      mode: turn.mode || "grounded",
      sourcesInfo: turn.sourcesInfo || [],
    })),
    sourcesInfo: collectConversationSourcesAi(chatTurns),
    savedAt: new Date().toISOString(),
  });
  saveChatArchiveAi(archive);
}

function removeChatConversationAi(id) {
  saveChatArchiveAi(loadChatArchiveAi().filter((c) => c.id !== id));
  renderChatArchivePanelAi();
}

// Item جدید (رفع باگ ۱: انتخاب همه/لغو انتخاب/حذف موارد انتخاب‌شده در
// آرشیو گفتگوها فعال نبود): هم‌ساختار با selectedBookmarkIds در
// index.htm - کدام گفتگوهای آرشیوشده با چک‌باکس علامت خورده‌اند.
const chatArchiveSelectedIds = new Set();

function removeSelectedChatConversationsAi() {
  if (chatArchiveSelectedIds.size === 0) return;
  saveChatArchiveAi(
    loadChatArchiveAi().filter((c) => !chatArchiveSelectedIds.has(c.id))
  );
  chatArchiveSelectedIds.clear();
  renderChatArchivePanelAi();
}

// Item جدید: هر گفتگوی آرشیوشده، دقیقاً با همون قالب سؤال/پاسخ‌ازکتاب
// که برای خروجی تک‌تبادلی ساختیم رندر می‌شه - فقط پشت‌سرهم، برای همهٔ
// تبادل‌های همون گفتگو.
function renderChatArchivePanelAi() {
  const panel = document.getElementById("aiChatArchivePanel");
  if (!panel) return;

  const conversations = loadChatArchiveAi().slice().reverse();

  // Item جدید (رفع باگ ۱): گفتگویی که حذف شده دیگه تو
  // chatArchiveSelectedIds نمی‌مونه.
  Array.from(chatArchiveSelectedIds).forEach((id) => {
    if (!conversations.some((c) => c.id === id)) {
      chatArchiveSelectedIds.delete(id);
    }
  });

  const hasSelection = chatArchiveSelectedIds.size > 0;

  const listHtml = conversations.length === 0
    ? `<p class="archive-empty">هنوز گفتگویی در آرشیو ذخیره نشده است.</p>`
    : conversations
        .map((conv) => {
          const headerSources = formatSourcesInfoHtmlAi(conv.sourcesInfo);
          const turnsHtml = conv.turns
            .map((turn) => {
              const sourcesLine = formatSourcesInfoHtmlAi(turn.sourcesInfo);
              return `
                <div class="ai-chat-turn">
                  <div class="ai-chat-bubble ai-chat-bubble-user">${escapeHtmlAi(normalizeQuestionTextAi(turn.question))}</div>
                  <div class="ai-chat-bubble ai-chat-bubble-assistant">
                    ${freeAnswerBadgeHtmlAi(turn.mode)}
                    ${linkifyAnswerAi(turn.answer)}
                    ${sourcesLine ? `<div class="ai-chat-sources">پاسخ از کتاب ${sourcesLine}</div>` : ""}
                  </div>
                </div>
              `;
            })
            .join("");

          return `
            <div class="archive-item">
              <div class="bookmark-item-row">
                <input
                  type="checkbox"
                  class="in-page-bookmark-checkbox"
                  data-chat-archive-select="${escapeHtmlAi(conv.id)}"
                  ${chatArchiveSelectedIds.has(conv.id) ? "checked" : ""}
                  aria-label="انتخاب این گفتگو">
                <div class="bookmark-item-content">
                  <div class="archive-item-title">${headerSources || "کتاب‌های نامشخص"}</div>
                  ${turnsHtml}
                  <div class="archive-item-actions">
                    <button type="button" data-chat-archive-continue="${escapeHtmlAi(conv.id)}">ادامهٔ گفتگو</button>
                    <button type="button" data-chat-archive-id="${escapeHtmlAi(conv.id)}">حذف</button>
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join("");

  panel.innerHTML = `
    <button type="button" class="panel-close-x" id="aiChatArchiveClose" title="بستن" aria-label="بستن">×</button>
    <div class="panel-scroll-area">
    <div class="archive-header">
      <span>آرشیو گفتگوها (${conversations.length})</span>
      <div class="archive-header-actions">
        <button
          type="button"
          id="aiChatArchiveSelectAll"
          title="انتخاب تمام گفتگوهای این فهرست"
          ${conversations.length === 0 ? "disabled" : ""}>انتخاب همه</button>
        <button
          type="button"
          id="aiChatArchiveClearSelection"
          title="لغو انتخاب تمام گفتگوهایی که انتخاب کرده‌اید"
          ${hasSelection ? "" : "disabled"}>
          لغو انتخاب
          ${hasSelection ? `<span class="bookmark-selection-badge">(${chatArchiveSelectedIds.size})</span>` : ""}
        </button>
        <button
          type="button"
          id="aiChatArchiveDeleteSelected"
          title="حذف فقط گفتگوهای انتخاب‌شده"
          ${hasSelection ? "" : "disabled"}>حذف موارد انتخاب‌شده</button>
      </div>
    </div>
    ${listHtml}
    </div>
  `;

  const closeButton = panel.querySelector("#aiChatArchiveClose");
  if (closeButton) {
    closeButton.addEventListener("click", closeChatArchivePanelAi);
  }

  const selectAllButton = panel.querySelector("#aiChatArchiveSelectAll");
  if (selectAllButton) {
    selectAllButton.addEventListener("click", () => {
      chatArchiveSelectedIds.clear();
      conversations.forEach((conv) => chatArchiveSelectedIds.add(conv.id));
      renderChatArchivePanelAi();
    });
  }

  const clearSelectionButton = panel.querySelector("#aiChatArchiveClearSelection");
  if (clearSelectionButton) {
    clearSelectionButton.addEventListener("click", () => {
      chatArchiveSelectedIds.clear();
      renderChatArchivePanelAi();
    });
  }

  const deleteSelectedButton = panel.querySelector("#aiChatArchiveDeleteSelected");
  if (deleteSelectedButton) {
    deleteSelectedButton.addEventListener("click", removeSelectedChatConversationsAi);
  }

  panel.querySelectorAll("[data-chat-archive-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const id = checkbox.dataset.chatArchiveSelect;

      if (checkbox.checked) {
        chatArchiveSelectedIds.add(id);
      } else {
        chatArchiveSelectedIds.delete(id);
      }

      renderChatArchivePanelAi();
    });
  });

  panel.querySelectorAll("[data-chat-archive-id]").forEach((button) => {
    button.addEventListener("click", () => {
      removeChatConversationAi(button.dataset.chatArchiveId);
    });
  });

  // Item جدید (آرشیو گفتگو باز باشد): کاربر می‌تونه یه گفتگوی
  // آرشیوشده رو دوباره فعال کنه و ادامه بده - به‌جای این‌که فقط
  // بتونه ببینتش یا حذفش کنه.
  panel.querySelectorAll("[data-chat-archive-continue]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.chatArchiveContinue;
      const conversation = loadChatArchiveAi().find((c) => c.id === id);
      if (!conversation) return;

      // Item جدید (رفع باگ ۲۳: بعد از «ادامهٔ گفتگو»، سؤال/جواب برمی‌گشت
      // اما کادر تایپ اجازه نمی‌داد): قبلاً اول رویداد ادامهٔ گفتگو صادر
      // می‌شد (که در انتهایش aiChatInput.focus() صدا زده می‌شود) و فقط
      // بعد از آن پنل آرشیو بسته می‌شد - یعنی focus() درست وسط
      // بسته‌شدنِ پنل/همپوشانِ overlay اجرا می‌شد و مرورگر آن را از
      // دست می‌داد یا نادیده می‌گرفت. حالا اول پنل و overlay کاملاً
      // بسته می‌شوند، و فقط در تیکِ بعدیِ event loop (بعد از این‌که
      // overlay واقعاً از صفحه کنار رفت) گفتگو جایگزین و به کادر
      // فوکوس داده می‌شود.
      removeChatConversationAi(id);
      closeChatArchivePanelAi();

      setTimeout(() => {
        document.dispatchEvent(new CustomEvent("ai-chat-continue-conversation", { detail: conversation }));
      }, 0);
    });
  });
}

function openChatArchivePanelAi() {
  renderChatArchivePanelAi();
  const overlay = document.getElementById("aiChatArchiveOverlay");
  if (overlay) overlay.classList.add("open");
}

function closeChatArchivePanelAi() {
  const overlay = document.getElementById("aiChatArchiveOverlay");
  if (overlay) overlay.classList.remove("open");
}

// ---------- ساخت متن ساده / HTML غنی / سند Word / برگهٔ چاپی از یک لیست آیتم {title, text, url} ----------
// Item جدید: سؤال گاهی به‌خاطر فاصله‌های اضافه یا خط‌جدیدهای نامرتب (مثلاً
// از کپی‌پیست) به‌هم‌ریخته است؛ این تابع فقط همین فاصله‌گذاری رو یکسان و
// مرتب می‌کنه - نه غلط‌گیری املایی یا بازنویسی معنایی سؤال.
function normalizeQuestionTextAi(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// Item جدید: خط «پاسخ از کتاب...» برای خروجی‌های گفتگو - هر کتاب یک‌بار،
// با شماره صفحه‌اش کنارش (فقط اگه آن کتاب صفحه داشته باشه). این نسخه
// فقط اسم کتاب‌ها رو برمی‌گردونه (برای متن ساده)؛ لینک‌ها جدا اضافه می‌شن.
// Item جدید: وقتی خودِ متنِ پاسخ می‌گه چیزی تو منابع پیدا نشده (طبق
// دستورالعملی که تو سیستم‌پرامپت Worker به Gemini دادیم)، نشون‌دادن
// یه لیست منابع کنار همچین پاسخی گمراه‌کننده‌ست - چون اون تکه‌متن‌ها
// واقعاً به سؤال ربطی نداشتن، فقط نزدیک‌ترین چیزی بودن که جست‌وجوی
// معنایی پیدا کرده. این تابع چند الگوی رایج «یافت نشد» رو تشخیص می‌ده.
function answerIndicatesNotFoundAi(answerText) {
  const patterns = [
    /یافت\s*نشد/,
    /پیدا\s*نشد/,
    /موجود\s*نیست/,
    /اطلاعاتی\s*(در|درباره).*(نیست|ندار)/,
  ];
  return patterns.some((pattern) => pattern.test(answerText || ""));
}

// برچسب روشن برای پاسخ‌های حالت «پاسخ آزاد» که مستند به آرشیو نیستند.
const FREE_ANSWER_BADGE_TEXT_AI = "این پاسخ مستند به آرشیو نیست";
function freeAnswerBadgeHtmlAi(mode) {
  if (mode !== "general") return "";
  return `<div class="ai-chat-free-badge" role="note" style="display:inline-block;margin:0 0 6px;padding:2px 8px;border-radius:10px;font-size:0.8em;background:rgba(217,119,6,0.15);border:1px solid rgba(217,119,6,0.55);">⚠ ${FREE_ANSWER_BADGE_TEXT_AI}</div>`;
}

function formatSourcesInfoLineAi(sourcesInfo) {
  if (!Array.isArray(sourcesInfo) || sourcesInfo.length === 0) return "";
  return sourcesInfo
    .map((s) => {
      const pages = (s.entries || []).map((e) => e.page).filter(Boolean);
      return pages.length > 0 ? `${s.book} (صفحهٔ ${pages.join("، ")})` : s.book;
    })
    .join("، ");
}

// آیتم ۴ (لینک‌دهی مثل جست‌وجوی مفهومی): همون خط بالا، ولی هر صفحه
// خودش یه لینک واقعی به همون بخش از کتابه - برای خروجی‌های HTML/Word/PDF
// و پنل زندهٔ گفتگو. اگه یک کتاب از دو جای مختلف استفاده شده باشه، اسم
// کتاب فقط یک‌بار میاد ولی هر دو صفحه (هرکدوم با لینک خودش) نشون داده
// می‌شه.
function formatSourcesInfoHtmlAi(sourcesInfo) {
  if (!Array.isArray(sourcesInfo) || sourcesInfo.length === 0) return "";
  return sourcesInfo
    .map((s) => {
      const entries = s.entries && s.entries.length ? s.entries : [{ page: null, url: s.url }];

      // فقط یه تکه از این کتاب استفاده شده - نمایش ساده، بدون پرانتز
      // اضافه اگه صفحه‌ای در کار نباشه.
      if (entries.length === 1) {
        const entry = entries[0];
        const label = entry.page ? `${escapeHtmlAi(s.book)} (صفحهٔ ${escapeHtmlAi(String(entry.page))})` : escapeHtmlAi(s.book);
        return entry.url
          ? `<a href="${escapeHtmlAi(entry.url)}" target="_blank" rel="noopener" style="color:#1d4ed8;text-decoration:none;">${label}</a>`
          : label;
      }

      // چند تکه از همین یک کتاب - هرکدوم جدا نشون داده می‌شه؛ اگه صفحه
      // داشت با شمارهٔ صفحه، وگرنه (چون این فایل صفحه‌بندی نداره) با
      // یه شمارهٔ ترتیبی «بخش N» - وگرنه تکه‌های بدون صفحه، بی‌سروصدا
      // از دید کاربر گم می‌شدن.
      const partsHtml = entries
        .map((entry, i) => {
          const partLabel = entry.page ? `صفحهٔ ${escapeHtmlAi(String(entry.page))}` : `بخش ${i + 1}`;
          return entry.url
            ? `<a href="${escapeHtmlAi(entry.url)}" target="_blank" rel="noopener" style="color:#1d4ed8;text-decoration:none;">${partLabel}</a>`
            : partLabel;
        })
        .join("، ");

      return `${escapeHtmlAi(s.book)} (${partsHtml})`;
    })
    .join("، ");
}

// نسخهٔ متن‌سادهٔ فهرست لینک‌ها - هر صفحه/آدرس در یک خط، برای فایل txt
// که اصلاً نمی‌تونه لینک قابل‌کلیک داشته باشه.
function formatSourcesInfoLinksPlainTextAi(sourcesInfo, indent) {
  if (!Array.isArray(sourcesInfo) || sourcesInfo.length === 0) return "";
  const lines = [];
  sourcesInfo.forEach((s) => {
    const entries = s.entries && s.entries.length ? s.entries : [{ page: null, url: s.url }];
    entries.forEach((e) => {
      if (!e.url) return;
      const label = e.page ? `${s.book} (صفحهٔ ${e.page})` : s.book;
      lines.push(`\n${indent}🔗 ${label}: ${e.url}`);
    });
  });
  return lines.join("");
}

function buildPlainTextForItemsAi(items) {
  const divider = "─".repeat(32);
  return items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoLineAi(item.sourcesInfo);
        const linksSuffix = formatSourcesInfoLinksPlainTextAi(item.sourcesInfo, "   ");
        return (
          `${i + 1}. سؤال: ${normalizeQuestionTextAi(item.question)}\n` +
          (sourcesLine ? `   پاسخ از کتاب ${sourcesLine}:\n` : "   پاسخ:\n") +
          `${divider}\n«${item.answer}»` +
          linksSuffix
        );
      }

      return (
        `${i + 1}. 📘 ${item.title}${item.page ? ` — صفحهٔ ${item.page}` : ""}\n${divider}\n«${item.text}»` +
        (item.url ? `\n🔗 لینک: ${item.url}` : "")
      );
    })
    .join("\n\n");
}

function buildRichHtmlForItemsAi(items) {
  return items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoHtmlAi(item.sourcesInfo);
        return (
          `<div dir="ltr" style="margin:0 0 16px;text-align:right;">` +
          `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `font-weight:bold;color:#173b63;text-align:right;">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</p>` +
          (sourcesLine
            ? `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;` +
              `color:#1d4ed8;text-align:right;">پاسخ از کتاب ${sourcesLine}:</p>`
            : "") +
          `<p dir="ltr" style="margin:0;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `line-height:1.9;color:#1f2937;text-align:right;">«${escapeHtmlAi(item.answer)}»</p>` +
          `</div>`
        );
      }

      return (
        `<div dir="ltr" style="margin:0 0 16px;text-align:right;">` +
        `<table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px;">` +
        `<tr><td style="padding:9px 14px;background:#eff6ff;border-right:4px solid #2563eb;` +
        `font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;color:#173b63;text-align:right;">` +
        `📘\u00a0${escapeHtmlAi(item.title)}${item.page ? `\u00a0—\u00a0صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</td></tr></table>` +
        `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
        `line-height:1.9;color:#1f2937;text-align:right;"><strong>${i + 1}.</strong>\u00a0«${escapeHtmlAi(item.text)}»</p>` +
        (item.url
          ? `<p dir="ltr" style="margin:0;font-family:Tahoma,Arial,sans-serif;font-size:12px;text-align:right;">🔗 ` +
            `<a href="${escapeHtmlAi(item.url)}" style="color:#1d4ed8;text-decoration:none;">لینک منبع</a></p>`
          : "") +
        `</div>`
      );
    })
    .join("");
}

function buildWordDocForItemsAi(items) {
  const itemsHtml = items
    .map((item, i) => {
      const topMargin = i === 0 ? "0" : "18px";

      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoHtmlAi(item.sourcesInfo);
        return (
          `<p dir="rtl" style="margin:${topMargin} 0 3px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `font-weight:bold;color:#173b63;text-align:right;">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</p>` +
          (sourcesLine
            ? `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;` +
              `color:#1d4ed8;text-align:right;">پاسخ از کتاب ${sourcesLine}:</p>`
            : "") +
          `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `line-height:1.9;color:#1f2937;text-align:right;">«${escapeHtmlAi(item.answer)}»</p>`
        );
      }

      return (
        `<table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;margin:${topMargin} 0 8px;">` +
        `<tr><td style="padding:9px 14px;background:#eff6ff;border-right:4px solid #2563eb;` +
        `font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;color:#173b63;text-align:right;">` +
        `📘\u00a0${escapeHtmlAi(item.title)}${item.page ? `\u00a0—\u00a0صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</td></tr></table>` +
        `<p dir="rtl" style="margin:0 0 3px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
        `line-height:1.9;color:#1f2937;text-align:right;"><strong>${i + 1}.</strong>\u00a0«${escapeHtmlAi(item.text)}»</p>` +
        (item.url
          ? `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;text-align:right;">🔗 ` +
            `<a href="${escapeHtmlAi(item.url)}" style="color:#1d4ed8;text-decoration:none;">لینک منبع</a></p>`
          : "")
      );
    })
    .join("");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>خروجی دستیار هوشمند</title>
      <!--[if gte mso 9]>
      <xml><w:WordDocument><w:View>Print</w:View><w:DoNotOptimizeForBrowser/></w:WordDocument></xml>
      <![endif]-->
    </head>
    <body dir="rtl" style="font-family:Tahoma,Arial,sans-serif;">${itemsHtml}</body>
  </html>`;
}

function openPrintableForItemsAi(items) {
  const itemsHtml = items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoHtmlAi(item.sourcesInfo);
        return `
      <div class="export-item">
        <div class="export-book-title">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</div>
        ${sourcesLine ? `<p class="export-page">پاسخ از کتاب ${sourcesLine}:</p>` : ""}
        <p class="export-snippet">«${escapeHtmlAi(item.answer)}»</p>
      </div>`;
      }

      return `
      <div class="export-item">
        <div class="export-book-title">📘 ${escapeHtmlAi(item.title)}${item.page ? ` — صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</div>
        <p class="export-snippet"><strong>${i + 1}.</strong>&nbsp;«${escapeHtmlAi(item.text)}»</p>
        ${item.url ? `<p class="export-link">🔗 <a href="${escapeHtmlAi(item.url)}">لینک منبع</a></p>` : ""}
      </div>`;
    })
    .join("");

  const doc = `<!DOCTYPE html>
    <html lang="fa" dir="rtl">
    <head>
      <meta charset="utf-8">
      <title>خروجی دستیار هوشمند</title>
      <style>
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { font-family: Tahoma, Arial, sans-serif; direction: rtl; text-align: right; color: #1f2937; margin: 24px; }
        .export-item { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .export-book-title { margin: 0 0 6px; padding: 8px 12px; background: #eff6ff; border-right: 4px solid #2563eb; border-radius: 6px; font-size: 14px; font-weight: bold; color: #173b63; }
        .export-snippet { margin: 0 0 4px; font-size: 15px; line-height: 2; }
        .export-page { margin: 0 0 4px; font-size: 12px; color: #1d4ed8; }
        .export-link { margin: 0; font-size: 12px; }
        .export-link a { color: #1d4ed8; text-decoration: none; }
        @media print { body { margin: 10mm; } }
      </style>
    </head>
    <body>${itemsHtml}<script>window.onload = () => window.print();<\/script></body>
    </html>`;

  const printWindow = window.open("", "_blank");
  if (!printWindow) return;
  printWindow.document.open();
  printWindow.document.write(doc);
  printWindow.document.close();
}

// ---------- ساخت نوار ابزار (کپی / Text / Word / PDF / نشانه) ----------
// getItems: تابعی که هروقت روی دکمه‌ای کلیک شد، لیست فعلی آیتم‌های
// {title, text, url} رو برمی‌گردونه — برای جست‌وجو: موارد تیک‌خورده؛
// برای چت: همون یک پاسخ فعلی.
function createAiToolbar(getItems, emptyMessage, selectionControls) {
  const bar = document.createElement("details");
  bar.className = "ai-result-toolbar";

  // Item جدید (یکسان‌سازی چینش - بند ج/س): وقتی صدازننده کنترل‌های
  // انتخاب رو بده، «انتخاب همه»/«لغو انتخاب» همیشه اضافه می‌شن؛
  // «حذف موارد انتخاب‌شده» و «آرشیو» اختیاری‌ان - فقط وقتی صدازننده
  // (به‌ترتیب برای جست‌وجو یا گفتگو) callback مربوطه رو بده.
  const selectionButtonsHtml = selectionControls
    ? `
      <button type="button" class="ai-toolbar-btn" data-action="select-all">انتخاب همه</button>
      <button type="button" class="ai-toolbar-btn" data-action="clear-selection">لغو انتخاب</button>
      ${selectionControls.deleteSelected ? `<button type="button" class="ai-toolbar-btn" data-action="delete-selected">🗑️ حذف موارد انتخاب‌شده</button>` : ""}
    `
    : "";

  const archiveButtonHtml = selectionControls && selectionControls.viewArchive
    ? `<button type="button" class="ai-toolbar-btn" data-action="view-archive">🗂️ آرشیو</button>`
    : "";

  bar.innerHTML = `
    <summary class="ai-toolbar-summary">☰ عملیات</summary>
    <div class="ai-toolbar-buttons">
      ${selectionButtonsHtml}
      <button type="button" class="ai-toolbar-btn" data-action="copy">📋 کپی</button>
      <button type="button" class="ai-toolbar-btn" data-action="text">Text</button>
      <button type="button" class="ai-toolbar-btn" data-action="word">Word</button>
      <button type="button" class="ai-toolbar-btn" data-action="pdf">PDF</button>
      <button type="button" class="ai-toolbar-btn" data-action="bookmark">⭐ افزودن به نشانه</button>
      <button type="button" class="ai-toolbar-btn" data-action="view-bookmarks">🔖 مشاهدهٔ نشانه‌ها</button>
      ${archiveButtonHtml}
      <button type="button" class="ai-toolbar-btn" data-action="settings">⚙️ خصوصیات گفتگو</button>
      <span class="ai-toolbar-status" aria-live="polite"></span>
    </div>
  `;

  const status = bar.querySelector(".ai-toolbar-status");
  function setStatus(msg) {
    if (!status) return;
    status.textContent = msg;
    setTimeout(() => { status.textContent = ""; }, 1800);
  }

  bar.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ai-toolbar-btn");
    if (!btn) return;

    const action = btn.dataset.action;

    // Item جدید: مشاهدهٔ نشانه‌ها به آیتم انتخاب‌شده نیازی نداره - برخلاف
    // بقیهٔ دکمه‌ها، همیشه باید کار کنه، حتی وقتی چیزی انتخاب/تولید نشده.
    if (action === "view-bookmarks") {
      if (typeof openBookmarksPanel === "function") {
        openBookmarksPanel();
      }
      return;
    }

    // Item ۱۲ (خصوصیاتِ شخصی‌سازیِ گفتگو): کاربر یک متن دلخواه ذخیره
    // می‌کند (مثلاً «پاسخ‌ها را کوتاه و ساده بده») که با هر سؤال، همراه
    // درخواست برای Worker فرستاده می‌شود (نگاه کنید به askQuestion).
    if (action === "settings") {
      const current = getAiCustomInstructionsAi();
      const next = prompt(
        "چه خصوصیاتی می‌خواهید هوش هنگام گفتگو با شما رعایت کند؟ (مثلاً لحن، طول پاسخ، سطح توضیح). برای پاک‌کردن، خالی بگذارید و تایید کنید.",
        current
      );

      if (next !== null) {
        setAiCustomInstructionsAi(next.trim());
        setStatus(next.trim() ? "ذخیره شد" : "پاک شد");
      }

      return;
    }

    // Item جدید (بند ج): سه دکمهٔ انتخاب هم به همون کنترل‌های صدازننده
    // وصل می‌شن - این‌ها هم به آیتم انتخاب‌شده نیازی ندارن.
    if (action === "select-all" && selectionControls) {
      selectionControls.selectAll();
      return;
    }
    if (action === "clear-selection" && selectionControls) {
      selectionControls.clearSelection();
      return;
    }
    if (action === "delete-selected" && selectionControls) {
      selectionControls.deleteSelected();
      return;
    }
    if (action === "view-archive" && selectionControls) {
      selectionControls.viewArchive();
      return;
    }

    const items = getItems();
    if (!items || items.length === 0) {
      setStatus(emptyMessage || "چیزی انتخاب نشده");
      return;
    }

    if (action === "copy") {
      const ok = await copyRichTextAi(buildPlainTextForItemsAi(items), buildRichHtmlForItemsAi(items));
      setStatus(ok ? "کپی شد!" : "خطا در کپی");
    } else if (action === "text") {
      if (typeof trackEvent === "function") trackEvent("export", "text");
      downloadTextFileAi("خروجی-دستیار-هوشمند.txt", buildPlainTextForItemsAi(items));
    } else if (action === "word") {
      if (typeof trackEvent === "function") trackEvent("export", "word");
      downloadTextFileAi("خروجی-دستیار-هوشمند.doc", buildWordDocForItemsAi(items), "application/msword;charset=utf-8");
    } else if (action === "pdf") {
      if (typeof trackEvent === "function") trackEvent("export", "pdf");
      openPrintableForItemsAi(items);
    } else if (action === "bookmark") {
      // Item جدید (رفع باگ ریشه‌ای - پیدا شد با تست واقعی در مرورگر):
      // بدون stopPropagation، این کلیک به document بابل می‌کرد و همون
      // شنوندهٔ سراسریِ «کلیک بیرون از پاپ‌آور برچسب» (که در index.htm
      // تعریف شده) بلافاصله همون کادری که تازه باز شده بود رو می‌بست -
      // همه‌چیز تو همون یه تیکِ کلیک، قبل از این‌که کاربر حتی ببینتش.
      e.stopPropagation();
      if (typeof window.openBookmarkTagPopoverGeneric === "function") {
        window.openBookmarkTagPopoverGeneric(btn.getBoundingClientRect(), (tags) => {
          addItemsToBookmarksAi(items, tags);
          setStatus("به نشانه‌ها افزوده شد");
        });
      } else {
        // اگه به هر دلیلی تابع عمومی در دسترس نبود، حداقل بدون برچسب ذخیره کن
        addItemsToBookmarksAi(items);
        setStatus("به نشانه‌ها افزوده شد");
      }
    }
  });

  return bar;
}

// ---------- استایل کمی برای ردیف چک‌باکس و نوار ابزار جدید ----------
// چون این کلاس‌ها تو stylesheet خودِ index.htm تعریف نشدن، همین‌جا با JS
// تزریق می‌شن تا نیازی به دست‌کاری index.htm نباشه. از رنگ/فونت‌های
// هماهنگ با ظاهر فعلی سایت استفاده شده.
function injectAiToolbarStyles() {
  if (document.getElementById("ai-toolbar-styles")) return; // فقط یک‌بار
  const style = document.createElement("style");
  style.id = "ai-toolbar-styles";
  style.textContent = `
    .ai-search-result-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 10px;
      border-radius: 8px;
      transition: background 0.15s ease;
    }
    .ai-search-result-row.is-active-result {
      background: #eff6ff;
      outline: 2px solid #93c5fd;
    }
    .ai-search-result-row .ai-result-marker {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
    }
    .ai-search-result-row .ai-result-marker .result-number {
      font-size: 0.85rem;
      color: #64748b;
    }
    .ai-search-result-row .ai-result-marker .ai-result-page {
      font-size: 0.72rem;
      padding: 1px 6px;
      border-radius: 9999px;
      background: #eff6ff;
      color: #1d4ed8;
      white-space: nowrap;
    }
    .ai-search-result-row .ai-search-result {
      flex: 1;
      min-width: 0;
    }
    .ai-result-toolbar {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 21;
      margin-top: 6px;
      width: auto;
      background: #fff;
      border: 1px solid #dbe3ee;
      border-radius: 10px;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.15);
    }
    .ai-toolbar-summary {
      display: none;
    }
    .ai-toolbar-buttons {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 8px;
    }
    .ai-toolbar-btn {
      border: 1px solid #cbd5e1;
      background: #fff;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 0.83rem;
      cursor: pointer;
      color: #1f2937;
      text-align: right;
    }
    .ai-toolbar-btn:hover {
      background: #eff6ff;
      border-color: #93c5fd;
    }
    .ai-toolbar-status {
      font-size: 0.82rem;
      color: #16a34a;
    }
    .ai-toolbar-status:not(:empty) {
      display: block;
      width: 100%;
      font-weight: bold;
      color: #1d4ed8;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed #e2e8f0;
    }
    /* Item جدید: گفتگوی ادامه‌دار - .ai-chat-turn و حباب‌های سؤال/پاسخ
       تو index.htm (کنار بقیهٔ استایل ثابت بخش گفتگو) تعریف شدن، نه
       اینجا - چون این استایل‌ها به‌صورت پویا تزریق می‌شن و باید بعد از
       بارگذاری صفحه هم پابرجا بمونن. */
    .ai-chat-pending {
      color: #64748b;
      font-size: 0.9rem;
      padding: 6px 0;
    }
    .ai-chat-error {
      color: #b91c1c;
      font-size: 0.9rem;
      padding: 6px 0;
    }
  `;
  document.head.appendChild(style);
}

// ---------- اتصال به رابط کاربری واقعی سایت (تب «دستیار هوشمند») ----------
// این id ها عمداً با پیشوند ai نگه داشته شدن تا با سیستم جست‌وجوی کلمه‌ای
// موجود سایت (که از id های searchInput/searchResults استفاده می‌کنه) تداخل نداشته باشن.

document.addEventListener("DOMContentLoaded", () => {
  injectAiToolbarStyles();

  const aiSearchInput = document.getElementById("aiSearchInput");
  const aiSearchResults = document.getElementById("aiSearchResults");
  const aiSearchStatus = document.getElementById("aiSearchStatus");
  const aiSearchResultsDropdown = document.querySelector(".ai-search-results-dropdown");

  if (aiSearchInput && aiSearchResults) {
    let debounceTimer;
    let searchToken = 0; // شمارندهٔ نسل: هر بار تایپ، شماره‌ای جدید می‌گیره
    let latestSearchResults = []; // نتایج جست‌وجوی آخر، برای نوار ابزار زیرش
    // صفحه‌بندی نتایج (هم‌شکل جست‌وجوی متنی): هر کادر ۸ نتیجه، بقیه در صفحه‌های بعد.
    const AI_RESULTS_PER_PAGE = 8;
    let aiResultsPage = 1;
    const searchSelectedIndexes = new Set(); // ایندکس‌های تیک‌خورده در همین نتایج
    // آیتم ب: محدودهٔ جست‌وجو - Set از کتاب‌های تیک‌خورده (خالی = کل آرشیو)
    const aiSearchBookScope = setupScopeSelector("aiSearchScopeToggle", "aiSearchScopePanel", "aiSearchScopeList");

    // Item جدید (کار روی چند نتیجه با هم): چک‌باکس‌های زنده رو با
    // searchSelectedIndexes هماهنگ می‌کنه - هم موقع «انتخاب همه»/«لغو
    // انتخاب»، هم بعد از هر جست‌وجوی تازه.
    function syncSearchCheckboxes() {
      aiSearchResults.querySelectorAll(".ai-result-checkbox").forEach((checkbox) => {
        const index = Number(checkbox.dataset.aiIndex);
        checkbox.checked = searchSelectedIndexes.has(index);
      });
    }

    // شمارهٔ ردیف‌ها (و data-ai-index) سراسری است، نه شمارهٔ داخل صفحه؛ پس
    // انتخاب، کپی و خروجی روی همهٔ نتایج کار می‌کنند.
    function renderAiResultsHtml() {
      const totalPages = Math.max(1, Math.ceil(latestSearchResults.length / AI_RESULTS_PER_PAGE));
      aiResultsPage = Math.min(Math.max(aiResultsPage, 1), totalPages);
      const start = (aiResultsPage - 1) * AI_RESULTS_PER_PAGE;
      aiSearchResults.innerHTML = latestSearchResults
        .slice(start, start + AI_RESULTS_PER_PAGE)
        .map((r, k) => {
          const i = start + k;
          return `<div class="ai-search-result-row${i === activeResultIndex ? " is-active-result" : ""}" data-ai-row="${i}">
              <div class="ai-result-marker">
                <input type="checkbox" class="result-checkbox ai-result-checkbox" data-ai-index="${i}" title="انتخاب برای کپی/خروجی/نشانه" ${searchSelectedIndexes.has(i) ? "checked" : ""}>
                <span class="result-number">${i + 1}</span>
                ${r.page ? `<span class="ai-result-page" title="شمارهٔ صفحهٔ چاپی">ص ${r.page}</span>` : ""}
              </div>
              <a class="ai-search-result" href="${textFragmentUrl(encodeURI(r.source), r.text, r.page)}" target="_blank" rel="noopener">
                <strong>${r.book}</strong>
                <p>${r.text}</p>
                <small>میزان تطابق مفهومی: ${(r.score * 100).toFixed(1)}٪ — برای مشاهدهٔ کتاب کلیک کنید</small>
              </a>
            </div>`;
        })
        .join("");
      renderAiPagination(totalPages);
    }

    function renderAiPagination(totalPages) {
      let box = document.getElementById("aiSearchPagination");
      if (!box) {
        box = document.createElement("div");
        box.id = "aiSearchPagination";
        box.className = "pagination";
        aiSearchResults.insertAdjacentElement("afterend", box);
        box.addEventListener("click", (e) => {
          const button = e.target.closest(".page-button");
          if (!button || button.disabled) return;
          const target = Number(button.dataset.page);
          if (!target || target === aiResultsPage) return;
          aiResultsPage = target;
          renderAiResultsHtml();
          const dropdown = document.querySelector(".ai-search-results-dropdown");
          if (dropdown) dropdown.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
      if (totalPages <= 1) {
        box.innerHTML = "";
        return;
      }
      const btn = (label, page, disabled, current) =>
        `<button type="button" class="page-button${current ? " current-page" : ""}" data-page="${page}" ${disabled ? "disabled" : ""} ${current ? 'aria-current="page"' : ""}>${label}</button>`;
      const parts = [btn("صفحهٔ قبلی", aiResultsPage - 1, aiResultsPage === 1, false)];
      for (let n = 1; n <= totalPages; n++) parts.push(btn(`صفحهٔ ${n}`, n, false, n === aiResultsPage));
      parts.push(btn("صفحهٔ بعدی", aiResultsPage + 1, aiResultsPage === totalPages, false));
      box.innerHTML = parts.join("");
    }

    // نوار ابزار یک‌بار ساخته و بعد از باکس نتایج قرار می‌گیره؛ هر بار
    // که نتایج جدید بیاد، همین نوار می‌مونه، فقط لیست انتخاب‌ها خالی می‌شه.
    const searchToolbar = createAiToolbar(
      () =>
        [...searchSelectedIndexes]
          .sort((a, b) => a - b)
          .map((i) => latestSearchResults[i])
          .filter(Boolean)
          .map((r) => ({ title: r.book, text: r.text, url: textFragmentUrl(encodeURI(r.source), r.text, r.page), page: r.page })),
      "ابتدا یک یا چند نتیجه را با تیک انتخاب کنید",
      {
        selectAll: () => {
          searchSelectedIndexes.clear();
          latestSearchResults.forEach((_, i) => searchSelectedIndexes.add(i));
          syncSearchCheckboxes();
        },
        clearSelection: () => {
          searchSelectedIndexes.clear();
          syncSearchCheckboxes();
        },
        // Item جدید (بند ج - حذف موارد انتخاب‌شده): برخلاف «لغو انتخاب»
        // (که فقط تیک برمی‌داره)، این دکمه خودِ نتیجه‌های تیک‌خورده رو
        // از همین فهرست نتایج فعلی کنار می‌ذاره (فقط نمایش، نه چیزی که
        // تو آرشیو/نشانه‌ها ذخیره شده باشه).
        deleteSelected: () => {
          if (searchSelectedIndexes.size === 0) return;
          latestSearchResults = latestSearchResults.filter((_, i) => !searchSelectedIndexes.has(i));
          searchSelectedIndexes.clear();
          activeResultIndex = -1;
          updateAiSearchNavButtons();
          renderAiResultsHtml();
          if (aiSearchResultsDropdown) {
            aiSearchResultsDropdown.style.display = latestSearchResults.length > 0 ? "block" : "none";
          }
        },
      }
    );
    const aiSearchRow = document.getElementById("aiSearchRow");
    if (aiSearchRow) aiSearchRow.appendChild(searchToolbar);

    aiSearchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const myToken = ++searchToken; // این تلاش، صاحب همین شماره‌ست

      debounceTimer = setTimeout(async () => {
        const query = aiSearchInput.value.trim();
        if (!query) {
          aiSearchResults.innerHTML = "";
          latestSearchResults = [];
          aiResultsPage = 1;
          searchSelectedIndexes.clear();
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          if (aiSearchResultsDropdown) aiSearchResultsDropdown.style.display = "none";
          activeResultIndex = -1;
          updateAiSearchNavButtons();
          return;
        }
        if (aiSearchStatus) aiSearchStatus.textContent = "در حال جست‌وجو…";
        // رفع باگ: باکس نتایج با display:none شروع می‌شود و قبلاً فقط در
        // حالت موفقیت‌آمیز (با نتیجه) باز می‌شد؛ در نتیجه هم پیام «در حال
        // جست‌وجو…» و هم پیام خطا (پایین، در catch) دیده نمی‌شدند و به نظر
        // می‌رسید تایپ‌کردن هیچ خروجی‌ای ندارد. الان همین‌جا باز می‌شود.
        if (aiSearchResultsDropdown) aiSearchResultsDropdown.style.display = "block";
        try {
          const { results, belowThreshold } = await semanticSearchPrecise(query, RERANK_CANDIDATES, aiSearchBookScope);
          // اگه در این فاصله کاربر متن رو پاک کرده یا چیز دیگه‌ای تایپ کرده،
          // این جواب دیگه منسوخ شده و نباید روی وضعیت فعلی بشینه.
          if (myToken !== searchToken) return;

          // آمار سایت: همین‌جا (بعد از دیبانس، وقتی جست‌وجو واقعاً اجرا
          // و جواب معتبرش دریافت شده - نه به‌ازای هر ضربه‌کلید) بهترین
          // جای ثبتِ «یک جست‌وجوی مفهومی»ه.
          if (typeof trackEvent === "function") {
            trackEvent("semanticSearch", query);
          }

          if (aiSearchStatus) {
            aiSearchStatus.textContent = belowThreshold ? "در آرشیو مطلب مرتبطی پیدا نشد. سؤال را کامل‌تر یا با کلمات دیگری بنویسید." : "";
          }
          latestSearchResults = results;
          aiResultsPage = 1;
          searchSelectedIndexes.clear();
          if (aiSearchResultsDropdown) aiSearchResultsDropdown.style.display = results.length > 0 || belowThreshold ? "block" : "none";
          activeResultIndex = -1;
          updateAiSearchNavButtons();
          renderAiResultsHtml();

          // بازنویسی سؤال: نتیجهٔ فعلی همین حالا نشان داده شد؛ اگر بازنویسی
          // رسید و نتیجه فرق کرد، فهرست به‌روز می‌شود (بدون معطل‌کردن کاربر).
          rewriteQueryAi(query)
            .then(async (extra) => {
              if (extra.length === 0 || myToken !== searchToken) return;
              const refined = await semanticSearchPrecise(query, RERANK_CANDIDATES, aiSearchBookScope, extra);
              if (myToken !== searchToken) return;
              const keyOf = (rows) => rows.map((r) => `${r.source}|${r.text.slice(0, 40)}`).join("\n");
              if (keyOf(refined.results) === keyOf(latestSearchResults) && refined.belowThreshold === belowThreshold) return;
              latestSearchResults = refined.results;
              aiResultsPage = 1;
              searchSelectedIndexes.clear();
              activeResultIndex = -1;
              if (aiSearchStatus) {
                aiSearchStatus.textContent = refined.belowThreshold
                  ? "در آرشیو مطلب مرتبطی پیدا نشد. سؤال را کامل‌تر یا با کلمات دیگری بنویسید."
                  : "نتایج با کمک بازنویسی سؤال به‌روز شد.";
              }
              if (aiSearchResultsDropdown) {
                aiSearchResultsDropdown.style.display = refined.results.length > 0 || refined.belowThreshold ? "block" : "none";
              }
              updateAiSearchNavButtons();
              renderAiResultsHtml();
            })
            .catch(() => {});
        } catch (err) {
          if (myToken !== searchToken) return;
          if (aiSearchStatus) aiSearchStatus.textContent = err.message || "در جست‌وجو خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
          // رفع باگ: همینجا هم باکس باید باز بماند تا پیام خطا دیده شود.
          if (aiSearchResultsDropdown) aiSearchResultsDropdown.style.display = "block";
          console.error(err);
        }
      }, 400); // debounce: صبر کن کاربر تایپش تموم بشه
    });

    // تیک‌زدن هر چک‌باکس، فقط انتخاب رو به‌روز می‌کنه؛ کلیک روی خودِ لینک
    // (برای رفتن به کتاب) دست‌نخورده می‌مونه چون این‌ها دو المان جدان.
    aiSearchResults.addEventListener("change", (e) => {
      const checkbox = e.target.closest(".ai-result-checkbox");
      if (!checkbox) return;
      const index = Number(checkbox.dataset.aiIndex);
      if (checkbox.checked) {
        searchSelectedIndexes.add(index);
      } else {
        searchSelectedIndexes.delete(index);
      }
    });

    // Item جدید (یکسان‌سازی با جست‌وجوی داخلی فایل): دکمهٔ سه‌نقطه، همون
    // جعبهٔ گزینه‌های (کپی/خروجی/نشانه) رو باز و بسته می‌کنه - عیناً
    // انگار خودِ کاربر رو برچسب "⚙️ گزینه‌ها"ی جعبه کلیک کرده.
    const aiSearchOptionsToggle = document.getElementById("aiSearchOptionsToggle");
    if (aiSearchOptionsToggle) {
      aiSearchOptionsToggle.addEventListener("click", () => {
        searchToolbar.open = !searchToolbar.open;
        aiSearchOptionsToggle.setAttribute("aria-expanded", String(searchToolbar.open));
      });
    }

    // Item جدید (بند ج - دکمهٔ چرخ‌دنده جدا): بزرگ‌نمایی کل تب دستیار
    // هوشمند + ترتیب نمایش نتایج - این دو، جدا از نوار عملیات ۹گانه‌ست.
    const aiSettingsGearToggle = document.getElementById("aiSettingsGearToggle");
    const aiSettingsGearPanel = document.getElementById("aiSettingsGearPanel");
    if (aiSettingsGearToggle && aiSettingsGearPanel) {
      aiSettingsGearToggle.addEventListener("click", () => {
        const isOpen = aiSettingsGearPanel.style.display !== "none";
        aiSettingsGearPanel.style.display = isOpen ? "none" : "block";
        aiSettingsGearToggle.setAttribute("aria-expanded", String(!isOpen));
      });

      document.addEventListener("click", (event) => {
        if (
          aiSettingsGearPanel.style.display !== "none" &&
          !aiSettingsGearPanel.contains(event.target) &&
          event.target !== aiSettingsGearToggle
        ) {
          aiSettingsGearPanel.style.display = "none";
          aiSettingsGearToggle.setAttribute("aria-expanded", "false");
        }
      });
    }

    // بزرگ‌نمایی: با CSS zoom روی کل تب دستیار هوشمند (aiPanel)، هم‌الگو
    // با بزرگ‌نمایی صفحهٔ کتاب در in-page-search.js.
    let aiZoomLevel = 1;
    const aiPanelEl = document.getElementById("aiSearchPanel");
    const aiZoomLevelLabel = document.getElementById("aiZoomLevel");

    function applyAiZoom() {
      if (aiPanelEl) aiPanelEl.style.zoom = aiZoomLevel === 1 ? "" : String(aiZoomLevel);
      if (aiZoomLevelLabel) aiZoomLevelLabel.textContent = `${Math.round(aiZoomLevel * 100)}٪`;
    }

    const aiZoomInButton = document.getElementById("aiZoomIn");
    if (aiZoomInButton) {
      aiZoomInButton.addEventListener("click", () => {
        aiZoomLevel = Math.min(1.5, Math.round((aiZoomLevel + 0.1) * 10) / 10);
        applyAiZoom();
      });
    }

    const aiZoomOutButton = document.getElementById("aiZoomOut");
    if (aiZoomOutButton) {
      aiZoomOutButton.addEventListener("click", () => {
        aiZoomLevel = Math.max(0.7, Math.round((aiZoomLevel - 0.1) * 10) / 10);
        applyAiZoom();
      });
    }

    const aiZoomResetButton = document.getElementById("aiZoomReset");
    if (aiZoomResetButton) {
      aiZoomResetButton.addEventListener("click", () => {
        aiZoomLevel = 1;
        applyAiZoom();
      });
    }

    // ترتیب نمایش نتایج: پیش‌فرض (بر اساس امتیاز تطابق، از قبل مرتب‌شده)
    // یا بر اساس عنوان کتاب (الفبایی فارسی).
    const aiResultsSortOrder = document.getElementById("aiResultsSortOrder");
    if (aiResultsSortOrder) {
      aiResultsSortOrder.addEventListener("change", () => {
        if (latestSearchResults.length === 0) return;

        if (aiResultsSortOrder.value === "book") {
          latestSearchResults = [...latestSearchResults].sort((a, b) => a.book.localeCompare(b.book, "fa"));
        } else {
          latestSearchResults = [...latestSearchResults].sort((a, b) => b.score - a.score);
        }

        aiResultsPage = 1;
        searchSelectedIndexes.clear();
        activeResultIndex = -1;
        updateAiSearchNavButtons();
        renderAiResultsHtml();
      });
    }

    // آیتم جدید: افزودن به آرشیو (⚙️) - فقط رو نتایج تیک‌خورده؛ اگه
    // هیچی تیک نخورده، رو همه‌ی نتایج فعلی.
    const aiAddToArchiveButton = document.getElementById("aiAddToArchive");
    if (aiAddToArchiveButton) {
      aiAddToArchiveButton.addEventListener("click", () => {
        if (typeof window.addItemsToArchiveGeneric !== "function") return;

        const source = searchSelectedIndexes.size > 0
          ? [...searchSelectedIndexes].sort((a, b) => a - b).map((i) => latestSearchResults[i]).filter(Boolean)
          : latestSearchResults;

        window.addItemsToArchiveGeneric(
          source.map((r) => ({ title: r.book, text: r.text, url: textFragmentUrl(encodeURI(r.source), r.text, r.page), page: r.page }))
        );

        const originalLabel = aiAddToArchiveButton.textContent;
        aiAddToArchiveButton.textContent = "افزوده شد!";
        setTimeout(() => { aiAddToArchiveButton.textContent = originalLabel; }, 1500);
      });
    }

    const aiOpenArchiveButton = document.getElementById("aiOpenArchive");
    if (aiOpenArchiveButton) {
      aiOpenArchiveButton.addEventListener("click", () => {
        if (typeof window.openArchivePanelGeneric === "function") {
          window.openArchivePanelGeneric();
        }
      });
    }

    // Item جدید: پیمایش بین نتایج شماره‌گذاری‌شده با دکمه‌های قبل/بعد -
    // نتیجهٔ فعال با اسکرول و یه کادر مشخص، هایلایت می‌شه.
    let activeResultIndex = -1;

    function updateAiSearchNavButtons() {
      const previousButton = document.getElementById("aiSearchPrevious");
      const nextButton = document.getElementById("aiSearchNext");
      const hasResults = latestSearchResults.length > 0;
      if (previousButton) previousButton.disabled = !hasResults;
      if (nextButton) nextButton.disabled = !hasResults;
    }

    function focusAiResult(index, direction) {
      const total = latestSearchResults.length;
      if (total === 0) return;

      const previousIndex = activeResultIndex;
      activeResultIndex = ((index % total) + total) % total;

      // نتیجهٔ فعال ممکن است در صفحهٔ دیگری باشد؛ صفحه را عوض می‌کنیم.
      const targetPage = Math.floor(activeResultIndex / AI_RESULTS_PER_PAGE) + 1;
      const pageChanged = targetPage !== aiResultsPage;
      if (pageChanged) aiResultsPage = targetPage;
      renderAiResultsHtml();

      const rows = [...aiSearchResults.querySelectorAll(".ai-search-result-row")];
      const activeRow = rows.find((row) => Number(row.dataset.aiRow) === activeResultIndex);
      const previousRow = rows.find((row) => Number(row.dataset.aiRow) === previousIndex);
      if (!activeRow) return;

      // فقط اسکرول داخلیِ خودِ بلوک شناور نتایج جابه‌جا می‌شه - نه
      // بلوک جستجو، نه کل صفحه - و دقیقاً به‌اندازهٔ فاصلهٔ واقعیِ بین
      // دو ردیف (نه یه عدد تقریبی که می‌تونست بلوک رو نصفه‌ونیمه
      // نشون بده).
      const dropdown = document.querySelector(".ai-search-results-dropdown");
      if (dropdown && direction && previousRow && !pageChanged && previousRow !== activeRow) {
        const delta = activeRow.getBoundingClientRect().top - previousRow.getBoundingClientRect().top;
        dropdown.scrollBy({ top: delta, behavior: "smooth" });
      } else if (dropdown && direction) {
        activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    const aiSearchPreviousButton = document.getElementById("aiSearchPrevious");
    if (aiSearchPreviousButton) {
      aiSearchPreviousButton.addEventListener("click", () => {
        if (latestSearchResults.length === 0) return;
        focusAiResult(activeResultIndex <= 0 ? latestSearchResults.length - 1 : activeResultIndex - 1, -1);
      });
    }

    const aiSearchNextButton = document.getElementById("aiSearchNext");
    if (aiSearchNextButton) {
      aiSearchNextButton.addEventListener("click", () => {
        if (latestSearchResults.length === 0) return;
        focusAiResult(activeResultIndex + 1, 1);
      });
    }
  }

  const aiChatForm = document.getElementById("aiChatForm");
  const aiChatInput = document.getElementById("aiChatInput");
  const aiChatOutput = document.getElementById("aiChatOutput");

  if (aiChatForm && aiChatInput && aiChatOutput) {
    let chatToken = 0; // همون منطق نسل، برای پرسش‌های پشت‌سرهم در تب گفت‌وگو
    // آیتم ب: محدودهٔ گفتگو - Set از کتاب‌های تیک‌خورده (خالی = کل آرشیو)
    // آیتم ۲ (بخش دوم): وقتی هرکدوم از پاپ‌آورهای این ردیف (⋮ عملیات یا
    // 📚 محدوده) بازه، بلوک هشدار/حالت‌پاسخ زیرش باید پایین‌تر بره -
    // وگرنه پاپ‌آور شناور روش می‌افته و روش رو می‌پوشونه.
    function adjustChatBottomBlockSpacing() {
      const bottomBlock = document.querySelector(".ai-chat-bottom-block");
      if (!bottomBlock) return;

      const openPopovers = [chatToolbar, document.getElementById("aiChatScopePanel")].filter(
        (el) => el && (el.open || (el.style && el.style.display === "flex"))
      );

      if (openPopovers.length > 0) {
        const tallest = Math.max(...openPopovers.map((el) => el.offsetHeight));
        bottomBlock.style.marginTop = `${tallest + 12}px`;
      } else {
        bottomBlock.style.marginTop = "";
      }
    }

    const aiChatBookScope = setupScopeSelector(
      "aiChatScopeToggle",
      "aiChatScopePanel",
      "aiChatScopeList",
      adjustChatBottomBlockSpacing
    );
    // Item جدید (گفتگوی ادامه‌دار): کل تبادل‌های همین نشست، به ترتیب -
    // هم برای نمایش هر تبادل زیر تبادل قبلی (نه جایگزینیش)، هم برای
    // ساخت history‌ای که به askQuestion داده می‌شه.
    const chatTurns = [];
    // Item جدید (بلوک ۲ - قابلیت انتخاب): کدام تبادل‌ها با چک‌باکس
    // علامت خورده‌اند - عملیات (کپی/خروجی/نشانه) فقط روی همین
    // زیرمجموعه اعمال می‌شه؛ اگه هیچی انتخاب نشده باشه، نوار پیام
    // می‌ده که اول انتخاب کنید.
    const chatSelectedIndexes = new Set();

    function syncChatCheckboxes() {
      aiChatOutput.querySelectorAll(".ai-chat-turn-checkbox").forEach((checkbox) => {
        const index = Number(checkbox.dataset.chatIndex);
        checkbox.checked = chatSelectedIndexes.has(index);
      });
    }

    aiChatOutput.addEventListener("change", (e) => {
      const checkbox = e.target.closest(".ai-chat-turn-checkbox");
      if (!checkbox) return;
      const index = Number(checkbox.dataset.chatIndex);
      if (checkbox.checked) {
        chatSelectedIndexes.add(index);
      } else {
        chatSelectedIndexes.delete(index);
      }
    });

    const chatToolbar = createAiToolbar(
      () =>
        [...chatSelectedIndexes]
          .sort((a, b) => a - b)
          .map((i) => chatTurns[i])
          .filter(Boolean)
          .map((turn) => {
            const sourcesLabel = formatSourcesInfoLineAi(turn.sourcesInfo);
            return {
              kind: "chat",
              // آیتم ۱۰: عنوان نشانه، اسم کتاب(های) واقعیِ استفاده‌شده‌ست -
              // نه خودِ سؤال - تا منبع واقعاً تو بلوک نشانه‌ها دیده بشه.
              title: sourcesLabel || "پاسخ آزاد (دانش عمومی)",
              text: `سؤال: ${turn.question}\n\nپاسخ: ${turn.answer}`,
              url: (turn.sourcesInfo && turn.sourcesInfo[0] && turn.sourcesInfo[0].entries && turn.sourcesInfo[0].entries[0] && turn.sourcesInfo[0].entries[0].url) || location.origin + location.pathname,
              question: turn.question,
              answer: turn.answer,
              sourcesInfo: turn.sourcesInfo,
              // آیتم ۱۳: وقتی از حالت «پاسخ آزاد» بوده (منبع واقعی‌ای در
              // کار نبوده)، این false می‌شه - تا نشانه‌ی ساخته‌شده از
              // این پاسخ، گزینه‌ی «بازکردن» غیرفعال داشته باشه.
              hasRealSource: !!(turn.sourcesInfo && turn.sourcesInfo.length > 0),
            };
          }),
      "ابتدا یک یا چند پرسش‌وپاسخ را با تیک انتخاب کنید",
      {
        selectAll: () => {
          chatSelectedIndexes.clear();
          chatTurns.forEach((_, i) => chatSelectedIndexes.add(i));
          syncChatCheckboxes();
        },
        clearSelection: () => {
          chatSelectedIndexes.clear();
          syncChatCheckboxes();
        },
        viewArchive: () => {
          if (typeof openChatArchivePanelAi === "function") {
            openChatArchivePanelAi();
          }
        },
      }
    );
    aiChatForm.appendChild(chatToolbar);

    // آیتم ۲ (بخش دوم): رویداد بومی toggle خودِ details - چه با کلیک
    // مستقیم، چه با تغییر برنامه‌ای .open از دکمهٔ ⋮ - همیشه فایر
    // می‌شه؛ همینه که برای جابه‌جایی بلوک هشدار زیرش استفاده می‌کنیم.
    chatToolbar.addEventListener("toggle", () => adjustChatBottomBlockSpacing());

    // Item جدید (بند س - یکپارچه‌سازی ردیف گفتگو): دکمهٔ سه‌نقطهٔ همین
    // ردیف، همون نوار عملیات (کپی/خروجی/نشانه) رو باز و بسته می‌کنه.
    const aiChatOptionsToggle = document.getElementById("aiChatOptionsToggle");
    if (aiChatOptionsToggle) {
      aiChatOptionsToggle.addEventListener("click", () => {
        chatToolbar.open = !chatToolbar.open;
        aiChatOptionsToggle.setAttribute("aria-expanded", String(chatToolbar.open));
      });
    }

    function renderChatTurns() {
      // Item جدید (سبک چت‌های امروزی): چون .ai-chat-output با
      // flex-direction:column-reverse رندر می‌شه، اینجا هم ترتیب رو
      // معکوس می‌سازیم (جدیدترین تبادل اول تو DOM) - نتیجه این می‌شه
      // که جدیدترین پیام همیشه پایین (نزدیک کادر پرسش) می‌مونه و
      // پیام‌های قدیمی‌تر به بالا هل داده می‌شن.
      aiChatOutput.innerHTML = [...chatTurns]
        .reverse()
        .map(
          (turn, displayIndex) => {
            const originalIndex = chatTurns.length - 1 - displayIndex;
            return `
            <div class="ai-chat-turn">
              <div class="ai-chat-turn-select">
                <input type="checkbox" class="ai-chat-turn-checkbox" data-chat-index="${originalIndex}" ${chatSelectedIndexes.has(originalIndex) ? "checked" : ""} title="انتخاب این پرسش‌وپاسخ" aria-label="انتخاب این پرسش‌وپاسخ">
              </div>
              <div class="ai-chat-bubble ai-chat-bubble-user">${escapeHtmlAi(turn.question)}</div>
              <div class="ai-chat-bubble ai-chat-bubble-assistant">
                ${freeAnswerBadgeHtmlAi(turn.mode)}
                <div>${linkifyAnswerAi(turn.answer)}</div>
                ${turn.sourceLinksHtml ? `<div class="ai-chat-sources">منابع: ${turn.sourceLinksHtml}</div>` : ""}
              </div>
            </div>
          `;
          }
        )
        .join("");
      // با column-reverse، scrollTop=0 یعنی «انتهای معکوس‌شده» - یعنی
      // دقیقاً همون‌جایی که جدیدترین پیام (اولین فرزند DOM) قرار داره.
      aiChatOutput.scrollTop = 0;
    }

    // Item جدید (آرشیو گفتگو باز باشد): وقتی کاربر از پنل آرشیو
    // «ادامهٔ گفتگو» رو می‌زنه، تبادل‌های اون گفتگوی آرشیوشده رو
    // به‌عنوان گفتگوی فعال فعلی برمی‌گردونیم - اگه گفتگوی فعلی هم
    // چیزی داشته باشه، اول خودش به آرشیو منتقل می‌شه تا از دست نره.
    document.addEventListener("ai-chat-continue-conversation", (event) => {
      archiveCurrentChatConversationAi(chatTurns);

      chatTurns.length = 0;
      chatSelectedIndexes.clear();
      (event.detail.turns || []).forEach((turn) => {
        chatTurns.push({
          question: turn.question,
          answer: turn.answer,
          mode: turn.mode || "grounded",
          sourceLinksHtml: formatSourcesInfoHtmlAi(turn.sourcesInfo),
          sourcesText: (turn.sourcesInfo || []).map((s) => s.book).join("، "),
          sourcesInfo: turn.sourcesInfo || [],
        });
      });

      renderChatTurns();
      aiChatInput.focus();
    });

    // Item جدید (بلوک اول - پیوست فایل/عکس): کاربر با ➕ یه عکس انتخاب
    // می‌کنه، به‌صورت base64 خونده و پیش‌نمایش داده می‌شه؛ موقع ارسال
    // پرسش بعدی، همراهش به دستیار فرستاده می‌شه.
    let pendingAttachment = null; // { mimeType, base64, name }

    // Item جدید: کلیک روی پیش‌نمایش کوچیک عکس، یه نمای کامل (تمام‌صفحه)
    // بازش می‌کنه - با کلیک روی هر جای اون نما، بسته می‌شه.
    function openImageLightbox(src) {
      let overlay = document.getElementById("aiChatImageLightbox");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "aiChatImageLightbox";
        overlay.className = "ai-chat-image-lightbox";
        overlay.innerHTML = `<img alt="نمای کامل عکس پیوست‌شده">`;
        overlay.addEventListener("click", () => {
          overlay.classList.remove("open");
        });
        document.body.appendChild(overlay);
      }
      overlay.querySelector("img").src = src;
      overlay.classList.add("open");
    }

    function renderAttachmentPreview() {
      const preview = document.getElementById("aiChatAttachmentPreview");
      if (!preview) return;

      if (!pendingAttachment) {
        preview.style.display = "none";
        preview.innerHTML = "";
        return;
      }

      const imageSrc = `data:${pendingAttachment.mimeType};base64,${pendingAttachment.base64}`;

      preview.style.display = "flex";
      preview.innerHTML = `
        <img src="${imageSrc}" alt="" title="برای دیدن نمای کامل کلیک کنید" style="cursor:zoom-in;">
        <span>${escapeHtmlAi(pendingAttachment.name)}</span>
        <button type="button" id="aiChatAttachmentRemove">حذف ✕</button>
      `;

      const previewImg = preview.querySelector("img");
      if (previewImg) {
        previewImg.addEventListener("click", () => openImageLightbox(imageSrc));
      }

      const removeButton = document.getElementById("aiChatAttachmentRemove");
      if (removeButton) {
        removeButton.addEventListener("click", () => {
          pendingAttachment = null;
          renderAttachmentPreview();
        });
      }
    }

    const aiChatAttachButton = document.getElementById("aiChatAttachButton");
    const aiChatAttachInput = document.getElementById("aiChatAttachInput");
    if (aiChatAttachButton && aiChatAttachInput) {
      aiChatAttachButton.addEventListener("click", () => aiChatAttachInput.click());

      aiChatAttachInput.addEventListener("change", () => {
        const file = aiChatAttachInput.files && aiChatAttachInput.files[0];
        aiChatAttachInput.value = ""; // برای این‌که انتخاب دوبارهٔ همون فایل هم change بزنه

        if (!file) return;

        if (!file.type.startsWith("image/")) {
          alert("فعلاً فقط پیوست‌کردن عکس پشتیبانی می‌شه.");
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(",")[1];
          pendingAttachment = { mimeType: file.type, base64, name: file.name };
          renderAttachmentPreview();
        };
        reader.readAsDataURL(file);
      });
    }

    // ارسال هم‌زمان: تا پایان پاسخ در حال پخش، ارسال غیرفعال است تا پاسخ اول
    // با پرسش دوم بی‌صدا گم نشود. متن پرسش دوم در کادر می‌ماند و پاک نمی‌شود.
    let chatBusy = false;
    const aiChatSubmitButton = aiChatForm.querySelector('button[type="submit"], button:not([type])');
    const aiChatIdlePlaceholder = aiChatInput.placeholder;
    const setChatBusy = (busy) => {
      chatBusy = busy;
      if (aiChatSubmitButton) aiChatSubmitButton.disabled = busy;
      aiChatInput.placeholder = busy ? "تا پایان پاسخ فعلی صبر کنید…" : aiChatIdlePlaceholder;
    };

    aiChatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (chatBusy) return;
      const question = aiChatInput.value.trim();
      if (!question) return;

      const attachmentForThisMessage = pendingAttachment;
      pendingAttachment = null;
      renderAttachmentPreview();

      const myToken = ++chatToken;
      // Item جدید: به‌جای پاک‌کردن گفتگوی قبلی، فقط یه نشونهٔ «در حال
      // پاسخ» زیرش اضافه می‌شه؛ سؤالات و جواب‌های قبلی همچنان دیده می‌شن.
      aiChatInput.value = "";
      renderChatTurns();
      aiChatOutput.insertAdjacentHTML(
        "afterbegin",
        `<div class="ai-chat-turn" id="aiChatPending-${myToken}">
          <div class="ai-chat-bubble ai-chat-bubble-user">${escapeHtmlAi(question)}</div>
          <div class="ai-chat-bubble ai-chat-bubble-assistant ai-chat-pending">در حال بررسی و تنظیم پاسخ…</div>
        </div>`
      );
      aiChatOutput.scrollTop = 0;

      setChatBusy(true);
      try {
        // Item جدید (گفتگوی ادامه‌دار): تاریخچهٔ تبادل‌های قبلی همین
        // نشست، جدا از پرسش فعلی، به askQuestion فرستاده می‌شه.
        const history = chatTurns.map((turn) => ({ question: turn.question, answer: turn.answer }));
        const chatModeInput = document.querySelector('input[name="aiChatMode"]:checked');
        const chatMode = chatModeInput ? chatModeInput.value : "grounded";

        // Item جدید (پخش تدریجی): از همون لحظه‌ای که اولین تکه‌ی پاسخ
        // می‌رسه، متن «در حال بررسی و تنظیم پاسخ…» رو با متنِ در حال
        // شکل‌گیریِ پاسخ جایگزین می‌کنیم - دیگه لازم نیست کاربر صبر کنه
        // تا کل پاسخ یک‌جا آماده بشه.
        let streamedBubbleEl = null;
        let streamedTextEl = null;
        const onDelta = (_chunk, soFar) => {
          if (myToken !== chatToken) return;
          if (!streamedBubbleEl) {
            const pendingTurnEl = document.getElementById(`aiChatPending-${myToken}`);
            streamedBubbleEl = pendingTurnEl ? pendingTurnEl.querySelector(".ai-chat-pending") : null;
            if (streamedBubbleEl) {
              streamedBubbleEl.classList.remove("ai-chat-pending");
              // در پاسخ آزاد، برچسب «مستند به آرشیو نیست» از همان ابتدای پخش دیده شود.
              streamedBubbleEl.innerHTML = `${freeAnswerBadgeHtmlAi(chatMode)}<div class="ai-chat-stream-text"></div>`;
              streamedTextEl = streamedBubbleEl.querySelector(".ai-chat-stream-text");
            }
          }
          if (streamedTextEl) streamedTextEl.textContent = soFar;
        };

        const { answer, sources } = await askQuestion(question, history, chatMode, attachmentForThisMessage, aiChatBookScope, onDelta);
        if (myToken !== chatToken) return; // پرسش جدیدتری در همین حین ارسال شده

        // Item جدید: فهرست یکتای کتاب‌هایی که پاسخ از آن‌ها گرفته شده -
        // عنوان هر کتاب فقط یک‌بار میاد، ولی اگه از دو صفحه/تکهٔ مختلف
        // همون کتاب استفاده شده باشه، هر دوشون (با لینک جدا) تو
        // entries همون کتاب نگه داشته می‌شن - نه این‌که وقوع دوم دور
        // انداخته بشه.
        const sourcesInfo = [];
        const bookIndexMap = new Map();
        sources.forEach((s) => {
          const entry = { page: s.page || null, url: textFragmentUrl(encodeURI(s.source), s.text, s.page) };

          if (!bookIndexMap.has(s.book)) {
            bookIndexMap.set(s.book, sourcesInfo.length);
            sourcesInfo.push({ book: s.book, entries: [entry] });
            return;
          }

          const existing = sourcesInfo[bookIndexMap.get(s.book)];
          // همون صفحه رو دوباره اضافه نکن (مثلاً دو تکه از یه صفحه)
          if (!existing.entries.some((e) => e.page === entry.page && e.url === entry.url)) {
            existing.entries.push(entry);
          }
        });

        // Item جدید: اگه پاسخ خودش می‌گه چیزی تو منابع یافت نشده، خط
        // «منابع» اصلاً ساخته نمی‌شه (خالی می‌مونه، و طبق رفع قبلی،
        // خط منابع وقتی خالیه اصلاً نمایش داده نمی‌شه).
        const sourceLinksHtml = answerIndicatesNotFoundAi(answer)
          ? ""
          : formatSourcesInfoHtmlAi(sourcesInfo);

        chatTurns.push({
          question,
          answer,
          mode: chatMode,
          sourceLinksHtml,
          sourcesText: sources.map((s) => s.source).join("، "),
          sourcesInfo,
        });
        renderChatTurns();
      } catch (err) {
        if (myToken !== chatToken) return;
        const pendingTurnEl = document.getElementById(`aiChatPending-${myToken}`);
        const pendingEl = pendingTurnEl ? pendingTurnEl.querySelector(".ai-chat-pending") : null;
        const message = err.message || "در دریافت پاسخ خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
        if (pendingEl) {
          pendingEl.textContent = message;
          pendingEl.classList.add("ai-chat-error");
        } else {
          aiChatOutput.insertAdjacentHTML("afterbegin", `<div class="ai-chat-error">${escapeHtmlAi(message)}</div>`);
        }
        console.error(err);
      } finally {
        setChatBusy(false);
      }
    });

    // Item جدید: گفتگوی جدید - قبل از خالی‌کردن گفتگوی فعلی، کل آن
    // (اگه خالی نبود) به‌عنوان یک آیتم کامل به آرشیو گفتگوها منتقل
    // می‌شه - دقیقاً مثل محیط‌های چت معمولی که با «گفتگوی جدید» زدن،
    // گفتگوی قبلی از دست نمی‌ره، فقط به تاریخچه/آرشیو می‌ره.
    const aiChatResetButton = document.getElementById("aiChatResetButton");
    if (aiChatResetButton) {
      aiChatResetButton.addEventListener("click", () => {
        archiveCurrentChatConversationAi(chatTurns);
        chatTurns.length = 0;
        chatSelectedIndexes.clear();
        aiChatOutput.innerHTML = "";
      });
    }

    const aiChatArchiveOverlayEl = document.getElementById("aiChatArchiveOverlay");
    if (aiChatArchiveOverlayEl) {
      aiChatArchiveOverlayEl.addEventListener("click", (event) => {
        if (event.target === aiChatArchiveOverlayEl) {
          closeChatArchivePanelAi();
        }
      });
    }
  }
});
