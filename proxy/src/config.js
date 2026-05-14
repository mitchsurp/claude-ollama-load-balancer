import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const CONFIG_PATH = resolve(process.env.CONFIG_PATH || "/data/config.json");

const DEFAULT_CONFIG = {
  strategy: "round-robin",
  backends: [],
  emulatedVersion: null,
};

export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn("Could not load config, using defaults:", e.message);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(balancer) {
  try {
    const data = JSON.stringify(balancer.serialize(), null, 2);
    writeFileSync(CONFIG_PATH, data, "utf8");
  } catch (e) {
    console.warn("Could not save config:", e.message);
  }
}
