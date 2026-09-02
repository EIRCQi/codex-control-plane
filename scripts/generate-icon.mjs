import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const source = new URL("../public/icon.svg", import.meta.url);
const output = new URL("../build/icon.png", import.meta.url);

await mkdir(path.dirname(output.pathname), { recursive: true });
await sharp(await readFile(source)).resize(512, 512).png().toFile(output);
console.log("Generated build/icon.png");
