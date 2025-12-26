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

const isLikelyProductUrl = (value) =>
  /\/p\//i.test(value) || /\b\d{5,}\b/.test(value);

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

  const apiProducts = [];

  const pushApiProducts = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const collected = [];
    const pushProduct = (product) => {
      if (!product || typeof product !== "object") return;
      collected.push({
        title: product.title || product.name || product.productName || "",
        url:
          product.url ||
          product.productUrl ||
          product.pdpUrl ||
          product.canonicalUrl ||
          "",
        image:
          product.image?.url ||
          product.imageUrl ||
          product.primaryImage?.url ||
          product.images?.[0]?.url ||
          null,
        price:
          product.price?.sales?.value ||
          product.price?.sale ||
          product.price?.value ||
          product.price ||
          null,
        wasPrice:
          product.price?.list?.value ||
          product.price?.regular ||
          product.price?.msrp ||
          product.wasPrice ||
          null
      });
    };

    const candidates = [
      payload.products,
      payload.items,
      payload.hits,
      payload.data?.products,
      payload.data?.items,
      payload.data?.hits,
      payload.productSearch?.hits,
      payload.productSearch?.products,
      payload.search?.products
    ];

    for (const list of candidates) {
      if (Array.isArray(list)) {
        list.forEach((item) => pushProduct(item?.product || item));
      }
    }

    if (collected.length > 0) {
      apiProducts.push(...collected);
    }
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 }
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (!/clearance/i.test(url)) return;
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("application/json")) return;
    try {
      const payload = await response.json();
      pushApiProducts(payload);
    } catch {
      // ignore non-json payloads
    }
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

  const { rawProducts, hrefs } = await page.evaluate(() => {
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

    const getProductLink = (card) => {
      const directAnchor = card.querySelector(
        "a[href*='/p/'], a[href*='/product/'], a[href*='/toysrus/']"
      );
      if (directAnchor) {
        return directAnchor.getAttribute("href") || "";
      }

      const dataEl = card.querySelector("[data-href], [data-url]");
      if (dataEl) {
        return (
          dataEl.getAttribute("data-href") ||
          dataEl.getAttribute("data-url") ||
          ""
        );
      }

      return "";
    };

    const selectors = [
      "article",
      "li",
      ".product-tile",
      ".product-card",
      "[data-testid*='product' i]",
      "[data-qa*='product' i]"
    ];

    const cards = selectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((el) => {
        const href = getProductLink(el);
        return href && /\/p\//i.test(href);
      });

    const hrefs = cards.map((card) => getProductLink(card)).filter(Boolean);

    const rawProducts = cards.map((card) => {
      const anchor = card.querySelector(
        "a[href*='/p/'], a[href*='/product/'], a[href*='/toysrus/']"
      );
      const titleEl =
        card.querySelector("[data-testid*='product' i]") ||
        card.querySelector(".product-title") ||
        card.querySelector(".pdp-link") ||
        card.querySelector("h2, h3") ||
        anchor;

      const title = titleEl?.textContent?.trim() || "";
      const url = getProductLink(card);

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

    return { rawProducts, hrefs };
  });

  await browser.close();

  const allRawProducts = [...rawProducts, ...apiProducts];
  const hrefCounts = new Map();
  for (const href of hrefs) {
    hrefCounts.set(href, (hrefCounts.get(href) || 0) + 1);
  }

  const uniqueHrefs = Array.from(hrefCounts.keys());
  console.log(`[toysrus] hrefUnique=${uniqueHrefs.length}`);
  console.log(
    `[toysrus] hrefUnique sample=${uniqueHrefs.slice(0, 20).join(" | ")}`
  );
  const topHrefs = Array.from(hrefCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([href, count]) => `${href} -> ${count}`)
    .join(" | ");
  console.log(`[toysrus] hrefTop10=${topHrefs}`);

  console.log(
    `[toysrus] rawProducts=${rawProducts.length}, apiProducts=${apiProducts.length}`
  );

  const products = [];
  const seen = new Set();

  for (const product of allRawProducts) {
    const normalizedUrl = normalizeUrl(product.url);
    if (
      !normalizedUrl ||
      !isLikelyProductUrl(normalizedUrl) ||
      seen.has(normalizedUrl)
    ) {
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
    `[toysrus] extractedRaw=${allRawProducts.length}, unique=${seen.size}, final=${products.length}`
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
