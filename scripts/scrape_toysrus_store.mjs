import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const seedUrl = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const maxLoadMoreClicks = 40;

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

const readStores = async () => {
  const raw = await fs.readFile(path.join("public", "toysrus", "stores.json"), "utf8");
  return JSON.parse(raw);
};

const findStore = (stores, slug, city) => {
  if (slug) {
    return stores.find((store) => store.slug.toLowerCase() === slug.toLowerCase());
  }
  if (city) {
    return stores.find((store) => store.city.toLowerCase() === city.toLowerCase());
  }
  return null;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const slugIndex = args.findIndex((value) => value === "--slug");
  const cityIndex = args.findIndex((value) => value === "--city");
  const slug = slugIndex >= 0 ? args[slugIndex + 1] : args[0];
  const city = cityIndex >= 0 ? args[cityIndex + 1] : null;
  return { slug, city };
};

const scrapeStore = async () => {
  const { slug, city } = parseArgs();
  const stores = await readStores();
  const store = findStore(stores, slug, city);

  if (!store) {
    throw new Error(`Store not found for slug=${slug ?? ""} city=${city ?? ""}`);
  }

  console.log(`[toysrus] store=${store.city} slug=${store.slug}`);

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

  const debugDir = path.join("outputs", "debug");
  await ensureDir(debugDir);

  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  const trigger = page.locator(
    "button:has-text('My Store'), button:has-text('Select Store'), a:has-text('My Store'), a:has-text('Select Store')"
  );
  await trigger.first().click({ timeout: 20000 });
  await page.waitForTimeout(randomDelay());

  const searchInput = page.locator(
    "input[placeholder*='City' i], input[placeholder*='Postal' i], input[placeholder*='Search' i], input[type='search'], input[aria-label*='search' i]"
  );
  await searchInput.first().fill(store.search || store.city, { timeout: 15000 });
  await page.waitForTimeout(randomDelay());

  const storeResult = page.locator(
    `[data-testid*='store' i]:has-text("${store.search || store.city}"), [class*='store' i]:has-text("${store.search || store.city}"), li:has-text("${store.search || store.city}")`
  );
  await storeResult.first().waitFor({ timeout: 20000 });

  const selectButton = storeResult
    .first()
    .locator("button:has-text('Select Store'), button:has-text('Select'), a:has-text('Select Store')");

  if (await selectButton.first().isVisible().catch(() => false)) {
    await selectButton.first().click();
  } else {
    await storeResult.first().click();
  }

  const confirmButton = page.locator(
    "button:has-text('Set as My Store'), button:has-text('Confirm'), button:has-text('Save')"
  );
  if (await confirmButton.first().isVisible().catch(() => false)) {
    await confirmButton.first().click();
  }

  const myStoreLabel = page.locator(
    "button:has-text('My Store'), a:has-text('My Store'), [data-testid*='my-store' i]"
  );
  await myStoreLabel.first().waitFor({ timeout: 20000 });
  const myStoreText = (await myStoreLabel.first().innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
  console.log(`[toysrus] My Store: ${myStoreText || store.city}`);

  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  const productSelector = "a[href*='/p/'], .product-tile, [data-test*='product']";
  await page.waitForSelector(productSelector, { timeout: 20000 });

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

  const allRawProducts = [...rawProducts, ...apiProducts];

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

  console.log(`[toysrus] loadMoreClicks=${loadMoreClicks}`);
  console.log(`[toysrus] rawCount=${allRawProducts.length}`);
  console.log(`[toysrus] uniqueCount=${seen.size}`);
  console.log(`[toysrus] finalCount=${products.length}`);

  if (products.length === 0) {
    await page.screenshot({
      path: path.join(debugDir, `${store.slug}_page.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.slug}_page.html`),
      await page.content()
    );
  }

  await browser.close();

  const outputDir = path.join("data", "toysrus", store.slug);
  await ensureDir(outputDir);
  await fs.writeFile(
    path.join(outputDir, "data.json"),
    JSON.stringify(
      {
        seedUrl,
        store: store.city,
        slug: store.slug,
        count: products.length,
        products
      },
      null,
      2
    )
  );
};

scrapeStore().catch((error) => {
  console.error("[toysrus] scrape failed", error);
  process.exitCode = 1;
});
