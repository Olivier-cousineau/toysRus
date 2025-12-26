import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const seedUrl = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const maxLoadMoreClicks = 80;

const randomDelay = (minMs = 700, maxMs = 1200) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const randomShortDelay = (minMs = 250, maxMs = 400) =>
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

const closeBlockingModals = async (page) => {
  const findCloseButton = async (scope) => {
    const closeSelectors = [
      "button[aria-label='Close']",
      "button:has-text('×')",
      ".modal button"
    ];
    for (const selector of closeSelectors) {
      const button = scope.locator(selector).first();
      const visible = await button.isVisible().catch(() => false);
      if (visible) {
        await button.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
    return false;
  };

  const deliveryText = page.locator(
    "text=/Delivery postal code/i, text=/Set delivery postal code/i"
  );
  const deliveryVisible = await deliveryText.first().isVisible().catch(() => false);
  if (deliveryVisible) {
    const deliveryContainer = deliveryText
      .first()
      .locator(
        "xpath=ancestor::*[self::div or self::section or self::aside][@role='dialog' or contains(@class,'modal')][1]"
      );
    const containerVisible = await deliveryContainer
      .first()
      .isVisible()
      .catch(() => false);
    if (containerVisible) {
      await findCloseButton(deliveryContainer.first());
    } else {
      await findCloseButton(page);
    }
  }

  const cartModalText = page.locator(
    "text=/Some of the items in your cart/i"
  );
  const cartModalVisible = await cartModalText.first().isVisible().catch(() => false);
  if (cartModalVisible) {
    const cartContainer = cartModalText
      .first()
      .locator(
        "xpath=ancestor::*[self::div or self::section or self::aside][@role='dialog' or contains(@class,'modal')][1]"
      );
    const cartContainerVisible = await cartContainer
      .first()
      .isVisible()
      .catch(() => false);
    if (cartContainerVisible) {
      await findCloseButton(cartContainer.first());
    } else {
      await findCloseButton(page);
    }
  }

  await page.evaluate(() => {
    const selectors = [
      "#onetrust-consent-sdk",
      ".onetrust-pc-dark-filter",
      ".ot-fade-in"
    ];
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => element.remove());
    });

    const findCloseButton = (dialog) => {
      const buttons = Array.from(dialog.querySelectorAll("button"));
      return buttons.find((button) => {
        const label = button.getAttribute("aria-label") || "";
        const text = button.textContent || "";
        return (
          /close/i.test(label) ||
          /close/i.test(text) ||
          text.trim() === "×"
        );
      });
    };

    document.querySelectorAll("[role='dialog']").forEach((dialog) => {
      const text = dialog.textContent || "";
      if (/delivery|postal/i.test(text)) {
        const closeButton = findCloseButton(dialog);
        if (closeButton) {
          closeButton.click();
        } else {
          dialog.remove();
        }
      }
    });
  });

  await page.waitForTimeout(randomShortDelay());
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

  const row = chosenStore;
  const confirmButton = row
    .locator("button.js-select-store, button:has-text('Confirm as My Store')")
    .first();
  let confirmClicked = false;
  try {
    const confirmVisible = await confirmButton.isVisible().catch(() => false);
    if (confirmVisible) {
      await confirmButton.scrollIntoViewIfNeeded();
      await confirmButton.click({ timeout: 15000, force: true });
      confirmClicked = true;
    }
  } catch (error) {
    console.warn("[toysrus] confirm button click failed, falling back", error);
  }

  if (!confirmClicked) {
    confirmClicked = await page.evaluate((storeId) => {
      const button = document.querySelector(
        `button.js-select-store[value="${storeId}"]`
      );
      if (!button) {
        return false;
      }
      button.click();
      return true;
    }, store.storeId);
  }

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
    await fs.writeFile(
      path.join(debugDir, `${store.storeName}_after_confirm.html`),
      await page.content()
    );
    throw new Error(
      `My Store mismatch: header="${headerText}" expected store="${store.storeName}"`
    );
  }
  console.log(`[toysrus] My Store confirmed: ${store.storeName}`);
  await closeBlockingModals(page);
  await modal
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => null);
  await closeBlockingModals(page);
  await Promise.race([
    page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(() => null),
    page.waitForTimeout(1500)
  ]);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
  await closeBlockingModals(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await handleOneTrust(page);
    await page.waitForTimeout(400);
  }
  await closeBlockingModals(page);

  const safeReload = async (retries = 2) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await closeBlockingModals(page);
        return;
      } catch (error) {
        const errorMessage = String(error);
        if (errorMessage.includes("ERR_ABORTED") && attempt < retries) {
          continue;
        }
        throw error;
      }
    }
  };

  const clearanceLink = page
    .locator("a:has-text('CLEARANCE'), a[href*='clearance']")
    .first();
  const clearanceVisible = await clearanceLink.isVisible().catch(() => false);
  if (clearanceVisible) {
    await clearanceLink.click({ timeout: 15000 });
    await Promise.race([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => null),
      page.waitForTimeout(1500)
    ]);
  } else {
    await safeReload();
  }

  await handleOneTrust(page);
  await page.waitForTimeout(1000);
  await closeBlockingModals(page);
  try {
    await page
      .locator("text=/Showing\\s+\\d+\\s+of\\s+\\d+\\s+products/i")
      .first()
      .waitFor({ timeout: 30000 });
  } catch {
    await page.locator("text=/\\bResults\\b/i").first().waitFor({ timeout: 30000 });
  }

  const pageUrl = page.url();
  const pageTitle = await page.title().catch(() => "");
  const countShowing = await page
    .locator("text=/Showing\\s+\\d+\\s+of\\s+\\d+\\s+products/i")
    .count()
    .catch(() => 0);
  const countWasNow = await page.locator("text=/Was:\\s*\\$/i").count().catch(() => 0);
  const countAddToCart = await page
    .locator("text=/Add to Cart/i")
    .count()
    .catch(() => 0);
  const countLoadMoreVisible = await page
    .locator(
      "button:has-text('Load More'), button:has-text('LOAD MORE'), a:has-text('Load More'), a:has-text('LOAD MORE'), [role='button']:has-text('Load More'), [role='button']:has-text('LOAD MORE')"
    )
    .filter({ hasText: /Load More/i })
    .count()
    .catch(() => 0);
  console.log(
    `[toysrus] post-confirm url=${pageUrl} title="${pageTitle}" showing=${countShowing} wasNow=${countWasNow} addToCart=${countAddToCart} loadMoreVisible=${countLoadMoreVisible}`
  );

  let loadMoreClicks = 0;
  let noProgress = 0;
  const loadMoreLocator = page.locator(
    "button:has-text('Load More'), button:has-text('LOAD MORE'), a:has-text('Load More'), a:has-text('LOAD MORE'), [role='button']:has-text('Load More'), [role='button']:has-text('LOAD MORE')"
  );
  const getProgressCounts = async () => {
    const wasNowCount = await page.locator("text=/Was:\\s*\\$/i").count().catch(() => 0);
    const addToCartCount = await page
      .locator("text=/Add to Cart/i")
      .count()
      .catch(() => 0);
    return { wasNowCount, addToCartCount };
  };
  let previousCounts = await getProgressCounts();

  for (let i = 0; i < maxLoadMoreClicks; i += 1) {
    await closeBlockingModals(page);
    const isVisible = await loadMoreLocator.first().isVisible().catch(() => false);
    if (!isVisible) {
      break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomDelay(800, 1200));

    await handleOneTrust(page);
    await loadMoreLocator.first().click({ timeout: 15000 }).catch(() => null);
    loadMoreClicks += 1;
    await page.waitForTimeout(randomDelay(800, 1200));

    const currentCounts = await getProgressCounts();
    const progressed =
      currentCounts.wasNowCount > previousCounts.wasNowCount ||
      currentCounts.addToCartCount > previousCounts.addToCartCount;
    if (progressed) {
      noProgress = 0;
      previousCounts = currentCounts;
    } else {
      noProgress += 1;
      if (noProgress >= 2) {
        break;
      }
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(randomDelay());

  const scrapedAt = new Date().toISOString();

  await closeBlockingModals(page);

  const { rawProducts } = await page.evaluate(() => {
    const wasNowRegex = /Was:\s*\$([0-9.,]+)\s*to\s*Now:\s*\$([0-9.,]+)/i;
    const statusPatterns = [
      /in stock/i,
      /out of stock/i,
      /pickup only/i,
      /in store only/i
    ];

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

    const normalizeText = (value) =>
      (value || "").replace(/\s+/g, " ").trim();

    const isStatusLine = (line) =>
      statusPatterns.some((pattern) => pattern.test(line)) ||
      /Was:\s*\$/i.test(line) ||
      /Now:\s*\$/i.test(line) ||
      /Add to Cart/i.test(line) ||
      /Customer Rating/i.test(line);

    const getProductLink = (card) => {
      const anchors = Array.from(card.querySelectorAll("a[href]"));
      const preferred = anchors.find((anchor) =>
        /\/p\//i.test(anchor.getAttribute("href") || "")
      );
      const candidate = preferred || anchors[0];
      return candidate ? candidate.getAttribute("href") || "" : "";
    };

    const findTitle = (card) => {
      const text = normalizeText(card.innerText || "");
      if (!text) return "";
      const lines = text
        .split(/\n+/)
        .map((line) => normalizeText(line))
        .filter(Boolean);
      const titleLine = lines.find((line) => !isStatusLine(line));
      return titleLine || "";
    };

    const findStatus = (cardText) => {
      if (/out of stock/i.test(cardText)) return "Out of Stock";
      if (/pickup only/i.test(cardText)) return "Pickup Only";
      if (/in store only/i.test(cardText)) return "In Store Only";
      if (/in stock/i.test(cardText)) return "In Stock";
      return null;
    };

    const findRating = (cardText) => {
      const match = cardText.match(/([0-9.]+)\s+out of 5 Customer Rating/i);
      return match ? match[1] : null;
    };

    const wasNowNodes = Array.from(document.querySelectorAll("li, div, article, section"))
      .filter((el) => wasNowRegex.test(el.textContent || ""))
      .map((el) => el.closest("li, div, article, section") || el);

    const uniqueCards = [];
    const seen = new Set();
    for (const card of wasNowNodes) {
      if (!card) continue;
      const key = card.getAttribute("data-pid") || card;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCards.push(card);
    }

    const rawProducts = uniqueCards.map((card) => {
      const cardText = normalizeText(card.innerText || "");
      const priceMatch = cardText.match(wasNowRegex);
      const wasPrice = priceMatch ? priceMatch[1] : null;
      const price = priceMatch ? priceMatch[2] : null;

      return {
        title: findTitle(card),
        url: getProductLink(card),
        image: getImageUrl(card),
        price,
        wasPrice,
        availability: findStatus(cardText),
        rating: findRating(cardText)
      };
    });

    return { rawProducts };
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
      availability: product.availability || null,
      rating: product.rating || null,
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
      path: path.join(debugDir, `${store.storeId}_after_confirm.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeId}_after_confirm.html`),
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
        storeId: store.storeId,
        storeName: store.storeName,
        scrapedAt,
        count: products.length,
        products
      },
      null,
      2
    )
  );

  if (products.length > 0) {
    const header = [
      "storeId",
      "storeName",
      "title",
      "url",
      "price",
      "wasPrice",
      "discountPct",
      "availability",
      "rating",
      "image",
      "scrapedAt"
    ];
    const rows = products.map((product) =>
      [
        store.storeId,
        store.storeName,
        product.title || "",
        product.url || "",
        product.price ?? "",
        product.wasPrice ?? "",
        product.discountPct ?? "",
        product.availability ?? "",
        product.rating ?? "",
        product.image || "",
        product.scrapedAt
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",")
    );
    await fs.writeFile(
      path.join(outputDir, "data.csv"),
      [header.join(","), ...rows].join("\n")
    );
  }
};

scrapeStore().catch((error) => {
  console.error("[toysrus] scrape failed", error);
  process.exitCode = 1;
});
