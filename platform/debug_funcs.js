const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let errors = [];
  page.on("pageerror", e => { errors.push(e.message); console.log("ERR:", e.message); });
  page.on("console", m => { if (m.type() === "error") { errors.push(m.text()); console.log("CON:", m.text()); } });

  await page.goto("http://localhost:3002", { timeout: 10000, waitUntil: "domcontentloaded" });
  await page.fill("#loginUser", "admin");
  await page.fill("#loginPass", "turing2026");
  await page.click("button:has-text('登录')");
  await page.waitForTimeout(3000);

  // Check global functions exist
  const funcs = await page.evaluate(() => ({
    updateStrategy: typeof updateStrategy,
    initM3: typeof initM3,
    matchInfluencers: typeof matchInfluencers,
    sendChat: typeof sendChat,
    loadAdminDashboard: typeof loadAdminDashboard,
    loadCustomers: typeof loadCustomers,
    BRANDS_count: typeof BRANDS !== 'undefined' ? BRANDS.length : 'undefined',
    TEMPLATES_count: typeof TEMPLATES !== 'undefined' ? TEMPLATES.length : 'undefined',
    INFLUENCERS_count: typeof INFLUENCERS !== 'undefined' ? INFLUENCERS.length : 'undefined',
    AUTH_TOKEN_set: AUTH_TOKEN ? 'yes' : 'no'
  }));
  console.log("Functions:", JSON.stringify(funcs, null, 2));

  // Check M2 form elements
  await page.click('[data-page="m2"]');
  await page.waitForTimeout(500);
  const m2Form = await page.evaluate(() => {
    const stage = document.getElementById("s_stage");
    const industry = document.getElementById("s_industry");
    return {
      s_stage_exists: !!stage,
      s_stage_options: stage ? stage.options.length : 0,
      s_industry_exists: !!industry,
      s_industry_options: industry ? industry.options.length : 0
    };
  });
  console.log("M2 form:", JSON.stringify(m2Form));

  // Check M4 table content
  await page.click('[data-page="m4"]');
  await page.waitForTimeout(1000);
  const m4Content = await page.evaluate(() => {
    const el = document.getElementById("infTableContainer");
    return el ? el.textContent.trim().substring(0, 100) : "MISSING";
  });
  console.log("M4 content:", m4Content);

  console.log("Total errors:", errors.length);
  await browser.close();
})().catch(e => console.error("FATAL:", e.message));
