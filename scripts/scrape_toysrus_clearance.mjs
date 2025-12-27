import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const seedUrl = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const maxLoadMoreClicks = 30;
const loadMoreDelayMs = 1500;
const loadMoreScrollDelayMs = 800;

const handleOneTrust = async (page) => {
  try {
    const accept = page
      .locator(
        "#onetrust-accept-btn-handler, button:has-text('Accept All'), button:has-text('Tout accepter')"
      )
      .first();

    if (await accept.isVisible().catch(() => false)) {
      await accept.click({ timeout: 5000 }).catch(() => {});
      console.log("[onetrust] handled=true");
      return true;
    }

    await page.evaluate(() => {
      const dark = document.querySelector(
        ".onetrust-pc-dark-filter, #onetrust-consent-sdk"
      );
      if (dark) dark.remove();
      document
        .querySelectorAll(".ot-sdk-container, .ot-overlay, .ot-fade-in")
        .forEach((el) => el.remove());
    });

    console.log("[onetrust] handled=true");
    return true;
  } catch {
    console.log("[onetrust] handled=false");
    return false;
  }
};

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const scrape = async () => {
  console.log(`[toysrus] seedUrl=${seedUrl}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 }
  });

  const debugDir = path.join("outputs", "debug");
  await ensureDir(debugDir);

  const response = await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  console.log(`[toysrus] responseStatus=${response?.status() ?? "unknown"}`);
  console.log(`[toysrus] finalUrl=${page.url()}`);
  console.log(`[toysrus] title=${await page.title()}`);

  await page.waitForLoadState("networkidle");
  await handleOneTrust(page);
  await page.waitForSelector("div.b-product_tile", { timeout: 30000 });

  await page.screenshot({
    path: path.join(debugDir, "clearance.png"),
    fullPage: true
  });
  await fs.writeFile(
    path.join(debugDir, "clearance.html"),
    await page.content()
  );

  let loadMoreClicks = 0;
  while (true) {
    const loadMore = page.locator("button:has-text('LOAD MORE')");
    if (!(await loadMore.isVisible().catch(() => false))) break;

    await loadMore.scrollIntoViewIfNeeded();
    await page.waitForTimeout(loadMoreScrollDelayMs);
    await loadMore.click();
    await page.waitForTimeout(loadMoreDelayMs);

    loadMoreClicks += 1;
    console.log(`[toysrus] loadMore click ${loadMoreClicks}`);
    if (loadMoreClicks > maxLoadMoreClicks) break;
  }

  const scrapedAt = new Date().toISOString().split("T")[0];

  const products = await page.$$eval("div.b-product_tile", (cards) =>
    cards.map((card) => {
      const title =
        card.querySelector("a.b-product_tile-title-link")?.innerText?.trim() ||
        null;
      const image = card.querySelector("img.tile-image")?.src || null;

      const priceWas =
        card
          .querySelector(".b-price__was")
          ?.innerText?.replace("$", "")
          ?.replace(",", ".")
          ?.trim() || null;

      const priceNow =
        card
          .querySelector(".b-price__now")
          ?.innerText?.replace("$", "")
          ?.replace(",", ".")
          ?.trim() || null;

      const link =
        card.querySelector("a.b-product_tile-title-link")?.href || null;

      return {
        title,
        image,
        price_regular: priceWas,
        price_liquidation: priceNow,
        link
      };
    })
  );

  await browser.close();

  console.log(`[toysrus] products=${products.length}`);
  if (products.length === 0) {
    throw new Error("No products rendered...");
  }

  await ensureDir("data");
  await fs.writeFile(
    path.join("data", "online.json"),
    JSON.stringify(products, null, 2)
  );

  const fullPayload = {
    store: "Online",
    scraped_at: scrapedAt,
    count: products.length,
    products
  };

  await fs.writeFile(
    path.join("data", "toysrus_clearance_full.json"),
    JSON.stringify(fullPayload, null, 2)
  );
};

scrape().catch((error) => {
  console.error("[toysrus] scrape failed", error);
  process.exitCode = 1;
});
