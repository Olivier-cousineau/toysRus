import fs from "node:fs";
import path from "path";
import { chromium } from "playwright";

const CLEARANCE_URL = "https://www.toysrus.ca/en/toysrus/CLEARANCE";
const MAX_LOADMORE_CLICKS = Number(process.env.MAX_LOADMORE_PRODUCTS) || 80;

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
  await fs.promises.mkdir(dir, { recursive: true });
};

const dumpDebug = async (page, tag) => {
  await fs.promises.mkdir("outputs/debug", { recursive: true }).catch(() => {});
  await page
    .screenshot({ path: `outputs/debug/${tag}.png`, fullPage: true })
    .catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.promises.writeFile(`outputs/debug/${tag}.html`, html).catch(() => {});
};

const STORE_SELECTOR_TRIGGER =
  "button.btn-storelocator-search-header.js-storelocator-search";
const STORE_INPUT = "input#store-postal-code.js-storelocator-input";
const STORE_SELECTOR_INPUT = STORE_INPUT;

const storeSources = [
  "stores.json",
  "toysrus_stores.json",
  path.join("public", "toysrus", "stores.json")
];

const readStores = async () => {
  for (const source of storeSources) {
    try {
      const raw = await fs.promises.readFile(source, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
};

const findStore = (stores, storeId) => {
  if (!storeId) return null;
  const matchId = String(storeId).toLowerCase();
  return stores.find(
    (store) => String(store.storeId).toLowerCase() === matchId
  );
};

const normalizeStoreText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCity = (value) =>
  normalizeStoreText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const slugify = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildStoreLabel = (store) => {
  const city = normalizeStoreText(store?.city);
  const province = normalizeStoreText(
    store?.province ?? store?.state ?? store?.region
  );
  const name = normalizeStoreText(
    store?.name ?? store?.storeName ?? store?.searchText
  );
  const parts = [];
  if (city) parts.push(city);
  if (province) parts.push(province);
  if (!parts.length && name) parts.push(name);
  return parts.length ? parts.join(", ") : null;
};

const resolveStoreInput = async ({ storeId, city, name }) => {
  if (city) {
    return {
      storeId,
      city,
      name,
      label: buildStoreLabel({ city, name }) ?? null,
      usedFallback: false
    };
  }

  const stores = await readStores();
  if (!stores) {
    console.warn("[toysrus] store list not found, using fallback city=unknown");
    return {
      storeId,
      city: "unknown",
      name: name ?? null,
      label: buildStoreLabel({ city: "unknown", name }) ?? null,
      usedFallback: true
    };
  }

  const store = findStore(stores, storeId);
  if (!store) {
    console.warn("[toysrus] store-id not found, using fallback");
    return {
      storeId,
      city: "unknown",
      name: name ?? null,
      label: buildStoreLabel({ city: "unknown", name }) ?? null,
      usedFallback: true
    };
  }

  const resolvedCity =
    normalizeStoreText(store.city) ||
    normalizeStoreText(store.province ?? store.state ?? store.region) ||
    normalizeStoreText(
      store.name ?? store.storeName ?? store.searchText ?? store.city
    ) ||
    "unknown";
  const resolvedName =
    name ??
    normalizeStoreText(store.name ?? store.storeName ?? store.searchText) ??
    null;
  const label = buildStoreLabel(store) ?? resolvedName ?? resolvedCity;

  return {
    storeId,
    city: resolvedCity,
    name: resolvedName,
    label,
    usedFallback: !store.city
  };
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

const dismissOverlays = async (page) => {
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

  await dismissOverlays(page);

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

const forceStoreSelectorVisible = async (page) => {
  await page
    .evaluate(() => {
      const modal = document.querySelector("#storeSelectorModal");
      const dialog = modal?.closest("[role='dialog'], .modal, dialog") ?? modal;
      [modal, dialog].filter(Boolean).forEach((element) => {
        element.style.display = "block";
        element.style.visibility = "visible";
        element.style.opacity = "1";
        element.style.pointerEvents = "auto";
        element.classList.remove("hidden");
        element.removeAttribute("aria-hidden");
      });
    })
    .catch(() => {});
};

const logStoreSelectorStyles = async (page) => {
  const styles = await page
    .evaluate((inputSelector) => {
      const input = document.querySelector(inputSelector);
      const modal = document.querySelector("#storeSelectorModal");
      const dialog = modal?.closest("[role='dialog'], .modal, dialog") ?? modal;
      const describe = (element) => {
        if (!element) return null;
        const computed = window.getComputedStyle(element);
        return {
          tag: element.tagName,
          id: element.id || null,
          className: element.className || null,
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity
        };
      };
      return {
        input: describe(input),
        modal: describe(modal),
        dialog: describe(dialog)
      };
    }, STORE_SELECTOR_INPUT)
    .catch(() => null);

  if (styles) {
    console.warn("[toysrus] store selector computed styles", styles);
  }
  return styles;
};

const dumpStoreSelectorDebug = async (page) => {
  await page
    .screenshot({ path: "debug_store_selector.png", fullPage: true })
    .catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.promises
    .writeFile("debug_store_selector.html", html)
    .catch(() => {});
  const styles = await logStoreSelectorStyles(page);
  if (styles) {
    await fs.promises
      .writeFile(
        "debug_store_selector_styles.json",
        JSON.stringify(styles, null, 2)
      )
      .catch(() => {});
  }
};

const dumpStoreListDebug = async (page) => {
  await page
    .screenshot({ path: "debug_store_list.png", fullPage: true })
    .catch(() => {});
  const html = await page.content().catch(() => "");
  await fs.promises.writeFile("debug_store_list.html", html).catch(() => {});
};

const isStoreSelectorOpen = async (page) => {
  const input = page.locator(STORE_INPUT).first();
  return (await input.count()) > 0 && await input.isVisible().catch(() => false);
};

const openStoreSelector = async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await dismissOverlays(page);
  const triggerLocator = page.locator(STORE_SELECTOR_TRIGGER);
  await triggerLocator.first().waitFor({ state: "attached", timeout: 20000 });

  const triggerCount = await triggerLocator.count();
  let trigger = triggerLocator.first();
  for (let i = 0; i < triggerCount; i += 1) {
    const candidate = triggerLocator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      trigger = candidate;
      break;
    }
  }

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.focus().catch(() => {});
  await closeOverlays(page);
  await trigger
    .click({ timeout: 15000 })
    .catch(() => trigger.click({ timeout: 15000, force: true }))
    .catch(async () => {
      await page.evaluate((selector) => {
        document.querySelector(selector)?.click();
      }, STORE_SELECTOR_TRIGGER);
    });

  await forceStoreSelectorVisible(page);
  await page
    .locator(STORE_SELECTOR_INPUT)
    .first()
    .waitFor({ state: "attached", timeout: 15000 });
};

const fillStoreLocatorInput = async (page, inputLocator, value) => {
  await inputLocator.waitFor({ state: "attached", timeout: 15000 });
  await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
  await inputLocator.click({ force: true }).catch(() => {});

  try {
    await inputLocator.fill(value, { timeout: 8000 });
    return;
  } catch (error) {
    await inputLocator
      .evaluate((element, nextValue) => {
        element.value = nextValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, value)
      .catch(() => {});
  }
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
  try {
    const storeLocatorInput = page
      .locator(STORE_SELECTOR_INPUT)
      .first();
    let storeLocatorReady = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await closeOverlays(page);
      if (!(await isStoreSelectorOpen(page))) {
        await openStoreSelector(page);
      } else {
        console.log("[toysrus] store selector already open; skipping Find Stores click");
      }
      await closeOverlays(page);

      try {
        await forceStoreSelectorVisible(page);
        await storeLocatorInput.waitFor({ state: "attached", timeout: 15000 });
        storeLocatorReady = true;
        break;
      } catch (error) {
        await forceStoreSelectorVisible(page);
        if (attempt === 2) {
          throw error;
        }
      }
    }

    if (!storeLocatorReady) {
      throw new Error("Store locator input not ready after retries.");
    }

    await fillStoreLocatorInput(page, storeLocatorInput, city);
    await storeLocatorInput.press("Enter").catch(() => {});

    const autoCompleteSuggestion = page.locator(".pac-container .pac-item").first();
    if (await autoCompleteSuggestion.isVisible().catch(() => false)) {
      await autoCompleteSuggestion.click({ timeout: 5000 }).catch(() => {});
    }

    const modalSearchButton = page
      .locator(
        "#storeSelectorModal button:has-text('Search'), #storeSelectorModal button:has-text('Find')"
      )
      .first();
    if (await modalSearchButton.isVisible().catch(() => false)) {
      await modalSearchButton.click({ timeout: 10000 }).catch(async () => {
        await modalSearchButton.click({ timeout: 10000, force: true });
      });
    }
  } catch (error) {
    await dumpStoreSelectorDebug(page);
    throw error;
  }

  await page.waitForTimeout(randomDelay());
  await setRadiusTo100(page);
  await closeOverlays(page);

  const storeCardLocator = page.locator("#storeSelectorModal .js-card-body.b-locator_card");
  await storeCardLocator.first().waitFor({ state: "attached", timeout: 30000 });

  const targetCity = normalizeCity(city);
  const cardCount = await storeCardLocator.count();
  let matchedStoreId = null;
  let matchedInfo = null;

  for (let i = 0; i < cardCount; i += 1) {
    const card = storeCardLocator.nth(i);
    const infoRaw = await card.getAttribute("data-store-info").catch(() => null);
    if (!infoRaw) continue;

    const decoded = await page.evaluate((value) => {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = value;
      return textarea.value;
    }, infoRaw);

    let info;
    try {
      info = JSON.parse(decoded);
    } catch {
      continue;
    }

    const candidateCity = normalizeCity(info?.city || info?.name || "");
    if (!candidateCity) continue;
    if (!candidateCity.includes(targetCity) && !targetCity.includes(candidateCity)) {
      continue;
    }

    const rawId = info?.ID ?? info?.id ?? info?.storeId;
    const cardId = await card.getAttribute("id").catch(() => null);
    const resolvedId = String(rawId ?? cardId ?? "").trim();
    if (!resolvedId) continue;

    matchedStoreId = resolvedId;
    matchedInfo = info;
    break;
  }

  if (!matchedStoreId) {
    const maxLogs = Math.min(cardCount, 10);
    if (maxLogs) {
      console.warn("[toysrus] store selector list (first 10):");
    }
    for (let i = 0; i < maxLogs; i += 1) {
      const card = storeCardLocator.nth(i);
      const infoRaw = await card.getAttribute("data-store-info").catch(() => null);
      if (!infoRaw) continue;
      const decoded = await page.evaluate((value) => {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }, infoRaw);
      try {
        const info = JSON.parse(decoded);
        console.warn(
          `[toysrus] store ${i + 1}: id=${info?.ID ?? info?.id ?? ""} city=${
            info?.city ?? info?.name ?? ""
          }`
        );
      } catch {
        console.warn(`[toysrus] store ${i + 1}: data-store-info parse failed`);
      }
    }
    await dumpStoreListDebug(page);
    throw new Error(`City not found in store selector list: city=${city}`);
  }

  console.log(
    `[toysrus] matched store selector storeId=${matchedStoreId} city=${
      matchedInfo?.city ?? matchedInfo?.name ?? ""
    }`
  );

  const storeButtonLocator = page
    .locator(`button.js-select-store[value="${matchedStoreId}"]`)
    .first();
  await storeButtonLocator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await closeOverlays(page);
    await storeButtonLocator.click({ timeout: 15000 });
  } catch (error) {
    console.warn("[toysrus] store select click failed, retrying", error);
    await storeButtonLocator.click({ timeout: 15000, force: true });
  }

  console.log(
    `[toysrus] store confirmed storeId=${storeId ?? ""} name=${name ?? ""} city=${city}`
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

const runSingleStore = async ({ storeId, city, name, allowStoreFallback }) => {
  if (!city) {
    throw new Error("--city is required for single store runs");
  }

  const citySlug = slugify(city) || "unknown-city";
  const outputSlug = storeId
    ? `${String(storeId)}-${citySlug}`
    : citySlug;
  const storeIdValue = storeId ? String(storeId) : null;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(CLEARANCE_URL, { waitUntil: "domcontentloaded" });
    await closeOverlays(page);

    try {
      await setMyStoreByCityAndId(page, { city, storeId, name });
    } catch (error) {
      if (!allowStoreFallback) {
        throw error;
      }
      console.warn(
        `[toysrus] store selection failed with fallback city="${city}", continuing without store selection`
      );
    }

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

    const outputDir = path.join("data", "toysrus", outputSlug);
    await ensureDir(outputDir);

    await fs.promises.writeFile(
      path.join(outputDir, "data.json"),
      JSON.stringify(
        {
          storeId: storeIdValue,
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

    await fs.promises.writeFile(
      path.join(outputDir, "meta.json"),
      JSON.stringify(
        {
          storeId: storeIdValue,
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
        storeIdValue ?? "",
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
    await fs.promises.writeFile(
      path.join(outputDir, "data.csv"),
      [header.join(","), ...rows].join("\n")
    );
  } catch (error) {
    await dumpDebug(page, `${outputSlug}_step_failure`);
    throw error;
  } finally {
    await browser.close();
  }
};

const scrapeStore = async () => {
  const { storeId, city, name, all } = parseArgs();

  if (all) {
    const stores = await readStores();
    if (!stores) {
      throw new Error("Store list not found for --all runs");
    }
    for (const store of stores) {
      const resolved = await resolveStoreInput({
        storeId: store.storeId,
        city: store.city,
        name: store.name ?? store.storeName ?? store.searchText
      });
      await runSingleStore({
        storeId: resolved.storeId,
        city: resolved.city,
        name: resolved.name ?? resolved.label,
        allowStoreFallback: resolved.usedFallback
      });
    }
    return;
  }

  if (!storeId) {
    if (!city) {
      throw new Error("--city is required unless --all is provided");
    }
  }

  const resolved = await resolveStoreInput({ storeId, city, name });
  await runSingleStore({
    storeId: resolved.storeId,
    city: resolved.city,
    name: resolved.name ?? resolved.label,
    allowStoreFallback: resolved.usedFallback
  });
};

scrapeStore().catch((error) => {
  console.error("[toysrus] scrape failed", error);
  process.exitCode = 1;
});
