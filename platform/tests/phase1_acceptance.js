const { chromium } = require('playwright');

const BASE_URL = process.env.TM_BASE_URL || 'http://localhost:3002';
const USERNAME = process.env.TM_USER || 'admin';
const PASSWORD = process.env.TM_PASSWORD || 'turing2026';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push('PAGEERROR: ' + err.message));

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.fill('#loginUser', USERNAME);
    await page.fill('#loginPass', PASSWORD);
    await page.click('#authOverlay button');
    await page.waitForSelector('#custTableBody tr', { timeout: 10000 });

    await page.locator('#custTableBody tr').first().click();
    await page.waitForSelector('#custDetailSidebar.open', { timeout: 10000 });

    for (const target of ['m1', 'm2', 'm3', 'm4']) {
      const count = await page.locator(`#custDetailSidebar button[onclick*="${target}"]`).count();
      assert(count === 1, `missing customer action for ${target}`);
    }

    await page.locator('#custDetailSidebar button[onclick*="m2"]').click();
    await page.waitForSelector('#page-m2.active', { timeout: 10000 });
    const strategyInput = await page.locator('#aiStrategyInput').inputValue();
    assert(strategyInput.length > 20, 'strategy page was not prefilled from customer context');

    await page.click('[data-page="m0"]');
    await page.waitForSelector('#custTableBody tr', { timeout: 10000 });
    await page.locator('#custTableBody tr').first().click();
    await page.waitForSelector('#custDetailSidebar.open', { timeout: 10000 });
    await page.locator('#custDetailSidebar button[onclick*="m3"]').click();
    await page.waitForSelector('#page-m3.active', { timeout: 10000 });

    const brand = await page.locator('#d_brand').inputValue();
    assert(brand, 'demand page brand was not prefilled');
    assert(await page.locator('#btnAnalyzeAI').isEnabled(), 'AI analysis button should be enabled after customer context handoff');

    await page.evaluate(() => {
      const brandValue = document.getElementById('d_brand').value || 'TestBrand';
      window.demandAnalysisResult = {
        brand: brandValue,
        product: 'Test Product',
        industry: document.getElementById('d_category').value || '3C',
        budget_range: '$15K-50K',
        target_market: 'US',
        platforms: ['YouTube'],
        competitors: [],
        requirements: ['test requirement']
      };
      document.getElementById('m3s1').classList.add('hidden');
      document.getElementById('m3s2').classList.remove('hidden');
      document.getElementById('analysisOut').innerHTML =
        '<input id="edit_brand" value="' + brandValue + '">' +
        '<input id="edit_product" value="Test Product">' +
        '<input id="edit_industry" value="3C">' +
        '<input id="edit_budget" value="$15K-50K">' +
        '<input id="edit_market" value="US">' +
        '<input id="edit_platforms" value="YouTube">';
    });

    await page.evaluate(() => goStep3());
    await page.waitForSelector('#m3s3:not(.hidden)', { timeout: 10000 });
    const templateCards = await page.locator('#tmplSelect .card').count();
    assert(templateCards > 0, 'proposal templates were not rendered');
    await page.locator('#tmplSelect .card').first().click();
    await page.locator('button[onclick="generateProposal()"]').click();
    await page.waitForTimeout(500);
    const proposalText = await page.locator('#proposalOutput').innerText();
    assert(proposalText.includes(brand) && proposalText.includes('Test Product'), 'proposal output did not include handoff context');

    await page.locator('button[onclick="openProposalToInfluencers()"]').click();
    await page.waitForSelector('#page-m4.active', { timeout: 10000 });
    assert(await page.locator('#filt_project').inputValue() === brand, 'influencer project filter was not prefilled');
    assert(await page.locator('#filt_product').inputValue() === 'Test Product', 'influencer product filter was not prefilled');
    assert(await page.locator('#filt_platform').inputValue() === 'YouTube', 'influencer platform filter was not prefilled');

    assert(errors.length === 0, 'browser errors: ' + errors.join(' | '));
    console.log('Phase 1 UI acceptance passed');
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Phase 1 UI acceptance failed:', err.message);
  process.exit(1);
});
