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

const handleOneTrust = async (page) => {
  let handled = false;
  const acceptSelectors = [
    "button:has-text('Accept All')",
    "button:has-text('Accept Cookies')",
    "button:has-text('I Accept')",
    "button:has-text('Accept')",
    "button:has-text('Tout accepter')",
    "button:has-text('Accepter tout')",
    "button:has-text('Accepter')",
    "button#onetrust-accept-btn-handler"
  ];
  const closeSelectors = [
    "button[aria-label*='close' i]",
    "button:has-text('Close')",
    "button:has-text('Fermer')",
    ".onetrust-close-btn-handler",
    "#onetrust-close-btn-container button"
  ];

  const tryClick = async (selector) => {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) return false;
    await button.click({ timeout: 3000 }).catch(() => {});
    return true;
  };

  for (const selector of acceptSelectors) {
    if (await tryClick(selector)) {
      handled = true;
      break;
    }
  }

  if (!handled) {
    for (const selector of closeSelectors) {
      if (await tryClick(selector)) {
        handled = true;
        break;
      }
    }
  }

  try {
    await page.waitForSelector(".onetrust-pc-dark-filter, #onetrust-consent-sdk", {
      state: "hidden",
      timeout: 5000
    });
  } catch {
    // ignore timeout
  }

  const overlayVisible = await page
    .locator(".onetrust-pc-dark-filter, #onetrust-consent-sdk")
    .first()
    .isVisible()
    .catch(() => false);

  if (overlayVisible) {
    for (const selector of acceptSelectors) {
      if (await tryClick(selector)) {
        handled = true;
        break;
      }
    }
  }

  console.log(`[onetrust] handled=${handled}`);
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

const findStore = (stores, storeId) => {
  if (!storeId) return null;
  return stores.find(
    (store) => store.storeId.toLowerCase() === storeId.toLowerCase()
  );
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const storeIdIndex = args.findIndex(
    (value) => value === "--store-id" || value === "--storeId"
  );
  const slugIndex = args.findIndex((value) => value === "--slug");
  const storeId =
    storeIdIndex >= 0
      ? args[storeIdIndex + 1]
      : slugIndex >= 0
        ? args[slugIndex + 1]
        : args[0];
  return { storeId };
};

const scrapeStore = async () => {
  const { storeId } = parseArgs();
  const stores = await readStores();
  const store = findStore(stores, storeId);

  if (!store) {
    throw new Error(`Store not found for storeId=${storeId ?? ""}`);
  }

  console.log(`[toysrus] store=${store.storeName} storeId=${store.storeId}`);

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
  await handleOneTrust(page);
  await page.waitForTimeout(1000);

  const trigger = page.locator(
    "button[aria-label='Select Your Store'], .js-btn-get-store"
  );
  await handleOneTrust(page);
  try {
    await trigger.first().click({ timeout: 20000 });
  } catch {
    await handleOneTrust(page);
    await trigger.first().click({ timeout: 20000 });
  }
  await page.waitForTimeout(randomDelay());
  await handleOneTrust(page);

  const modalCandidates = [
    page
      .locator("button.js-btn-get-store")
      .first()
      .locator("xpath=ancestor::*[self::header or self::div][1]"),
    page
      .locator("text=SELECT YOUR STORE")
      .first()
      .locator(
        "xpath=ancestor::*[self::div][@role='dialog' or contains(@class,'modal')][1]"
      )
  ];
  let modal = null;
  for (const candidate of modalCandidates) {
    if ((await candidate.count().catch(() => 0)) > 0) {
      modal = candidate;
      break;
    }
  }
  if (!modal) {
    modal = page.locator("[role='dialog'], .modal, #store, .b-store-modal").first();
  }

  const inputSelectors = [
    "input[type='search']",
    "input[type='text']",
    "input[name*='location' i]",
    "input[id*='location' i]",
    "input[placeholder*='Location' i]",
    "input[aria-label*='Location' i]",
    "input"
  ];
  let searchInput = null;
  for (const selector of inputSelectors) {
    const candidates = modal.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      const enabled = await candidate.isEnabled().catch(() => false);
      if (visible && enabled) {
        searchInput = candidate;
        break;
      }
    }
    if (searchInput) break;
  }
  if (!searchInput) {
    await page.screenshot({
      path: path.join(debugDir, `${store.storeId}_modal.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeId}_modal.html`),
      await page.content()
    );
    throw new Error("Store locator input not found");
  }
  await searchInput.click({ timeout: 15000 });
  await searchInput.fill("");
  await searchInput.type(store.storeName, { delay: 50 });
  await page.waitForTimeout(randomDelay());

  const escapeRegExp = (value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizeStoreText = (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const isStrongStoreMatch = (value) => {
    if (!value) return false;
    const normalizedValue = normalizeStoreText(value);
    const normalizedStore = normalizeStoreText(store.storeName);
    if (!normalizedValue || !normalizedStore) return false;
    if (normalizedValue === normalizedStore) return true;
    if (normalizedValue.includes(normalizedStore)) return true;
    if (
      normalizedStore.includes(normalizedValue) &&
      normalizedValue.length >= Math.floor(normalizedStore.length * 0.8)
    ) {
      return true;
    }
    return false;
  };
  const findStoresButton = modal.locator(
    "button:has-text('Find Stores'), button:has-text('Trouver des magasins')"
  );
  await findStoresButton.first().click({ timeout: 15000 });

  const storeNameRegex = new RegExp(escapeRegExp(store.storeName), "i");
  const storeResultCandidates = modal.locator(
    "li:has(button), li:has(a), div:has(button), div:has(a)"
  );
  const storeResultMatches = storeResultCandidates.filter({
    hasText: storeNameRegex
  });

  let chosenStore = null;
  try {
    await storeResultMatches.first().waitFor({ timeout: 20000 });
  } catch {
    await page.screenshot({
      path: path.join(debugDir, `${store.storeName}_modal.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeName}_modal.html`),
      await page.content()
    );
    throw new Error(`No store match found for ${store.storeName}`);
  }

  const matchCount = await storeResultMatches.count();
  for (let i = 0; i < matchCount; i += 1) {
    const candidate = storeResultMatches.nth(i);
    const candidateText = (await candidate.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (
      isStrongStoreMatch(candidateText) &&
      (await candidate.isVisible().catch(() => false))
    ) {
      chosenStore = candidate;
      break;
    }
  }

  if (!chosenStore) {
    await page.screenshot({
      path: path.join(debugDir, `${store.storeName}_modal.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeName}_modal.html`),
      await page.content()
    );
    throw new Error(`No store match found for ${store.storeName}`);
  }

  const chosenStoreText = (await chosenStore.innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
  console.log(`[toysrus] chosenStoreText=${chosenStoreText}`);

  await chosenStore.click();

  const confirmButton = page.locator(
    "button:has-text('Confirm as My Store'), button:has-text('Confirmer comme mon magasin'), button:has-text('Confirmer en tant que mon magasin')"
  );
  await confirmButton.first().waitFor({ timeout: 20000 });
  await confirmButton.first().click();

  const headerText = (await page
    .locator("header")
    .first()
    .innerText()
    .catch(() => "")).replace(/\s+/g, " ")
    .trim();
  const headerHasMyStore = /my store/i.test(headerText);
  const headerHasStoreName = storeNameRegex.test(headerText);

  if (!headerHasMyStore || !headerHasStoreName) {
    await page.screenshot({
      path: path.join(debugDir, `${store.storeName}_after_confirm.png`),
      fullPage: true
    });
    throw new Error(
      `My Store mismatch: header="${headerText}" expected store="${store.storeName}"`
    );
  }
  console.log(`[toysrus] My Store confirmed: ${store.storeName}`);

  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  await handleOneTrust(page);
  await page.waitForTimeout(1000);

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

    await handleOneTrust(page);
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
      path: path.join(debugDir, `${store.storeId}_page.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeId}_page.html`),
      await page.content()
    );
  }

  await browser.close();

  const outputDir = path.join("data", "toysrus", store.storeId);
  await ensureDir(outputDir);
  await fs.writeFile(
    path.join(outputDir, "data.json"),
    JSON.stringify(
      {
        seedUrl,
        store: store.storeName,
        storeId: store.storeId,
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
