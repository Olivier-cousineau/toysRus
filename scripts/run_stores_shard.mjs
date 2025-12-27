import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

const readStores = async () => {
  const raw = await fs.readFile(path.join("stores.json"), "utf8");
  return JSON.parse(raw);
};

const runCommand = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
      }
    });
  });

const runShard = async () => {
  const shardIndex = Number(process.env.SHARD_INDEX || 1);
  const totalShards = Number(process.env.TOTAL_SHARDS || 1);
  const maxStores = process.env.MAX_STORES
    ? Number(process.env.MAX_STORES)
    : null;
  const maxLoadMoreProducts = process.env.MAX_LOADMORE_PRODUCTS || "";

  if (!Number.isFinite(shardIndex) || shardIndex < 1) {
    throw new Error("SHARD_INDEX must be >= 1");
  }
  if (!Number.isFinite(totalShards) || totalShards < 1) {
    throw new Error("TOTAL_SHARDS must be >= 1");
  }

  const stores = await readStores();
  const shardStores = stores.filter(
    (_, index) => index % totalShards === shardIndex - 1
  );
  const limitedStores = maxStores ? shardStores.slice(0, maxStores) : shardStores;

  console.log(
    `[toysrus] shard=${shardIndex}/${totalShards} stores=${limitedStores.length}`
  );

  for (const store of limitedStores) {
    console.log(
      `[toysrus] scraping storeId=${store.storeId} city=${store.city} name=${store.name}`
    );
    await runCommand(
      "node",
      [
        "scripts/scrape_toysrus_store.mjs",
        "--store-id",
        String(store.storeId),
        "--city",
        store.city,
        "--name",
        store.name
      ],
      maxLoadMoreProducts
        ? { MAX_LOADMORE_PRODUCTS: maxLoadMoreProducts }
        : undefined
    );
  }
};

runShard().catch((error) => {
  console.error("[toysrus] shard run failed", error);
  process.exitCode = 1;
});
