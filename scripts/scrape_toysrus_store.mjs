import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const seedUrl = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const maxLoadMoreClicks = 80;

const randomDelay = (minMs = 700, maxMs = 1200) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const randomShortDelay = (minMs = 250, maxMs = 400) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const randomScrollDelay = (minMs = 300, maxMs = 800) =>
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

  try {
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
  } catch (error) {
    const message = String(error?.message || error);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Cannot find context")
    ) {
      return;
    }
    throw error;
  }

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
  const matchId = String(storeId).toLowerCase();
  return stores.find(
    (store) => String(store.storeId).toLowerCase() === matchId
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

  const storeName = store.name || store.storeName || "";
  const storeSearchName = store.searchText || storeName;
  if (!storeName) {
    throw new Error(`Store name missing for storeId=${store.storeId}`);
  }

  console.log(`[toysrus] store=${storeName} storeId=${store.storeId}`);

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
  const postalModal = page.locator("#js-modal-postal");
  if (await postalModal.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
    await postalModal
      .locator('button[aria-label="Close"], .close, button:has-text("×")')
      .first()
      .click()
      .catch(() => {});
  }
  await page.waitForTimeout(1000);

  const storeBtn = page
    .locator(
      "button.js-btn-get-store, button[aria-label*='Select Your Store' i]"
    )
    .first();

  await handleOneTrust(page);
  await storeBtn.waitFor({ state: "visible", timeout: 30000 });
  await storeBtn.click({ timeout: 30000 });

  const searchInput = page
    .locator(
      "input[placeholder*='Enter a Location' i]:visible, input[aria-label*='Enter a Location' i]:visible, input[type='search']:visible"
    )
    .first();
  await searchInput.waitFor({ state: "visible", timeout: 30000 });
  const modal = searchInput.locator(
    "xpath=ancestor::*[self::div or self::section or self::form][1]"
  );
  await searchInput.click({ timeout: 15000 });
  await searchInput.fill("");
  await searchInput.type(storeSearchName, { delay: 50 });
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
    const normalizedStore = normalizeStoreText(storeName);
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

  const storeNameRegex = new RegExp(escapeRegExp(storeName), "i");
  const resultsArea = modal
    .locator(
      ".store-results, [data-testid*='store-results'], .b-locator_results, ul, .results"
    )
    .first();
  await resultsArea.waitFor({ state: "visible", timeout: 30000 });

  const storeRow = resultsArea
    .locator(":scope *")
    .filter({ hasText: new RegExp(storeName, "i") })
    .first();

  try {
    await storeRow.waitFor({ state: "visible", timeout: 30000 });
  } catch {
    await page.screenshot({
      path: path.join(debugDir, `${store.storeId}_modal.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeId}_modal.html`),
      await page.content()
    );
    throw new Error(`No store match found for ${storeName}`);
  }

  const chosenStoreText = (await storeRow.innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
  console.log(`[toysrus] chosenStoreText=${chosenStoreText}`);

  if (isStrongStoreMatch(chosenStoreText)) {
    try {
      await storeRow.click({ timeout: 2000 });
    } catch {
      // ignore if row isn't clickable
    }
  }

  const confirmButton = storeRow
    .locator(
      "button.js-select-store, button:has-text('Confirm as My Store'), button:has-text('Confirmer comme mon magasin')"
    )
    .first();
  await resultsArea.evaluate((el) => {
    el.scrollTop = 0;
  });
  try {
    await confirmButton.scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch {
    await resultsArea.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await confirmButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  }

  let confirmClicked = false;
  try {
    await confirmButton.click({ timeout: 8000 });
    confirmClicked = true;
  } catch (error) {
    console.warn("[toysrus] confirm button click failed, falling back", error);
  }

  if (!confirmClicked) {
    const handle = await confirmButton.elementHandle();
    if (handle) {
      await page.evaluate((btn) => btn.click(), handle);
      confirmClicked = true;
    }
  }

  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }),
    page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
  ]);

  await page.waitForFunction(
    (expectedStore) => {
      const normalizeText = (value) =>
        (value || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const header = document.querySelector("header");
      const text = normalizeText(header ? header.innerText : "");
      return text.includes("my store") && text.includes(normalizeText(expectedStore));
    },
    storeName,
    { timeout: 30000 }
  );

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
      path: path.join(debugDir, `${store.storeId}_after_confirm.png`),
      fullPage: true
    });
    await fs.writeFile(
      path.join(debugDir, `${store.storeId}_after_confirm.html`),
      await page.content()
    );
    throw new Error(
      `My Store mismatch: header="${headerText}" expected store="${storeName}"`
    );
  }
  console.log(`[toysrus] My Store confirmed: ${storeName}`);
  await modal
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => null);
  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }),
    page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
  ]);
  await closeBlockingModals(page);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
  await Promise.allSettled([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }),
    page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
  ]);
  await closeBlockingModals(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await handleOneTrust(page);
    await page.waitForTimeout(400);
  }
  await closeBlockingModals(page);

  await page.goto(seedUrl, { waitUntil: "domcontentloaded" });

  await handleOneTrust(page);
  await page.waitForTimeout(1000);
  await closeBlockingModals(page);
  const postalClose = page
    .locator("button[aria-label='Close'], .modal button.close, button:has-text('×')")
    .first();
  if (await postalClose.isVisible().catch(() => false)) {
    await postalClose.click().catch(() => {});
  }
  const productLoc = page
    .locator("a[href*='/p/'], .product-tile, [data-test*='product']")
    .first();
  await productLoc.waitFor({ state: "visible", timeout: 45000 });
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
      "button:has-text('Load More'):visible, button:has-text('LOAD MORE'):visible, a:has-text('Load More'):visible, a:has-text('LOAD MORE'):visible, [role='button']:has-text('Load More'):visible, [role='button']:has-text('LOAD MORE'):visible"
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
    "button:has-text('Load More'):visible, button:has-text('LOAD MORE'):visible, a:has-text('Load More'):visible, a:has-text('LOAD MORE'):visible, [role='button']:has-text('Load More'):visible, [role='button']:has-text('LOAD MORE'):visible"
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

  const getProductCardCount = async () =>
    page.locator("a[href*='/p/']").count().catch(() => 0);
  let previousCardCount = await getProductCardCount();

  for (let i = 0; i < maxLoadMoreClicks; i += 1) {
    await closeBlockingModals(page);
    const isVisible = await loadMoreLocator.first().isVisible().catch(() => false);
    if (!isVisible) {
      break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomScrollDelay());

    await handleOneTrust(page);
    await loadMoreLocator.first().click({ timeout: 15000 }).catch(() => null);
    loadMoreClicks += 1;
    await page.waitForTimeout(randomDelay(800, 1200));

    const currentCounts = await getProgressCounts();
    const progressed =
      currentCounts.wasNowCount > previousCounts.wasNowCount ||
      currentCounts.addToCartCount > previousCounts.addToCartCount;
    const currentCardCount = await getProductCardCount();
    if (progressed) {
      noProgress = 0;
      previousCounts = currentCounts;
      previousCardCount = currentCardCount;
    } else {
      noProgress += 1;
      const cardProgress = currentCardCount > previousCardCount;
      if (cardProgress) {
        noProgress = 0;
        previousCardCount = currentCardCount;
      } else if (noProgress >= 2) {
        break;
      }
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(randomDelay());

  const scrapedAt = new Date().toISOString();

  await closeBlockingModals(page);

  const collectProducts = () =>
    page.evaluate(() => {
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

  const { rawProducts } = await collectProducts();
  let extraProducts = [];

  const missingImages = rawProducts.filter((product) => !product.image).length;
  if (missingImages > 0) {
    for (let i = 0; i < 2; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(randomScrollDelay());
    }
    const retry = await collectProducts();
    extraProducts = retry.rawProducts;
  }

  const allRawProducts = [...rawProducts, ...extraProducts, ...apiProducts];

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

  const outputDir = path.join("data", "toysrus", String(store.storeId));
  await ensureDir(outputDir);
  await fs.writeFile(
    path.join(outputDir, "data.json"),
    JSON.stringify(
      {
        seedUrl,
        storeId: String(store.storeId),
        storeName,
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
        String(store.storeId),
        storeName,
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
