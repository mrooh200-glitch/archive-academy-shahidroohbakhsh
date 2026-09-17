/**
 * Cloudflare Worker
 *
 * دو endpoint داره:
 *  - POST /embed  → عبارت جست‌وجوی کاربر رو می‌گیره، بردارش رو با BGE-M3 برمی‌گردونه
 *  - POST /chat   → سؤال کاربر + متن‌های مرتبط رو می‌گیره، از Gemini پاسخ می‌گیره و برمی‌گردونه
 *
 * متغیر محیطی لازم (در wrangler.toml یا Cloudflare Dashboard تنظیم می‌شه):
 *  - GEMINI_API_KEY
 *  - AI (binding خودکار Workers AI، نیازی به کلید نداره)
 *  - EMBEDDING_CACHE (یک KV namespace — اختیاری؛ اگه بایند نشده باشه، کد بدون کش کار می‌کنه)
 *  - STATS_KV (یک KV namespace دیگه، جدا از EMBEDDING_CACHE — اختیاری؛ برای مورد ۸
 *    «آمار سایت». اگه بایند نشه، endpointهای /track و /stats بی‌خطا کار می‌کنن ولی
 *    چیزی ثبت/برنمی‌گردونن.)
 *  - STATS_RESET_KEY (یک رمزِ دلخواه، به‌عنوان Secret تنظیم می‌شه - نه بایند KV؛
 *    برای endpoint جدید POST /reset-stats که کل آمار رو صفر می‌کنه. اگه تنظیم
 *    نشه، این endpoint کلاً غیرفعاله.)
 *
 * فرم «ارتباط با ما» (POST /contact): پیام رو به مدیر سایت، از طریق
 * تلگرام می‌فرسته (این سایت بخش کتب جداگانه نداره، پس فقط یک مقصده).
 * متغیرهای لازم (هر دو Secret، در Cloudflare):
 *  - TG_BOT_TOKEN, TG_CHAT_ID
 *
 * تغییر جدید: کش مشترک بین همه‌ی کاربران برای عبارت‌های جست‌وجوی تکراری.
 * اگه کاربر A عبارتی رو جست‌وجو کنه، بردارش برای مدتی (یک ساعت) در KV ذخیره می‌شه؛
 * اگه کاربر B دقیقاً همون عبارت رو جست‌وجو کنه، به‌جای زدن دوباره به مدل bge-m3
 * (که سهمیه‌ی روزانه مصرف می‌کنه)، همون بردار کش‌شده مستقیم برگردونده می‌شه.
 *
 * تغییر جدید (تکمیل فیلدهای آمار): POST /track دیگه فقط pageview/search/
 * download رو نمی‌شناسه - این انواع هم اضافه شدن: chat (سؤالِ تب گفتگو با
 * هوش)، semanticSearch (پرس‌وجوی تب جست‌وجوی مفهومی)، bookmark (افزودن به
 * نشانه‌ها)، archive (افزودن به آرشیو)، export (خروجی‌گرفتنِ سه‌گانه -
 * detail باید یکی از pdf/word/text باشه). فهرست کامل و نگاشتِ هرکدوم به
 * فیلدهای خروجیِ /stats در آرایهٔ EVENT_TYPES پایین همین فایله.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // اگه خواستی امن‌تر بشه، به‌جای * آدرس دقیق سایتت رو بذار
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EMBEDDING_CACHE_TTL_SECONDS = 60 * 60; // یک ساعت

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------- ساخت کلید کش از متن عبارت (نرمال‌سازی ساده: trim + یکسان‌سازی حروف) ----------
async function embeddingCacheKey(text) {
  const normalized = text.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "embed:" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    // درخواست‌های preflight مرورگر (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/embed" && request.method === "POST") {
        return await handleEmbed(request, env);
      }

      if (url.pathname === "/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      // Item ۸ (آمار سایت): دو endpoint جدید - یکی برای ثبت یک رویداد
      // (بازدید صفحه، جست‌وجو، دانلود)، یکی برای خواندن جمع آن‌ها.
      if (url.pathname === "/track" && request.method === "POST") {
        return await handleTrack(request, env);
      }

      if (url.pathname === "/stats" && request.method === "GET") {
        return await handleStats(request, env);
      }

      // Item جدید (ریست آمار): یک راه برای صفرکردن کامل آمار، بدون نیاز
      // به رفتن به داشبورد Cloudflare و حذف دستیِ تک‌تک کلیدهای KV.
      if (url.pathname === "/reset-stats" && request.method === "POST") {
        return await handleResetStats(request, env);
      }

      // فرم «ارتباط با ما»: پیام رو به تلگرام/ایتا (بسته به موضوع) می‌فرسته.
      if (url.pathname === "/contact" && request.method === "POST") {
        return await handleContact(request, env);
      }

      return jsonResponse({ error: "مسیر یا متد نامعتبر" }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "خطای داخلی سرور", detail: String(err) }, 500);
    }
  },
};

// ---------- /embed : ساخت بردار عبارت جست‌وجو (با کش مشترک بین کاربران) ----------
async function handleEmbed(request, env) {
  const body = await request.json();
  const query = (body.query || "").trim();

  if (!query) {
    return jsonResponse({ error: "پارامتر query لازمه" }, 400);
  }

  // اول کش رو چک کن — اگه یک کاربر دیگه اخیراً دقیقاً همین عبارت رو جست‌وجو کرده،
  // بردارش رو مستقیم برگردون، بدون تماس با مدل.
  let cacheKey = null;
  if (env.EMBEDDING_CACHE) {
    cacheKey = await embeddingCacheKey(query);
    const cached = await env.EMBEDDING_CACHE.get(cacheKey, "json");
    if (cached) {
      return jsonResponse({ vector: cached });
    }
  }

  const result = await env.AI.run("@cf/baai/bge-m3", { text: [query] });
  // result.data شکل [[...vector...]] داره چون یک متن فرستادیم
  const vector = result.data[0];

  if (env.EMBEDDING_CACHE && cacheKey) {
    await env.EMBEDDING_CACHE.put(cacheKey, JSON.stringify(vector), {
      expirationTtl: EMBEDDING_CACHE_TTL_SECONDS,
    });
  }

  return jsonResponse({ vector });
}

// ---------- تلاش دوباره برای خطاهای موقتی Gemini (کد 503 / status UNAVAILABLE) ----------
// این فقط دورِ خودِ تماس با Gemini رو می‌گیره؛ به بقیهٔ کد کاری نداره.
// اگه بار اول موفق بشه (حالت معمول)، هیچ تأخیر اضافه‌ای ایجاد نمی‌کنه.
async function fetchGeminiWithRetry(geminiUrl, requestBody, maxAttempts = 3) {
  let lastRes;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (lastRes.ok) return lastRes;

    // فقط برای خطای 503 (شلوغی موقت مدل) دوباره تلاش کن؛ بقیهٔ خطاها
    // (مثلاً کلید نامعتبر) با تلاش دوباره درست نمی‌شن، پس فوراً برگردون.
    if (lastRes.status !== 503 || attempt === maxAttempts) return lastRes;

    await new Promise((r) => setTimeout(r, 500 * attempt)); // کمی صبر قبل از تلاش بعدی
  }
  return lastRes;
}

// ---------- /chat : پاسخ‌سازی با Gemini بر اساس متن‌های مرتبط ----------
async function handleChat(request, env) {
  const body = await request.json();
  const question = (body.question || "").trim();
  const contextChunks = Array.isArray(body.context) ? body.context : [];
  // Item جدید (دو حالت پاسخ): "grounded" (پیش‌فرض، فقط بر اساس متون
  // آرشیو) یا "general" (پاسخ آزاد - دانش عمومی Gemini، بدون محدودیت
  // به متون؛ مناسب برای سلام‌واحوال‌پرسی و سؤال‌های عمومی).
  const mode = body.mode === "general" ? "general" : "grounded";
  // Item جدید (گفتگوی ادامه‌دار): تاریخچهٔ تبادل‌های قبلی همین نشست
  // (بدون سؤال فعلی) - هر آیتم باید {question, answer} با متن غیرخالی
  // باشه؛ هر آیتم ناقص یا نامعتبر نادیده گرفته می‌شه، نه این‌که کل
  // درخواست رد بشه.
  const history = Array.isArray(body.history)
    ? body.history
        .map((turn) => ({
          question: typeof turn?.question === "string" ? turn.question.trim() : "",
          answer: typeof turn?.answer === "string" ? turn.answer.trim() : "",
        }))
        .filter((turn) => turn.question && turn.answer)
    : [];

  if (!question) {
    return jsonResponse({ error: "پارامتر question لازمه" }, 400);
  }
  // Item جدید: نیاز به context فقط تو حالت grounded هست - حالت general
  // اصلاً بر پایهٔ متون آرشیو کار نمی‌کنه، پس این پارامتر رو لازم نداره.
  if (mode === "grounded" && contextChunks.length === 0) {
    return jsonResponse({ error: "پارامتر context (آرایه‌ای از متن‌های مرتبط) لازمه" }, 400);
  }

  // Item ۱۲ (خصوصیاتِ شخصی‌سازیِ گفتگو): متن دلخواهی که کاربر از سمتِ
  // کلاینت (search-widget.js) فرستاده - مثلاً «پاسخ‌ها کوتاه باشه» یا
  // «با لحن ساده توضیح بده». طول رو محدود می‌کنیم (جلوگیری از سوءاستفاده
  // برای پرکردن prompt یا افزایش هزینه)، و صریحاً به مدل می‌گیم این فقط
  // یه ترجیحِ سبک/لحنه - نباید صداقت پاسخ، ارجاع به منابع، یا بقیهٔ
  // قوانینِ systemPrompt اصلی رو زیر پا بذاره.
  const customInstructions = typeof body.customInstructions === "string"
    ? body.customInstructions.trim().slice(0, 500)
    : "";

  const customInstructionsNote = customInstructions
    ? `\n\nترجیحِ شخصیِ کاربر برای شکلِ پاسخ (فقط دربارهٔ لحن/طول/سطح توضیح - نه چیزی که به محتوا یا صداقتِ پاسخ یا قوانین بالا مربوط باشه؛ اگه با اون‌ها در تضاد بود، قوانین بالا در اولویتن): «${customInstructions}»`
    : "";

  const contextText = contextChunks
    .map((c, i) => `[بخش ${i + 1}]\n${c}`)
    .join("\n\n");

  const historyNote = history.length > 0
    ? "\n\nاین سؤال، ادامهٔ همین گفتگوست - به سؤال‌ها و پاسخ‌های قبلی که پیش از این پیام آمده توجه کن و در صورت نیاز (مثلاً اگر سؤال به «آن»، «همان مطلب»، یا موضوع قبلی اشاره داشت) پاسخ را با در نظر گرفتن آن‌ها بساز."
    : "";

  // Item جدید (پاسخ آزاد): بدون محدودیت به متون آرشیو - دستیار می‌تونه
  // از دانش عمومی خودش هم استفاده کنه و به سلام/احوال‌پرسی و سؤال‌های
  // عمومی هم طبیعی جواب بده. توجه: این هنوز دانش عمومیِ خودِ Gemini‌ـه،
  // نه جست‌وجوی زندهٔ گوگل - Gemini به‌تنهایی به اینترنت زنده دسترسی
  // نداره؛ برای اتصال واقعی به نتایج جست‌وجوی گوگل باید از قابلیت جدا و
  // پولیِ "Grounding with Google Search" در API جیمینای استفاده کرد که
  // فعلاً در این کد پیاده نشده.
  const languageNote = "\n\n(مهم) زبان پاسخ: همیشه دقیقاً به همون زبانی جواب بدید که سؤال فعلی کاربر به اون نوشته شده - اگه به انگلیسی پرسیده، پاسخ انگلیسی باشه؛ اگه عربی، پاسخ عربی؛ اگه اردو، پاسخ اردو؛ و همین‌طور برای هر زبان دیگه. زبانِ سؤال فعلیِ کاربر رو ملاک بگیرید، نه زبان این دستورالعمل‌ها یا زبان متن‌های مرجع.";

  const systemPrompt = mode === "general"
    ? `شما دستیار وب‌سایت پژوهشی شهید روحبخش هستید (سایت پشتیبانی پژوهشی آکادمی روح‌بخش). الان در حالت «پاسخ آزاد» هستید - یعنی برخلاف حالت عادی، مجبور نیستید پاسخ را فقط از متون آرشیو بسازید. مخاطب این سایت عمدتاً نسل جوان است، نه کاملاً مذهبی سنتی و نه ضد دین - پس با لحنی صمیمی، امروزی و بدون سنگینی بیش‌ازحد رسمی صحبت کنید (ولی محترمانه و دقیق بمانید). به‌صورت طبیعی، دوستانه و مختصر پاسخ بدید - از جمله به سلام، احوال‌پرسی، و سؤال‌های عمومی که ربطی به متون آرشیو ندارند. اگه سؤال به موضوعات تخصصی این آرشیو (روانشناسی، توسعه‌ی فردی، احکام شرعی، اعتقادات) مربوط بود، از دانش عمومی خودتون کمک بگیرید، ولی صادقانه بگید این پاسخ مستند به متون آرشیو نیست.${historyNote}${customInstructionsNote}${languageNote}`
    : `شما دستیار پژوهشی وب‌سایت پژوهشی شهید روحبخش هستید (سایت پشتیبانی پژوهشی آکادمی روح‌بخش). مخاطب این سایت عمدتاً نسل جوان است، نه کاملاً مذهبی سنتی و نه ضد دین - پس با لحنی صمیمی و امروزی، بدون سنگینی بیش‌ازحد رسمی، صحبت کنید. پاسخ خود را صرفاً بر اساس متن‌های زیر که از محتوای آرشیو استخراج شده، به‌صورت دقیق و مستند ارائه دهید. در صورتی که پاسخ در این متن‌ها یافت نشد، صادقانه اعلام کنید که در منابع موجود پاسخی یافت نشد؛ از افزودن مطلبی که مستند به متن نیست خودداری کنید.

مطلب را مستقیم و قاطع بیان کنید — پاسخ را با عباراتی مانند «طبق این متون...»، «بر اساس منابع فوق...» یا هر مقدمه‌چینی مشابه شروع نکنید؛ این نوع عبارات، با وجود قصد بی‌طرفی، عملاً به اعتبار و قاطعیت پاسخ خدشه وارد می‌کند. کافی است در پایان پاسخ، مآخذ ذکر شود (که به‌صورت خودکار در رابط کاربری اضافه می‌شود)؛ نیازی به تکرار «طبق متن» در ابتدای هر جمله یا پاراگراف نیست.${historyNote}${customInstructionsNote}

مهم (برای تشخیص منابع واقعاً مرتبط): هر «بخش» زیر یه شماره داره. ممکنه بعضی از این بخش‌ها اصلاً به سؤال ربطی نداشته باشن (چون جست‌وجوی معنایی صرفاً نزدیک‌ترین‌ها رو آورده، نه لزوماً مرتبط‌ترین‌ها). در **آخرین خط** پاسخ خودتون (بعد از یه خط خالی، جدا از متن اصلی پاسخ)، دقیقاً به این شکل بنویسید کدوم شماره‌بخش‌ها واقعاً در ساختن این پاسخ استفاده شدن:
REFERENCES: 1,3
(اگه فقط از یه بخش استفاده شد: REFERENCES: 2 — اگه هیچ‌کدوم واقعاً مرتبط نبودن: REFERENCES: none)
این خط رو دقیقاً با همین قالب (REFERENCES: به انگلیسی، بدون توضیح اضافه) بنویسید؛ رابط کاربری این خط رو خودش پردازش می‌کنه و از دید کاربر حذفش می‌کنه.${languageNote}

متن‌های مرتبط:
${contextText}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  // Item جدید (گفتگوی ادامه‌دار): هر تبادل قبلیِ همین نشست، به‌صورت یک
  // نوبت واقعی user + یک نوبت واقعی model قبل از سؤال فعلی اضافه می‌شه -
  // این‌جوری Gemini واقعاً می‌بینه چه سؤال‌هایی قبلاً پرسیده شده و چه
  // جوابی داده، نه این‌که هر بار انگار اولین سؤاله. متن‌های مرتبط
  // (context) چون برای هر سؤال جدا از نو با جست‌وجوی معنایی پیدا می‌شن،
  // فقط به نوبت فعلی (نه نوبت‌های قبلی تاریخچه) ضمیمه می‌شن.
  const contents = [];

  for (const turn of history) {
    contents.push({ role: "user", parts: [{ text: turn.question }] });
    contents.push({ role: "model", parts: [{ text: turn.answer }] });
  }

  // Item جدید (پیوست عکس): اگه کاربر یه عکس همراه پرسش فرستاده باشه،
  // به‌عنوان یه قسمت جدا (inline_data) کنار متن سؤال به Gemini داده
  // می‌شه - فقط برای همین یه پرسش، نه برای کل تاریخچه.
  const parts = [{ text: `${systemPrompt}\n\nسؤال کاربر: ${question}` }];

  if (body.image && typeof body.image.base64 === "string" && typeof body.image.mimeType === "string") {
    parts.push({
      inline_data: {
        mime_type: body.image.mimeType,
        data: body.image.base64,
      },
    });
  }

  contents.push({ role: "user", parts });

  const geminiRequestBody = JSON.stringify({ contents });

  const geminiRes = await fetchGeminiWithRetry(geminiUrl, geminiRequestBody);

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return jsonResponse({ error: "خطا در تماس با Gemini", detail: errText }, 502);
  }

  const geminiJson = await geminiRes.json();
  const rawAnswer =
    geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی دریافت نشد.";

  // آیتم ۱۰ (فیلتر ارتباط): خط REFERENCES رو از متنِ دیده‌شده توسط
  // کاربر جدا می‌کنیم و اندیس‌های استفاده‌شده رو استخراج می‌کنیم - تا
  // فقط منابعی که واقعاً استفاده شدن (نه هرچی که جست‌وجوی معنایی
  // برگردونده) به کاربر نشون داده بشه.
  let answer = rawAnswer;
  let usedReferences = null; // null یعنی "نمی‌دونیم" (مثلاً حالت general)

  if (mode === "grounded") {
    const match = rawAnswer.match(/\n?REFERENCES:\s*([^\n]*)\s*$/i);
    if (match) {
      answer = rawAnswer.slice(0, match.index).trim();
      const refsRaw = match[1].trim().toLowerCase();
      usedReferences = refsRaw === "none" || refsRaw === ""
        ? []
        : refsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
    }
  }

  return jsonResponse({ answer, usedReferences });
}

// ---------- /track و /stats : آمار سایت (مورد ۸، + فیلتر روزانه) ----------
// چون KV افزایش اتمی نداره (فقط get/put ساده)، این شمارنده‌ها زیر بار
// هم‌زمانِ خیلی بالا ممکنه گاهی یک شمارش رو از دست بدن (دو درخواست
// هم‌زمان، هر دو همون عدد قدیمی رو می‌خونن و هر دو با +۱ می‌نویسن) -
// برای یک سایت آرشیوی با ترافیک معمولی، این خطای کوچیک قابل چشم‌پوشیه؛
// اگه دقتِ صددرصدی لازم شد، باید از Durable Objects استفاده کرد که
// پیچیدگی بیشتری داره.

// Item جدید (فیلتر روزانهٔ آمار): تاریخ هر رویداد بر اساس روزِ تقویمیِ
// تهران (نه UTC) محاسبه می‌شه - چون سرورِ Worker به وقتِ UTC کار می‌کنه
// و اگه به‌جاش از تاریخِ خامِ UTC استفاده می‌کردیم، بازدیدهای ساعت‌های
// اول شب (تا حدود ۳ ساعت و نیم بعد از نیمه‌شبِ تهران) اشتباهاً به روزِ
// قبل نسبت داده می‌شدن.
function tehranDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// حداکثر تعداد روزهایی که یک درخواستِ /stats با from/to مجاز است
// پیمایش کند - جلوگیری از یک درخواستِ سنگین با بازهٔ خیلی بزرگ (که
// می‌تونه صدها خواندنِ KV در یک درخواست بسازه).
const MAX_STATS_RANGE_DAYS = 366;

// Item جدید (تکمیل فیلدهای آمار): جدول واحد برای همهٔ انواع رویدادی که
// ردیابی می‌شن - قبلاً فقط pageview/search/download بودن، الان
// گفتگو، جستجوی معنایی، نشانه‌ها، آرشیو و خروجی‌گرفتن‌ها هم اضافه شدن.
// هر نوع یک شمارندهٔ ساده داره (countField) و - اگه kvLabel داشته باشه -
// یک «فهرست پرتکرارترین‌ها»ی جداگانه هم (topField) بر اساس detail که
// از سمت صفحه فرستاده می‌شه (مثلاً متن سؤال، یا فرمت خروجی).
// handleTrack و handleStats هر دو از همین یک جدول تغذیه می‌کنن تا اضافه
// کردنِ نوع رویداد جدید در آینده فقط به یک خط اینجا نیاز داشته باشه.
const EVENT_TYPES = [
  { type: "pageview", countField: "pageviews", topField: null, kvLabel: null },
  { type: "search", countField: "searches", topField: "topSearchTerms", kvLabel: "searchTerms" },
  { type: "download", countField: "downloads", topField: "topDownloadFiles", kvLabel: "downloadFiles" },
  { type: "chat", countField: "chats", topField: "topChatQuestions", kvLabel: "chatQuestions" },
  { type: "semanticSearch", countField: "semanticSearches", topField: "topSemanticQueries", kvLabel: "semanticQueries" },
  { type: "bookmark", countField: "bookmarks", topField: "topBookmarkedTitles", kvLabel: "bookmarkedTitles" },
  { type: "archive", countField: "archives", topField: "topArchivedTitles", kvLabel: "archivedTitles" },
  { type: "export", countField: "exports", topField: "topExportFormats", kvLabel: "exportFormats" },
];

async function handleTrack(request, env) {
  if (!env.STATS_KV) {
    // نبودِ KV آمار نباید تجربهٔ کاربر رو خراب کنه - بی‌سروصدا موفق
    // برمی‌گردونیم، انگار ثبت شد (فقط tracked:false رو نشون می‌ده).
    return jsonResponse({ ok: true, tracked: false });
  }

  const body = await request.json();
  const type = body.type;
  const eventConfig = EVENT_TYPES.find((e) => e.type === type);

  if (!eventConfig) {
    return jsonResponse(
      { error: `پارامتر type باید یکی از این‌ها باشه: ${EVENT_TYPES.map((e) => e.type).join("/")}` },
      400
    );
  }

  const today = tehranDateString(new Date());

  const counterKey = `stats:count:${type}`;
  const dayCounterKey = `stats:day:${today}:count:${type}`;

  const [current, currentForDay] = await Promise.all([
    env.STATS_KV.get(counterKey),
    env.STATS_KV.get(dayCounterKey),
  ]);

  await Promise.all([
    env.STATS_KV.put(counterKey, String(parseInt(current || "0", 10) + 1)),
    env.STATS_KV.put(dayCounterKey, String(parseInt(currentForDay || "0", 10) + 1)),
  ]);

  const detail = typeof body.detail === "string" ? body.detail.trim() : "";

  if (eventConfig.kvLabel && detail) {
    const raw = detail.slice(0, 300);
    // برای عبارت‌هایی که واقعاً «جست‌وجو» محسوب می‌شن (search، سؤال
    // گفتگو، پرس‌وجوی معنایی) حروف بزرگ/کوچک لاتین یکسان‌سازی می‌شه تا
    // یک عبارت با نگارش متفاوت دوبار شمرده نشه؛ برای فرمتِ خروجی یا
    // عنوان کتاب این یکسان‌سازی لازم نیست.
    const isQueryLike = type === "search" || type === "chat" || type === "semanticSearch";
    const value = isQueryLike ? raw.toLowerCase() : raw;

    await Promise.all([
      incrementTermCount(env, `stats:${eventConfig.kvLabel}`, value),
      incrementTermCount(env, `stats:day:${today}:${eventConfig.kvLabel}`, value),
    ]);
  }

  return jsonResponse({ ok: true, tracked: true });
}


// کمک‌تابع مشترک برای «فهرست پرتکرارترین‌ها» (هم برای عبارت‌های
// جست‌وجوشده، هم اسم فایل‌های دانلودشده) - یک آبجکت JSON از
// {مقدار: تعداد} در KV نگه می‌داره. اگه تعداد مقدارهای یکتا خیلی زیاد
// بشه (حافظهٔ هر کلید KV نامحدود نیست)، کم‌تکرارترین‌ها کنار گذاشته
// می‌شن تا فقط پرتکرارترین‌ها بمونن.
const MAX_UNIQUE_TRACKED_VALUES = 1000;

async function incrementTermCount(env, kvKey, value) {
  const raw = await env.STATS_KV.get(kvKey);
  const counts = raw ? JSON.parse(raw) : {};
  counts[value] = (counts[value] || 0) + 1;

  const entries = Object.entries(counts);
  const trimmed = entries.length > MAX_UNIQUE_TRACKED_VALUES
    ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_UNIQUE_TRACKED_VALUES))
    : counts;

  await env.STATS_KV.put(kvKey, JSON.stringify(trimmed));
}

// یک لیست از رشته‌های تاریخِ «YYYY-MM-DD» بین from و to (هر دو شامل)
// می‌سازه. تاریخ‌ها فقط برچسبِ روزِ تقویمی‌ان (نه یک لحظهٔ دقیق)، پس
// برای جلوگیری از دردسرهای منطقهٔ زمانی هنگام جمع‌زدنِ روزها، هرکدوم
// را روی ساعتِ ۱۲:۰۰ UTC همون روز می‌سازیم.
function dateRangeList(fromStr, toStr) {
  const dates = [];
  let cursor = new Date(`${fromStr}T12:00:00Z`);
  const end = new Date(`${toStr}T12:00:00Z`);

  while (cursor <= end && dates.length <= MAX_STATS_RANGE_DAYS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  return dates;
}

function mergeTermMaps(rawList) {
  const merged = {};
  for (const raw of rawList) {
    if (!raw) continue;
    const counts = JSON.parse(raw);
    for (const [value, count] of Object.entries(counts)) {
      merged[value] = (merged[value] || 0) + count;
    }
  }
  return merged;
}

const DATE_STRING_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function handleStats(request, env) {
  if (!env.STATS_KV) {
    return jsonResponse({ error: "آمار روی این سرور فعال نیست (KV به اسم STATS_KV بایند نشده)" }, 404);
  }

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const topEntries = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([value, count]) => ({ value, count }));

  // بدون from/to: همان رفتار قبلی - مجموع کل از ابتدا تا الان (سازگار
  // با نسخهٔ قبلیِ stats.html که هنوز فیلتر تاریخ نمی‌فرسته).
  if (!fromParam && !toParam) {
    const reads = await Promise.all(
      EVENT_TYPES.flatMap((e) => [
        env.STATS_KV.get(`stats:count:${e.type}`),
        e.kvLabel ? env.STATS_KV.get(`stats:${e.kvLabel}`) : Promise.resolve(null),
      ])
    );

    const result = { range: null };
    EVENT_TYPES.forEach((e, i) => {
      result[e.countField] = parseInt(reads[i * 2] || "0", 10);
      if (e.topField) {
        const topRaw = reads[i * 2 + 1];
        result[e.topField] = topEntries(topRaw ? JSON.parse(topRaw) : {});
      }
    });

    return jsonResponse(result);
  }

  // اگه یکی از from/to داده شده، هر دو لازمن.
  if (!fromParam || !toParam || !DATE_STRING_PATTERN.test(fromParam) || !DATE_STRING_PATTERN.test(toParam)) {
    return jsonResponse({ error: "پارامترهای from و to باید هر دو به شکل YYYY-MM-DD داده بشن" }, 400);
  }

  if (fromParam > toParam) {
    return jsonResponse({ error: "تاریخ from نباید بعد از to باشه" }, 400);
  }

  const days = dateRangeList(fromParam, toParam);

  if (days.length > MAX_STATS_RANGE_DAYS) {
    return jsonResponse({ error: `بازهٔ تاریخ نباید بیشتر از ${MAX_STATS_RANGE_DAYS} روز باشه` }, 400);
  }

  // برای هر روزِ بازه، به‌ازای هر نوع رویداد یک یا دو کلید (شمارنده +
  // نقشهٔ پرتکرارها) از KV خونده می‌شه. تعداد خواندن‌های KV در پلن
  // رایگان بسیار سخاوتمندانه‌تر از نوشتن‌هاست، پس این حتی برای
  // بازه‌های چندماهه و با این تعداد نوع رویداد هم مشکلی ایجاد نمی‌کنه.
  const perDayResults = await Promise.all(
    days.map((day) =>
      Promise.all(
        EVENT_TYPES.flatMap((e) => [
          env.STATS_KV.get(`stats:day:${day}:count:${e.type}`),
          e.kvLabel ? env.STATS_KV.get(`stats:day:${day}:${e.kvLabel}`) : Promise.resolve(null),
        ])
      )
    )
  );

  const counters = EVENT_TYPES.map(() => 0);
  const topRawLists = EVENT_TYPES.map(() => []);

  for (const dayRow of perDayResults) {
    EVENT_TYPES.forEach((e, i) => {
      counters[i] += parseInt(dayRow[i * 2] || "0", 10);
      topRawLists[i].push(dayRow[i * 2 + 1]);
    });
  }

  const result = { range: { from: fromParam, to: toParam } };
  EVENT_TYPES.forEach((e, i) => {
    result[e.countField] = counters[i];
    if (e.topField) {
      result[e.topField] = topEntries(mergeTermMaps(topRawLists[i]));
    }
  });

  return jsonResponse(result);
}

// ---------- /contact : فرم «ارتباط با ما» ----------
// ورودی مورد انتظار (JSON):
//   { name: string, contact?: string, message: string }
// «contact» اختیاریه (ایمیل یا شماره‌ای که کاربر می‌ذاره تا بشه جوابش رو داد).
// (نسخهٔ این سایت فقط یک مقصد داره - مدیر سایت - برخلاف سایت میلانی که
// بین «سایت» و «کتب» تفکیک می‌کرد؛ این سایت بخش کتب جداگانه‌ای نداره.)
const CONTACT_MAX_LENGTHS = { name: 200, contact: 200, message: 4000 };

async function handleContact(request, env) {
  const body = await request.json().catch(() => ({}));

  const name = typeof body.name === "string" ? body.name.trim().slice(0, CONTACT_MAX_LENGTHS.name) : "";
  const contact = typeof body.contact === "string" ? body.contact.trim().slice(0, CONTACT_MAX_LENGTHS.contact) : "";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, CONTACT_MAX_LENGTHS.message) : "";

  if (!name || !message) {
    return jsonResponse({ error: "نام و متن پیام هر دو لازمن" }, 400);
  }

  const textLines = ["📌 پیام جدید از سایت", "", `نام: ${name}`];
  if (contact) textLines.push(`تماس: ${contact}`);
  textLines.push("", "متن پیام:", message);
  const text = textLines.join("\n");

  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    return jsonResponse({ error: "مقصد پیام تنظیم نشده (متغیرهای Cloudflare رو چک کن)" }, 500);
  }

  const result = await sendTelegramMessage(env.TG_BOT_TOKEN, env.TG_CHAT_ID, text);

  if (!result.ok) {
    console.error("contact send failure:", result.status);
  }

  return jsonResponse({ ok: result.ok }, result.ok ? 200 : 502);
}

async function sendTelegramMessage(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return { ok: res.ok, status: res.status };
}

// ---------- /reset-stats : صفرکردن کامل آمار ----------
// یک رمزِ ساده لازم داره تا هرکسی که آدرسِ Worker رو بدونه نتونه آمار
// رو پاک کنه - این رمز به‌عنوان یک Secret جدا (نه در همین کد) روی
// Cloudflare تنظیم می‌شه: env.STATS_RESET_KEY. اگه این Secret اصلاً
// تنظیم نشده باشه، این endpoint به‌طور کامل غیرفعاله (نه این‌که با یک
// رمزِ پیش‌فرض/خالی کار کنه) - تا از پاک‌شدنِ ناخواسته جلوگیری بشه.
async function handleResetStats(request, env) {
  if (!env.STATS_KV) {
    return jsonResponse({ error: "آمار روی این سرور فعال نیست (KV به اسم STATS_KV بایند نشده)" }, 404);
  }

  if (!env.STATS_RESET_KEY) {
    return jsonResponse({ error: "ریست آمار روی این سرور تنظیم نشده (Secret به اسم STATS_RESET_KEY لازمه)" }, 404);
  }

  const body = await request.json().catch(() => ({}));
  const providedKey = typeof body.key === "string" ? body.key : "";

  if (providedKey !== env.STATS_RESET_KEY) {
    return jsonResponse({ error: "رمز درست نیست" }, 401);
  }

  // KV هیچ عملیاتِ «حذفِ همهٔ کلیدهایی که با فلان پیشوند شروع می‌شن»
  // نداره - باید اول همه‌شون رو با list (که صفحه‌به‌صفحه، هر بار حداکثر
  // ۱۰۰۰ تا برمی‌گردونه) فهرست کنیم، بعد یکی‌یکی حذف کنیم.
  let cursor;
  let deletedCount = 0;

  do {
    const page = await env.STATS_KV.list({ prefix: "stats:", cursor });
    await Promise.all(page.keys.map((k) => env.STATS_KV.delete(k.name)));
    deletedCount += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ ok: true, deletedCount });
}
