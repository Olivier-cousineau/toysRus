import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const seedUrl = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const maxLoadMoreClicks = 30;

const randomDelay = (minMs = 700, maxMs = 1200) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const normalizeUrl = (value) => {
  try {
    const url = new URL(value, seedUrl);
    url.hash = "";
    url.search = "";
    let normalized = url.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
};

const parsePrice = (value) => {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
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

  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(randomDelay());

  let loadMoreClicks = 0;
  for (let i = 0; i < maxLoadMoreClicks; i += 1) {
    const loadMoreButton = page.locator('button:has-text("Load more")');
    const isVisible = await loadMoreButton.first().isVisible().catch(() => false);
    if (!isVisible) {
      break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomDelay());

    await loadMoreButton.first().click();
    loadMoreClicks += 1;
    console.log(`[toysrus] loadMore click ${loadMoreClicks}`);
    await page.waitForTimeout(randomDelay());
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(randomDelay());

  const scrapedAt = new Date().toISOString();

  const rawProducts = await page.evaluate(() => {
    const priceRegex = /\$\s?[\d.,]+/g;

    const getImageUrl = (card) => {
      const img = card.querySelector("img");
      if (img) {
        return (
          img.getAttribute("src") ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy") ||
          img.getAttribute("data-original") ||
          (img.getAttribute("srcset") || "").split(",")[0]?.trim().split(" ")[0]
        );
      }

      const styled = card.querySelector("[style*='background-image']");
      if (styled) {
        const styleValue = styled.getAttribute("style") || "";
        const match = styleValue.match(/background-image:\s*url\(['"]?(.*?)['"]?\)/i);
        if (match) {
          return match[1];
        }
      }

      return null;
    };

    const parseNumbers = (values) =>
      values
        .map((value) => value.replace(/[^\d.,]/g, "").replace(/,/g, ""))
        .map((value) => Number.parseFloat(value))
        .filter((value) => Number.isFinite(value));

    const cards = Array.from(
      document.querySelectorAll("article, li, div")
    ).filter((el) => el.querySelector("a[href*='/toysrus/']"));

    return cards.map((card) => {
      const anchor = card.querySelector("a[href*='/toysrus/']");
      const titleEl =
        card.querySelector("[data-testid*='product' i]") ||
        card.querySelector(".product-title") ||
        card.querySelector(".pdp-link") ||
        card.querySelector("h2, h3") ||
        anchor;

      const title = titleEl?.textContent?.trim() || "";
      const url = anchor?.getAttribute("href") || "";

      const priceNodes = Array.from(
        card.querySelectorAll("[class*='price' i], [data-testid*='price' i]")
      );
      const priceText = priceNodes.length
        ? priceNodes.map((node) => node.textContent || "").join(" ")
        : card.textContent || "";
      const priceMatches = priceText.match(priceRegex) || [];
      const numbers = parseNumbers(priceMatches);

      let price = null;
      let wasPrice = null;
      if (numbers.length === 1) {
        [price] = numbers;
      } else if (numbers.length >= 2) {
        const sorted = [...numbers].sort((a, b) => a - b);
        price = sorted[0];
        wasPrice = sorted[sorted.length - 1];
      }

      return {
        title,
        url,
        image: getImageUrl(card),
        price,
        wasPrice
      };
    });
  });

  await browser.close();

  const products = [];
  const seen = new Set();

  for (const product of rawProducts) {
    const normalizedUrl = normalizeUrl(product.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const imageUrl = product.image
      ? new URL(product.image, seedUrl).toString()
      : null;

    const price = parsePrice(String(product.price ?? ""));
    const wasPrice = parsePrice(String(product.wasPrice ?? ""));

    if (!price) {
      continue;
    }

    const discountPct =
      price && wasPrice && wasPrice > 0
        ? Math.round(((wasPrice - price) / wasPrice) * 100)
        : null;

    products.push({
      title: product.title || null,
      url: normalizedUrl,
      image: imageUrl,
      price,
      wasPrice,
      discountPct,
      scrapedAt
    });
    seen.add(normalizedUrl);
  }

  console.log(
    `[toysrus] extractedRaw=${rawProducts.length}, unique=${seen.size}, final=${products.length}`
  );

  await ensureDir("data");
  await fs.writeFile(
    path.join("data", "online.json"),
    JSON.stringify(products, null, 2)
  );

  const fullPayload = {
    seedUrl,
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
