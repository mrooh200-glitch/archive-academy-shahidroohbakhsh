/**
 * build-embeddings.js
 *
 * این اسکریپت روی GitHub Actions اجرا می‌شه (نه سیستم شخصی).
 * کارش: خوندن همهٔ فایل‌های .htm کتاب‌ها، تقسیم متن به بخش‌های کوچک،
 * و ساخت بردار معنایی (embedding) برای هر بخش با Cloudflare Workers AI (مدل BGE-M3).
 * نتیجه در فایل embeddings.json ذخیره می‌شه.
 *
 * Item جدید (بهینه‌سازی مصرف Workers AI): این نسخه دیگه هر بار همهٔ
 * تکه‌های متن رو از نو embed نمی‌کنه. embeddings.json قبلی رو می‌خونه،
 * و برای هر تکه‌ای که متنش دقیقاً با دفعهٔ قبل یکیه، بردار قبلی‌ش رو
 * دوباره استفاده می‌کنه (بدون تماس با API). فقط تکه‌های واقعاً جدید یا
 * تغییرکرده به Cloudflare فرستاده می‌شن. این هم سهمیهٔ رایگان روزانهٔ
 * نورون رو صرفه‌جویی می‌کنه، هم اجرای اسکریپت رو سریع‌تر می‌کنه.
 *
 * توجه: چون تکه‌بندی بر اساس ترتیب پاراگراف‌هاست، اگه یک پاراگراف اول
 * فایل تغییر کنه، ممکنه مرز تکه‌های بعدی هم جابه‌جا بشه و آنها هم
 * (درست، نه اشتباه) دوباره embed بشن. این طبیعیه و رفتار درستیه.
 *
 * اجرا: node scripts/build-embeddings.js
 * نیاز به دو متغیر محیطی: CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("خطا: متغیرهای CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN تنظیم نشدن.");
  process.exit(1);
}

const REPO_ROOT = path.join(__dirname, ".."); // فرض: این اسکریپت در scripts/ داخل ریشهٔ مخزن قرار داره
const OUTPUT_FILE = path.join(REPO_ROOT, "embeddings.json");
// فایل کوچک نسخه که سمت مرورگر (search-widget.js) برای تشخیص «آیا embeddings.json
// عوض شده یا نه» می‌خونه، به‌جای تکیه به هدرهای HTTP نامطمئن GitHub Pages.
const VERSION_FILE = path.join(REPO_ROOT, "embeddings-version.json");

// حداقل و حداکثر طول هر تکه متن (بر حسب کاراکتر، نه توکن -- تقریبی)
const MIN_CHUNK_LENGTH = 100;
const MAX_CHUNK_LENGTH = 800;

// ---------- ۱. پیدا کردن فایل‌های htm کتاب‌ها ----------
function findHtmFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    // پوشه‌های node_modules، .git و غیره رو نادیده بگیر. پوشه‌ی «aa»
    // هم عمداً همین‌جا کنار گذاشته می‌شه: زیرپوشه‌های ref (پاورقی‌های
    // چاپیِ کتاب اصول اعتقادی) و s (مطالعات تکمیلیِ مخصوص کیوآر) توش
    // فایل‌های HTMLِ مستقلِ ارجاع/مستندات با آدرسِ کوتاهِ عددی
    // (مثل aa/ref/t1.html یا aa/s/1.html) نگه‌داری می‌شن که قراره فقط با
    // لینکِ مستقیم در دسترس باشن، نه این‌که تو جست‌وجوی سایت
    // (متنی/مفهومی) یا فهرستِ مقاله‌ها ظاهر بشن. با اضافه شدن کتاب‌های
    // بعدی، پوشه‌ی مخفف هر کتاب باید همین‌جا هم اضافه بشه.
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".github", "scripts", "aa"].includes(entry.name)) continue;
      files = files.concat(findHtmFiles(path.join(dir, entry.name)));
    } else if (
      entry.name.toLowerCase() === "index.htm" ||
      entry.name.toLowerCase() === "index.html" ||
      entry.name.toLowerCase() === "stats.html"
    ) {
      // فایل index.htm/index.html (خود سایت) و stats.html (صفحهٔ آمار
      // سایت) رو رد کن - این‌ها کتاب نیستن و نباید تو جست‌وجوی معنایی/
      // نتایج ظاهر بشن.
      continue;
    } else if (entry.name.toLowerCase().endsWith(".htm") || entry.name.toLowerCase().endsWith(".html")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// ---------- ۲. خوندن نگاشت «اسم فایل → عنوان فارسی» از خودِ index.htm ----------
// index.htm از قبل یه لیست دستی و دقیق از عنوان‌های فارسی/عربی هر کتاب داره
// (همون data-title که جست‌وجوی متنی سایت هم ازش استفاده می‌کنه). به‌جای حدس‌زدن
// عنوان از داخل خودِ فایل htm هر کتاب، همین‌جا رو منبع اصلی و قابل‌اعتماد می‌گیریم.
function loadTitleIndexFromSiteIndex() {
  const map = new Map();
  const indexPath = path.join(REPO_ROOT, "index.htm");

  if (!fs.existsSync(indexPath)) {
    console.warn("هشدار: index.htm پیدا نشد؛ عنوان‌ها به تگ <title> یا اسم فایل برمی‌گردن.");
    return map;
  }

  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const $ = cheerio.load(raw);
    $("li.searchable-item[data-url]").each((_, el) => {
      const url = $(el).attr("data-url");
      const title = $(el).attr("data-title");
      if (url && title && !url.toLowerCase().endsWith(".pdf")) {
        map.set(path.basename(url), title.trim());
      }
    });
  } catch (err) {
    console.warn("هشدار: خوندن index.htm ناموفق بود؛ عنوان‌ها به <title> یا اسم فایل برمی‌گردن.", err.message);
  }

  return map;
}

// ---------- ۳. تشخیص این‌که آیا تگ <title> واقعاً عنوان کتابه یا باقیمانده‌ی یه ابزار/افزونه ----------
// بعضی از خروجی‌های Word (مثلاً افزونه‌های فارسی‌ساز فاصله‌گذاری) به‌جای عنوان واقعی،
// اسم یه دستور یا ماکرو داخلی رو تو تگ <title> می‌ذارن. این تابع همچین حالت‌هایی رو تشخیص می‌ده.
function looksLikeToolArtifactTitle(title) {
  const junkPatterns = [
    /فاصله[\s\S]*ورد/, // مثلاً «حذف فاصله مخفی‌ها ... برای ورد»
    /ورد[\s\S]*فاصله/,
    /^document\d*$/i,
    /^untitled/i,
    /^microsoft\s*word/i,
  ];
  return junkPatterns.some((re) => re.test(title));
}

// ---------- ۴. تعیین عنوان نهایی کتاب، با اولویت: ایندکس دستی سایت ← <title> معتبر ← اسم فایل ----------
// توجه: قبلاً اینجا یه heuristic هم بود که وقتی <title> معتبر نبود، سعی می‌کرد از
// روی بزرگ‌ترین فونتِ پاراگراف‌های ابتدای سند عنوان رو حدس بزنه. اون روش حذف شد،
// چون هم گاهی جمله‌های مهمِ متن اصلی (نه فقط عنوان) رو با فونت بزرگ اشتباه می‌گرفت،
// هم تو بعضی فایل‌ها ترتیب حروف رو به‌هم می‌ریخت. الان اولویت اول، همون عنوانیه که
// خودِ شما تو index.htm برای این کتاب تعریف کردید (titleIndex) — چون قبلاً دستی و
// دقیق تأیید شده، بدون هیچ حدسی. اگه کتاب تو titleIndex نبود، به <title> فایل و
// در آخر به اسم فایل برمی‌گردیم.
function extractBookTitle($, filePath, titleIndex) {
  const fromSiteIndex = titleIndex.get(path.basename(filePath));
  if (fromSiteIndex) return fromSiteIndex;

  const titleTag = $("title").text().replace(/\s+/g, " ").trim();
  if (titleTag && !looksLikeToolArtifactTitle(titleTag)) {
    return titleTag;
  }

  return path.basename(filePath, path.extname(filePath));
}

// ---------- ۵. استخراج عنوان و «واحدهای» متن از هر فایل htm ----------
// هر فایل به چند «واحد» تقسیم می‌شود: متنِ بین دو عنوان (h1..h6). عنوان‌ها
// (مثل فصل، خطبه، نامه، حکمت) به‌صورت زنجیرهٔ زمینه کنار هر تکه می‌مانند تا
// هنگام ساخت بردار به ابتدای متن اضافه شوند (نه به متن نمایشی). عنوان‌هایی که
// واحد قبلی هنوز کوتاه‌تر از MIN_CHUNK_LENGTH است، مرز جدید نمی‌سازند و فقط به
// زمینه اضافه می‌شوند. نشانگرهای صفحهٔ «ص:۳۶» که در نهج‌البلاغه پاراگراف جدا
// هستند و جمله را وسط می‌شکنند حذف می‌شوند. فایل‌های بدون عنوان یک واحد دارند.
// شمارهٔ صفحهٔ چاپی (section.page[data-display]) مثل قبل از اولین پاراگراف
// هر تکه خوانده می‌شود؛ data-display="0" (جلد) نادیده است.
// حالت تکه‌بندی: "light" (پیش‌فرض) = فقط نرمال‌سازی و حذف نشانگر صفحه، بدون برش ساختاری،
// زمینهٔ عنوان و هم‌پوشانی؛ "full" = همهٔ آن‌ها. ارزیابی نشان داد "full" دقت را کم می‌کند.
const CHUNK_MODE = process.env.CHUNK_MODE === "full" ? "full" : "light";
const PAGE_MARKER_RE = /^ص\s*[:：]\s*[\d۰-۹٠-٩]+$/;
const IGNORED_HEADINGS = new Set(["اشاره"]);

function extractBookUnits(filePath, titleIndex) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(raw);
  const title = extractBookTitle($, filePath, titleIndex);

  const chain = []; // chain[level-1] = متن عنوان فعلی آن سطح
  const units = [];
  let cur = { chain: [], extraTitles: [], paragraphs: [], length: 0 };
  const flush = () => {
    if (cur.paragraphs.length > 0) units.push(cur);
    cur = { chain: chain.filter(Boolean), extraTitles: [], paragraphs: [], length: 0 };
  };

  $("h1,h2,h3,h4,h5,h6,p").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    if (tag[0] === "h") {
      if (CHUNK_MODE !== "full") return;
      if ($(el).parents("h1,h2,h3,h4,h5,h6").length) return;
      if (IGNORED_HEADINGS.has(text)) return;
      const level = Number(tag[1]);
      chain.length = level - 1;
      chain[level - 1] = text;
      if (cur.length >= MIN_CHUNK_LENGTH) flush();
      else if (cur.paragraphs.length > 0) cur.extraTitles.push(text);
      else cur.chain = chain.filter(Boolean);
      return;
    }

    if ($(el).parents("h1,h2,h3,h4,h5,h6").length) return;
    if (PAGE_MARKER_RE.test(text)) return;
    const pageSection = $(el).closest("section.page[data-display]");
    const rawPage = pageSection.length ? pageSection.attr("data-display") : null;
    const page = rawPage && rawPage !== "0" ? rawPage : null;
    cur.paragraphs.push({ text, page });
    cur.length += text.length;
  });
  flush();

  // اگه هیچ <p> پیدا نشد (ساختار متفاوت بود)، کل متن body رو بگیر و بر اساس خط جدید تقسیم کن
  if (units.length === 0) {
    const bodyText = $("body").text();
    const paragraphs = bodyText
      .split(/\n+/)
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0 && !PAGE_MARKER_RE.test(t))
      .map((text) => ({ text, page: null }));
    if (paragraphs.length > 0) units.push({ chain: [], extraTitles: [], paragraphs, length: 0 });
  }

  return { title, units };
}

// ---------- نرمال‌سازی متن برای بردارسازی ----------
// فقط برای ساخت بردار (متن نمایشی دست‌نخورده می‌ماند): اعراب و کشیده حذف و
// حروف هم‌شکل یکسان می‌شوند. باید دقیقاً هم‌ارز embedNormalize در
// search-widget.js بماند (پرسش کاربر هم با همان تابع نرمال می‌شود).
function embedNormalize(text) {
  return String(text || "")
    .replace(/[\u064B-\u065F\u0670\u0640\u06D6-\u06ED]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ی")
    .replace(/ء/g, "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- ۶. تبدیل واحدها به تکه‌های (chunk) با طول مناسب ----------
// تکه‌ها هرگز از مرز یک واحد (عنوان) رد نمی‌شوند. داخل یک واحد، پاراگراف‌ها تا
// سقف MAX_CHUNK_LENGTH کنار هم می‌آیند و هم‌پوشانی دارند: آخرین پاراگراف کوتاه
// (حداکثر OVERLAP_MAX_LENGTH کاراکتر) هر تکه ابتدای تکهٔ بعدیِ همان واحد هم
// تکرار می‌شود تا مطلبِ روی مرز گم نشود. زمینه (book › chain) جدا برمی‌گردد.
const OVERLAP_MAX_LENGTH = 200;

function chunkUnits(bookTitle, units) {
  const chunks = [];
  for (const unit of units) {
    const ctxParts = [bookTitle, ...unit.chain].filter((p, i, a) => p && a.indexOf(p) === i);
    let ctx = ctxParts.join(" › ");
    if (unit.extraTitles.length > 0) ctx += " | " + unit.extraTitles.join(" | ");
    ctx = CHUNK_MODE === "full" ? ctx.slice(0, 300) : "";

    let current = "";
    let currentPage = null;
    let lastPara = null;
    let paraCount = 0; // تعداد پاراگراف‌های تازه (بدون هم‌پوشانی) در تکهٔ جاری

    for (const para of unit.paragraphs) {
      if (current && (current + " " + para.text).length > MAX_CHUNK_LENGTH && current.length >= MIN_CHUNK_LENGTH) {
        chunks.push({ text: current.trim(), page: currentPage, ctx });
        if (CHUNK_MODE === "full" && lastPara && lastPara.text.length <= OVERLAP_MAX_LENGTH && paraCount > 1) {
          current = lastPara.text + " " + para.text;
          currentPage = lastPara.page;
        } else {
          current = para.text;
          currentPage = para.page;
        }
        paraCount = 1;
      } else {
        if (!current) currentPage = para.page;
        current = current ? current + " " + para.text : para.text;
        paraCount++;
      }
      lastPara = para;
    }
    if (current.trim().length > 0) chunks.push({ text: current.trim(), page: currentPage, ctx });
  }
  return chunks;
}

// ---------- ۴. فراخوانی Cloudflare Workers AI برای گرفتن بردار ----------
async function embedBatch(texts) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare AI error (${res.status}): ${errText}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`Cloudflare AI returned failure: ${JSON.stringify(json.errors)}`);
  }

  // خروجی مدل bge-m3 در Workers AI به‌صورت { result: { data: [[...],[...]] } } برمی‌گرده
  return json.result.data;
}

// ---------- ۵الف. کلید یکتا برای هر تکه (برای تشخیص «همون تکهٔ قبلیه») ----------
// source + متن دقیق تکه، چون اگه حتی یک کلمه عوض بشه باید دوباره embed بشه.
// متنِ واقعیِ بردارسازی = زمینه + متن، نرمال‌شده؛ کلید روی هش همین متن است (نه متن نمایشی)،
// پس تغییر نرمال‌سازی یا زمینه هم تکه را «تغییرکرده» حساب می‌کند.
function embedTextOf(chunk) {
  return embedNormalize(chunk.ctx ? `${chunk.ctx}\n${chunk.text}` : chunk.text);
}

function embedHash(embedText) {
  return crypto.createHash("sha1").update(embedText).digest("hex").slice(0, 12);
}

function chunkKey(sourceFile, hash) {
  return `${sourceFile}:::${hash}`;
}

// ---------- ۵ب. خوندن embeddings.json قبلی (اگه وجود داشته باشه) ----------
// و ساخت یک Map از کلید تکه -> رکورد کامل قبلی (شامل بردار base64)،
// تا بشه بردارهای تکه‌های تغییرنکرده رو بدون تماس با API دوباره استفاده کرد.
function loadPreviousEmbeddingsMap() {
  const map = new Map();
  if (!fs.existsSync(OUTPUT_FILE)) return map;

  try {
    const prevRaw = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const prevData = JSON.parse(prevRaw);
    for (const item of prevData) {
      if (item.h) map.set(chunkKey(item.source, item.h), item);
    }
  } catch (err) {
    console.warn("هشدار: خوندن embeddings.json قبلی ناموفق بود، همه‌چیز از نو embed می‌شه.", err.message);
  }
  return map;
}

// ---------- ۵ج. فشرده‌سازی بردار به base64 (به‌جای آرایهٔ متنی اعداد) ----------
// یک بردار ۱۰۲۴ عددی به‌صورت متن JSON خیلی حجیم می‌شه (هر عدد با کلی رقم اعشار).
// با تبدیل به Float32Array و بعد base64، حجم حدود ۳ تا ۴ برابر کوچیک‌تر می‌شه.
function vectorToBase64(vector) {
  const floatArray = new Float32Array(vector);
  return Buffer.from(floatArray.buffer).toString("base64");
}

// ---------- ۶. تابع اصلی ----------
async function main() {
  console.log("در حال جست‌وجوی فایل‌های htm...");
  const files = findHtmFiles(REPO_ROOT);
  console.log(`${files.length} فایل پیدا شد:`, files.map((f) => path.basename(f)));

  const titleIndex = loadTitleIndexFromSiteIndex();
  console.log(`${titleIndex.size} عنوان از index.htm خونده شد.`);

  const allChunks = []; // { book, source, text, page }

  for (const file of files) {
    const { title: bookName, units } = extractBookUnits(file, titleIndex);
    const chunks = chunkUnits(bookName, units);
    const paragraphCount = units.reduce((n, u) => n + u.paragraphs.length, 0);
    console.log(`  ${bookName}: ${paragraphCount} پاراگراف، ${units.length} واحد → ${chunks.length} تکه`);
    // رفع باگ: قبلاً فقط اسم فایل (بدون نام پوشه) ذخیره می‌شد، پس برای
    // کتاب‌هایی که داخل یک زیرپوشه‌ن (مثل Seyed_Kazem_Roohbakhsh/...)
    // لینک نتیجهٔ جست‌وجو به‌جای مسیر واقعی، به ریشهٔ سایت اشاره می‌کرد و
    // با خطای ۴۰۴ روبه‌رو می‌شد. الان مسیر نسبی کامل (از ریشهٔ مخزن)
    // ذخیره می‌شه تا لینک همیشه درست باشه.
    const relativeSource = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    for (const chunk of chunks) {
      allChunks.push({ book: bookName, source: relativeSource, text: chunk.text, page: chunk.page, ctx: chunk.ctx });
    }
  }

  console.log(`جمع کل: ${allChunks.length} تکه متن.`);

  // ---------- تفکیک تکه‌های «قبلاً embed شده و بدون تغییر» از «جدید/تغییرکرده» ----------
  const previousMap = loadPreviousEmbeddingsMap();
  const results = new Array(allChunks.length); // نتیجهٔ نهایی، هم‌ترتیب با allChunks
  const toEmbed = []; // { index, text } — فقط اونایی که واقعاً باید به API فرستاده بشن

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    chunk.embedText = embedTextOf(chunk);
    chunk.h = embedHash(chunk.embedText);
    const key = chunkKey(chunk.source, chunk.h);
    const prev = previousMap.get(key);

    if (prev && prev.vector) {
      // این تکه دقیقاً قبلاً هم بوده و متنش عوض نشده -- بردار قبلی رو نگه دار
      results[i] = { book: chunk.book, source: chunk.source, text: chunk.text, page: chunk.page, h: chunk.h, vector: prev.vector };
    } else {
      toEmbed.push({ index: i, text: chunk.embedText });
    }
  }

  console.log(
    `${allChunks.length - toEmbed.length} تکه بدون تغییر (بردار قبلی دوباره استفاده شد)، ` +
      `${toEmbed.length} تکه جدید/تغییرکرده باید embed بشه.`
  );

  if (toEmbed.length === 0) {
    console.log("هیچ تکهٔ جدیدی برای embed کردن نیست. فقط embeddings.json با همون محتوای قبلی بازنویسی می‌شه.");
  } else {
    // ساخت بردار به‌صورت دسته‌ای (batch) برای جلوگیری از تعداد زیاد درخواست
    const BATCH_SIZE = 20;

    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      console.log(`  ساخت بردار برای بخش ${i + 1} تا ${i + batch.length} از ${toEmbed.length} تکهٔ جدید...`);

      const vectors = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const originalIndex = batch[j].index;
        const chunk = allChunks[originalIndex];
        results[originalIndex] = {
          book: chunk.book,
          source: chunk.source,
          text: chunk.text,
          page: chunk.page,
          h: chunk.h,
          vector: vectorToBase64(vectors[j]),
        };
      }
    }
  }

  const resultsJson = JSON.stringify(results);
  fs.writeFileSync(OUTPUT_FILE, resultsJson);

  // نسخه = هش محتوای واقعی. یعنی اگه حتی یک کلمه از یک تکه عوض بشه،
  // نسخه هم عوض می‌شه و مرورگرها کش قدیمی‌شون رو باطل می‌کنن؛ اگه هیچی
  // عوض نشده باشه، نسخه هم یکی می‌مونه و کاربرها دوباره دانلود نمی‌کنن.
  const versionHash = crypto.createHash("sha256").update(resultsJson).digest("hex").slice(0, 16);
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: versionHash, builtAt: new Date().toISOString() }));

  console.log(`تمام شد! ${results.length} بردار در ${OUTPUT_FILE} ذخیره شد. نسخه: ${versionHash}`);
}

main().catch((err) => {
  console.error("خطا در اجرای اسکریپت:", err);
  process.exit(1);
});
