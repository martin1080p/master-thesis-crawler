import fs from "fs";
import path from "path";
import zlib from "zlib";
import fse from "fs-extra";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_DIR = "./input";
const OUTPUT_FILE = "./output/merged.json";
const UNCRAWLED_FILE = "./output/uncrawled.txt";
const linkedDomains = new Set();

function unwrapDynamo(value) {
    if (value === null || value === undefined) return value;

    if (value.S !== undefined) return value.S;
    if (value.N !== undefined) return Number(value.N);
    if (value.BOOL !== undefined) return value.BOOL;

    if (value.L !== undefined) {
        const links = value.L.map(unwrapDynamo);
        links.forEach(linkedDomains.add, linkedDomains)
        return links;
    }

    if (value.M !== undefined) {
        return unwrapObject(value.M);
    }

    return value;
}

function unwrapObject(obj) {
    const result = {};
    for (const key of Object.keys(obj)) {
        result[key] = unwrapDynamo(obj[key]);
    }
    return result;
}

function safeParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

async function processGzFile(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];

        const gunzip = zlib.createGunzip();
        const stream = fs.createReadStream(filePath).pipe(gunzip);

        let buffer = "";

        stream.on("data", (chunk) => {
            buffer += chunk.toString();

            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const parsed = safeParse(line.trim());
                if (!parsed) continue;

                const item = parsed.Item ?? parsed;
                results.push(unwrapObject(item));
            }
        });

        stream.on("end", () => {
            if (buffer.trim()) {
                const parsed = safeParse(buffer.trim());
                if (parsed) results.push(unwrapObject(parsed.Item ?? parsed));
            }
            resolve(results);
        });

        stream.on("error", reject);
    });
}

async function run() {
    const files = fs
        .readdirSync(INPUT_DIR)
        .filter((f) => f.endsWith(".gz"))
        .map((f) => path.join(INPUT_DIR, f));

    console.log(`Found ${files.length} files`);

    const all = [];

    const primaryDomains = new Set();

    for (const file of files) {
        console.log(`Processing ${file}`);
        const data = await processGzFile(file);
        console.log(`  → ${data.length}`);

        all.push(...data);

        data.forEach(d => primaryDomains.add(d.domain))
    }

    // compute truly uncrawled
    const uncrawled = [...linkedDomains].filter(
        (d) => !primaryDomains.has(d) && d.includes('.cz')
    );

    // write output
    await fse.writeJson(OUTPUT_FILE, all, { spaces: 2 });

    await fse.outputFile(
        UNCRAWLED_FILE,
        uncrawled.join("\n") + "\n"
    );

    console.log(`Primary domains: ${primaryDomains.size}`);
    console.log(`Linked domains: ${linkedDomains.size}`);
    console.log(`Uncrawled domains: ${uncrawled.length}`);

    console.log(`Done → ${OUTPUT_FILE}`);
}

run().catch(console.error);