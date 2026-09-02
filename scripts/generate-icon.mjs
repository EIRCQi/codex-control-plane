import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = fileURLToPath(new URL("../public/icon.svg", import.meta.url));
const output = fileURLToPath(new URL("../build/icon.png", import.meta.url));

await mkdir(path.dirname(output), { recursive: true });
await sharp(await readFile(source)).resize(512, 512).png().toFile(output);
console.log("Generated build/icon.png");
