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

  const debugDir = path.join("outputs", "debug");
  await ensureDir(debugDir);

  const response = await page.goto(seedUrl, { waitUntil: "domcontentloaded" });
  console.log(`[toysrus] responseStatus=${response?.status() ?? "unknown"}`);
  console.log(`[toysrus] finalUrl=${page.url()}`);
  console.log(`[toysrus] title=${await page.title()}`);

  await page.waitForLoadState("networkidle");
  await handleOneTrust(page);
  let selectorFound = true;
  try {
    await page
      .getByText(/Showing \d+ of \d+ products/i)
      .first()
      .waitFor({ timeout: 20000 });
  } catch {
    selectorFound = false;
  }

  await page.screenshot({
    path: path.join(debugDir, "clearance.png"),
    fullPage: true
  });
  await fs.writeFile(
    path.join(debugDir, "clearance.html"),
    await page.content()
  );

  if (!selectorFound) {
    throw new Error("No products rendered...");
  }

  await page.waitForTimeout(randomDelay());

  let loadMoreClicks = 0;
  for (let i = 0; i < maxLoadMoreClicks; i += 1) {
    const loadMoreButton = page.locator('button:has-text("Load more")');
    const isVisible = await loadMoreButton.first().isVisible().catch(() => false);
    if (!isVisible) {
      break;
    }

    const addToCartCount = await page
      .locator("button", { hasText: /Add to Cart|Ajouter au panier/i })
      .count()
      .catch(() => 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(randomDelay());

    await handleOneTrust(page);
    await loadMoreButton.first().click();
    loadMoreClicks += 1;
    console.log(`[toysrus] loadMore click ${loadMoreClicks}`);
    await page.waitForTimeout(randomDelay());
    try {
      await page.waitForFunction(
        (previousCount) => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const consider = buttons.filter((button) =>
            /Add to Cart|Ajouter au panier/i.test(button.textContent || "")
          );
          return consider.length > previousCount;
        },
        addToCartCount,
        { timeout: 15000 }
      );
    } catch {
      break;
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(randomDelay());

  const scrapedAt = new Date().toISOString();

  const { rawProducts, hrefs } = await page.evaluate(() => {
    const wasNowRegex = /Was:\s*(\$[\d.,]+)\s*to\s*Now:\s*(\$[\d.,]+)/i;

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

    const parsePrice = (value) => {
      const normalized = value.replace(/[^\d.,]/g, "").replace(/,/g, "");
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const pickTitleFromText = (cardText) => {
      const lines = cardText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const priceIndex = lines.findIndex((line) =>
        /Was:\s*\$|Now:\s*\$|\$\s*\d|\d+\.\d{2}/i.test(line)
      );
      if (priceIndex > 0) {
        return lines[priceIndex - 1];
      }
      return lines[0] || "";
    };

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

    const addToCartButtons = Array.from(
      document.querySelectorAll("button")
    ).filter((button) =>
      /Add to Cart|Ajouter au panier/i.test(button.textContent || "")
    );
    const cards = addToCartButtons
      .map((button) => {
        const result = document.evaluate(
          "ancestor::*[self::li or self::div][1]",
          button,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return result.singleNodeValue;
      })
      .filter(Boolean);

    const uniqueCards = Array.from(new Set(cards));

    const hrefs = uniqueCards.map((card) => getProductLink(card)).filter(Boolean);

    const rawProducts = uniqueCards.map((card) => {
      const cardText = card.innerText || "";
      const title = pickTitleFromText(cardText);
      const url = getProductLink(card);
      const wasNowMatch = cardText.match(wasNowRegex);
      const wasPrice = wasNowMatch ? parsePrice(wasNowMatch[1]) : null;
      const price = wasNowMatch ? parsePrice(wasNowMatch[2]) : null;
      const statusMatch = cardText.match(
        /In Stock|Out of Stock|Pickup Only|In Store Only/i
      );

      return {
        title,
        url,
        image: getImageUrl(card),
        price,
        wasPrice,
        status: statusMatch ? statusMatch[0] : null
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
  if (rawProducts.length === 0 && apiProducts.length === 0) {
    throw new Error("No products rendered...");
  }

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
