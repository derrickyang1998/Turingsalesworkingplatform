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

  // Check all pages can be switched to and have content
  for (const id of ["m2","m3","m4","m5","admin"]) {
    try {
      await page.click('[data-page="' + id + '"]');
      await page.waitForTimeout(500);
      const contentLength = await page.evaluate((pid) => {
        const el = document.getElementById("page-" + pid);
        return el ? el.textContent.trim().length : -1;
      }, id);
      const display = await page.evaluate((pid) => {
        const el = document.getElementById("page-" + pid);
        return el ? getComputedStyle(el).display : "MISSING";
      }, id);
      console.log(id + ": display=" + display + " content_len=" + contentLength);
    } catch(e) {
      console.log(id + ": CLICK FAILED - " + e.message);
    }
  }

  console.log("Total errors:", errors.length);
  await page.screenshot({ path: "C:/Users/29272/Documents/海外品牌推广-红人营销-图灵/platform/debug_pages.png" });
  await browser.close();
})().catch(e => console.error("FATAL:", e.message));
