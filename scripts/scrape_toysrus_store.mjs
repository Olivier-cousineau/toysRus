import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const CLEARANCE_URL = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const MAX_LOADMORE_CLICKS = Number(process.env.MAX_LOADMORE_PRODUCTS) || 80;
const MAX_STORE_LOADMORE_CLICKS = 40;

const randomDelay = (minMs = 700, maxMs = 1200) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const randomShortDelay = (minMs = 250, maxMs = 400) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const randomScrollDelay = (minMs = 300, maxMs = 800) =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

const normalizeUrl = (value) => {
  try {
    const url = new URL(value, CLEARANCE_URL);
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

const dumpDebug = async (page, tag) => {
  await fs.mkdir("outputs/debug", { recursive: true }).catch(() => {});
  await page
    .screenshot({ path: `outputs/debug/${tag}.png`, fullPage: true })
    .catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.writeFile(`outputs/debug/${tag}.html`, html).catch(() => {});
};

const readStores = async () => {
  const raw = await fs.readFile(path.join("stores.json"), "utf8");
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
  const getArg = (flag) => {
    const index = args.findIndex((value) => value === flag);
    return index >= 0 ? args[index + 1] : null;
  };

  return {
    storeId: getArg("--store-id") || getArg("--storeId"),
    city: getArg("--city"),
    name: getArg("--name"),
    all: args.includes("--all")
  };
};

const closeOverlays = async (page) => {
  // Postal-code preference modal (blocks clicks + hides store locator inputs)
  try {
    const postalModal = page
      .locator("#js-modal-postal, .js-modal-postal, .modal.js-modal-postal")
      .first();
    if (await postalModal.count()) {
      // If visible, close it
      if (await postalModal.isVisible().catch(() => false)) {
        // Try close buttons
        await postalModal
          .locator(
            'button[aria-label="Close"], button:has-text("×"), .close, .modal-close'
          )
          .first()
          .click()
          .catch(() => {});
        // Or hit Escape
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // Also remove active backdrops that intercept pointer events
    await page
      .evaluate(() => {
        const selectors = [
          ".js-dialog-backdrop.is-active",
          ".b-pdp-instore_panel.js-dialog-backdrop.is-active",
          ".onetrust-pc-dark-filter.ot-fade-in"
        ];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            el.style.pointerEvents = "none";
            el.style.opacity = "0";
          });
        }
      })
      .catch(() => {});
  } catch {}

  const tryClick = async (locator) => {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
    return false;
  };

  await tryClick(
    page
      .locator(
        "#onetrust-accept-btn-handler, button:has-text('Accept All'), button:has-text('Tout accepter')"
      )
      .first()
  );

  const closeButtons = page.locator(
    "button:has-text('×'), button:has-text('Close'), button:has-text('Fermer'), button[aria-label='Close']"
  );
  await tryClick(closeButtons.first());

  try {
    await page.evaluate(() => {
      const pointerBlockers = [
        ".ot-fade-in",
        ".onetrust-pc-dark-filter",
        "#onetrust-consent-sdk",
        ".js-dialog-backdrop.is-active",
        "#js-modal-postal.modal"
      ];

      pointerBlockers.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
          element.style.pointerEvents = "none";
          element.style.visibility = "hidden";
        });
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

const openStoreSelector = async (page) => {
  const trigger = page
    .locator(
      "button:has-text('Select Your Store'), button:has-text('Select My Store'), button:has-text('My Store'), a:has-text('Select Your Store'), a:has-text('My Store')"
    )
    .first();
  await trigger.waitFor({ state: "visible", timeout: 20000 });
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await closeOverlays(page);
  await trigger.click({ timeout: 15000 }).catch(async () => {
    await trigger.click({ timeout: 15000, force: true });
  });
};

const setRadiusTo100 = async (page) => {
  const optionLocator = page.locator("option", { hasText: /100\s*km/i });
  const selectLocator = page.locator("select").filter({ has: optionLocator });

  if (await selectLocator.first().isVisible().catch(() => false)) {
    await selectLocator.first().selectOption({ label: /100\s*km/i }).catch(() => {});
    return;
  }

  const combobox = page
    .locator(
      "[role='combobox']:has-text('km'), button:has-text('km'), button:has-text('KM')"
    )
    .first();
  if (await combobox.isVisible().catch(() => false)) {
    await combobox.click({ timeout: 5000 }).catch(() => {});
    const option = page.locator("text=/100\s*km/i").first();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ timeout: 5000 }).catch(() => {});
    }
  }
};

const setMyStoreByCityAndId = async (page, { city, storeId, name }) => {
  await closeOverlays(page);
  await openStoreSelector(page);
  await closeOverlays(page);

  const locatorRoot = page
    .locator(".b-locator, .b-locator_modal, .b-store-modal, [role='dialog']")
    .filter({
      has: page.locator("text=/Find Stores|Use My Location|Radius/i")
    })
    .first();
  await locatorRoot.waitFor({ state: "visible", timeout: 30000 });

  const locationInput = locatorRoot
    .locator(
      "input[placeholder*='Street Address' i], input[placeholder*='City' i], input[placeholder*='Province' i], input[placeholder*='Enter a Location' i]"
    )
    .filter({ hasNot: page.locator("#locationPostalCode") })
    .first();
  await locationInput.waitFor({ state: "visible", timeout: 20000 });
  await locationInput.fill(city);

  const findStoresButton = locatorRoot
    .locator("button:has-text('Find Stores'), button:has-text('Find Store')")
    .first();
  await closeOverlays(page);
  await findStoresButton.click({ timeout: 10000 }).catch(async () => {
    await findStoresButton.click({ timeout: 10000, force: true });
  });

  await page.waitForTimeout(randomDelay());
  await setRadiusTo100(page);
  await closeOverlays(page);

  const storeButtonLocator = page
    .locator(
      `button.js-select-store[value="${storeId}"], button[value="${storeId}"]`
    )
    .first();
  const storeLoadMoreLocator = page.locator(
    "button:has-text('Load More'), a:has-text('Load More'), [role='button']:has-text('Load More')"
  );

  let storeLoadMoreClicks = 0;
  let storeFound = false;

  for (let i = 0; i < MAX_STORE_LOADMORE_CLICKS; i += 1) {
    await closeOverlays(page);
    if (await storeButtonLocator.isVisible().catch(() => false)) {
      storeFound = true;
      break;
    }

    const loadMoreVisible = await storeLoadMoreLocator
      .first()
      .isVisible()
      .catch(() => false);
    if (!loadMoreVisible) {
      break;
    }

    await storeLoadMoreLocator.first().scrollIntoViewIfNeeded().catch(() => {});
    await storeLoadMoreLocator.first().click({ timeout: 15000 }).catch(() => null);
    storeLoadMoreClicks += 1;
    await page.waitForTimeout(randomDelay());
  }

  console.log(`[toysrus] storeLoadMoreClicks=${storeLoadMoreClicks}`);

  if (!storeFound) {
    const modalText = await page
      .locator("[role='dialog'], .modal, .store-locator, .store-locator__results")
      .first()
      .innerText()
      .catch(() => "");
    const snippet = modalText.replace(/\s+/g, " ").trim().slice(0, 400);
    throw new Error(
      `StoreId not found in selector list: storeId=${storeId} city=${city} text="${snippet}"`
    );
  }

  const storeRow = storeButtonLocator
    .locator("xpath=ancestor::*[self::li or self::div][1]")
    .first();
  const chosenStoreText = (await storeRow.innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
  console.log(`[toysrus] chosenStoreText="${chosenStoreText}"`);

  await storeButtonLocator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await closeOverlays(page);
    await storeButtonLocator.click({ timeout: 15000 });
  } catch (error) {
    console.warn("[toysrus] store select click failed, retrying", error);
    await storeButtonLocator.click({ timeout: 15000, force: true });
    if (!(await storeButtonLocator.isVisible().catch(() => false))) {
      await storeRow.click({ timeout: 10000 }).catch(() => {});
      await storeButtonLocator.click({ timeout: 15000, force: true });
    }
  }

  console.log(
    `[toysrus] store confirmed storeId=${storeId} name=${name ?? ""} city=${city}`
  );
  await page.waitForTimeout(randomDelay());
};

const waitForProductGrid = async (page) => {
  const gridLocator = page
    .locator("a[href*='/p/'], .product-tile, [data-test*='product']")
    .first();
  await gridLocator.waitFor({ state: "visible", timeout: 45000 });
};

const clickLoadMoreProducts = async (page) => {
  const loadMoreLocator = page.locator(
    "button:has-text('Load More'), a:has-text('Load More'), [role='button']:has-text('Load More')"
  );
  let loadMoreClicks = 0;

  for (let i = 0; i < MAX_LOADMORE_CLICKS; i += 1) {
    await closeOverlays(page);
    const isVisible = await loadMoreLocator.first().isVisible().catch(() => false);
    if (!isVisible) {
      break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomScrollDelay());

    await loadMoreLocator.first().click({ timeout: 15000 }).catch(() => null);
    loadMoreClicks += 1;
    await page.waitForTimeout(randomDelay(800, 1200));
  }

  return loadMoreClicks;
};

const extractProducts = async (page) =>
  page.evaluate(() => {
    const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const priceNowRegex = /Now:\s*\$?([0-9.,]+)/i;
    const priceWasRegex = /Was:\s*\$?([0-9.,]+)/i;
    const badgeRegex = /Pickup Only|In Store Only|Out of Stock|In Stock/gi;

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

    const getProductLink = (card) => {
      const directAnchor = card.querySelector("a[href*='/p/']");
      if (directAnchor) {
        return directAnchor.getAttribute("href") || "";
      }
      const anchor = card.querySelector("a[href]");
      return anchor ? anchor.getAttribute("href") || "" : "";
    };

    const getTitle = (card) => {
      const heading = card.querySelector("h2, h3, h4, [data-test*='product-name']");
      if (heading) {
        return normalizeText(heading.textContent || "");
      }
      const anchor = card.querySelector("a[href*='/p/']");
      if (anchor) {
        return normalizeText(anchor.textContent || "");
      }
      return "";
    };

    const candidateSelectors = [
      "[data-test*='product']",
      ".product-tile",
      "li.product-grid__item",
      "article",
      "li"
    ];

    const candidateCards = new Set();
    candidateSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        if (element.querySelector("a[href*='/p/']")) {
          candidateCards.add(element);
        }
      });
    });

    const cards = Array.from(candidateCards);

    return cards.map((card) => {
      const text = normalizeText(card.innerText || "");
      const nowMatch = text.match(priceNowRegex);
      const wasMatch = text.match(priceWasRegex);
      const badges = Array.from(text.matchAll(badgeRegex)).map((match) => match[0]);

      return {
        title: getTitle(card),
        url: getProductLink(card),
        image: getImageUrl(card),
        priceNow: nowMatch ? nowMatch[1] : null,
        priceWas: wasMatch ? wasMatch[1] : null,
        badges
      };
    });
  });

const runSingleStore = async ({ storeId, city, name }) => {
  if (!storeId || !city) {
    throw new Error("--store-id and --city are required for single store runs");
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(CLEARANCE_URL, { waitUntil: "domcontentloaded" });
    await closeOverlays(page);

    await setMyStoreByCityAndId(page, { city, storeId, name });

    await page.goto(CLEARANCE_URL, { waitUntil: "domcontentloaded" });
    await closeOverlays(page);

    await waitForProductGrid(page);

    const loadMoreClicks = await clickLoadMoreProducts(page);
    console.log(`[toysrus] loadMoreClicks=${loadMoreClicks}`);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomDelay());

    await closeOverlays(page);

    const rawProducts = await extractProducts(page);

    const scrapedAt = new Date().toISOString();
    const products = [];
    const seen = new Set();

    for (const product of rawProducts) {
      const normalizedUrl = normalizeUrl(product.url);
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        continue;
      }

      products.push({
        title: product.title || null,
        url: normalizedUrl,
        image: product.image
          ? new URL(product.image, CLEARANCE_URL).toString()
          : null,
        priceNow: parsePrice(String(product.priceNow ?? "")),
        priceWas: parsePrice(String(product.priceWas ?? "")),
        badges: product.badges || [],
        scrapedAt
      });
      seen.add(normalizedUrl);
    }

    console.log(`[toysrus] extracted=${rawProducts.length} unique=${products.length}`);

    const outputDir = path.join("data", "toysrus", String(storeId));
    await ensureDir(outputDir);

    await fs.writeFile(
      path.join(outputDir, "data.json"),
      JSON.stringify(
        {
          storeId: String(storeId),
          storeName: name ?? null,
          city,
          scrapedAt,
          count: products.length,
          products
        },
        null,
        2
      )
    );

    await fs.writeFile(
      path.join(outputDir, "meta.json"),
      JSON.stringify(
        {
          storeId: String(storeId),
          name: name ?? null,
          city,
          ts: scrapedAt,
          total: products.length
        },
        null,
        2
      )
    );

    const header = [
      "storeId",
      "storeName",
      "city",
      "title",
      "url",
      "priceNow",
      "priceWas",
      "badges",
      "image",
      "scrapedAt"
    ];
    const rows = products.map((product) =>
      [
        String(storeId),
        name ?? "",
        city,
        product.title || "",
        product.url || "",
        product.priceNow ?? "",
        product.priceWas ?? "",
        (product.badges || []).join(" | "),
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
  } catch (error) {
    await dumpDebug(page, `${storeId}_step_failure`);
    throw error;
  } finally {
    await browser.close();
  }
};

const scrapeStore = async () => {
  const { storeId, city, name, all } = parseArgs();

  if (all) {
    const stores = await readStores();
    for (const store of stores) {
      await runSingleStore({
        storeId: store.storeId,
        city: store.city,
        name: store.name
      });
    }
    return;
  }

  if (!storeId || !city) {
    throw new Error("--store-id and --city are required (or use --all)");
  }

  await runSingleStore({ storeId, city, name });
};

scrapeStore().catch((error) => {
  console.error("[toysrus] scrape failed", error);
  process.exitCode = 1;
});
