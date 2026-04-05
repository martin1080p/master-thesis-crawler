import fs from "fs";
import path from "path";
import zlib from "zlib";
import fse from "fs-extra";
import { stringify } from "csv-stringify/sync";

const INPUT_DIR = "./input";
const DOMAINS_FILE = "./output/domains.csv";
const LINKS_FILE = "./output/links.csv";
const UNCRAWLED_FILE = "./output/uncrawled.txt";

const domains = new Set();
const linkedDomains = new Set();

// ---- FIXED COLUMN ORDER ----
const COLUMNS = [
    "domain",
    "createdAt",
    "canonicalUrl",
    "error",
    "title",
    "language",
    "metaDescription",
    "metaKeywords",
    //"openGraph",
    "responseDuration",
    "statusCode",
];

function itemExtract(item) {
    const infoRow = COLUMNS.map(col => item[col] ?? null);

    const links = (item['links'] === undefined) ?
        [] :
        item['links'].map(function (l) {
            linkedDomains.add(l);
            return [item['domain'], l];
        });

    return { infoRow, links };
}

// ---- DYNAMO UNWRAP ----
function unwrapDynamo(value) {
    if (value?.S !== undefined) return value.S;
    if (value?.N !== undefined) return Number(value.N);
    if (value?.BOOL !== undefined) return value.BOOL;

    if (value?.L !== undefined) {
        return value.L.map(v => unwrapDynamo(v));
    }

    if (value?.M !== undefined) {
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

// ---- PROCESS FILE ----
async function processGzFile(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];

        const stream = fs
            .createReadStream(filePath)
            .pipe(zlib.createGunzip());

        let buffer = "";

        stream.on("data", (chunk) => {
            buffer += chunk.toString();

            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const parsed = safeParse(line.trim());
                if (!parsed) continue;

                const item = unwrapObject(parsed.Item ?? parsed);
                results.push(item);
            }
        });

        stream.on("end", () => {
            if (buffer.trim()) {
                const parsed = safeParse(buffer.trim());
                if (parsed) {
                    results.push(unwrapObject(parsed.Item ?? parsed));
                }
            }
            resolve(results);
        });

        stream.on("error", reject);
    });
}

// ---- MAIN ----
async function run() {
    const files = fs
        .readdirSync(INPUT_DIR)
        .filter(f => f.endsWith(".gz"))
        .map(f => path.join(INPUT_DIR, f));

    console.log(`Found ${files.length} files`);

    const domainsRows = [COLUMNS];
    const linksRows = [["source", "target"]];

    for (const file of files) {
        console.log(`Processing ${file}`);
        const data = await processGzFile(file);

        for (const item of data) {
            if (!item.domain) continue;

            domains.add(item.domain);
            const extractedItem = itemExtract(item);
            domainsRows.push(extractedItem.infoRow);

            for (const link of extractedItem.links) {
                linksRows.push(link);
            }
        }
    }

    // ---- UNCrawled ----
    const uncrawled = [...linkedDomains].filter(
        l => !domains.has(l) && l.endsWith('.cz')
    );

    // ---- WRITE FILES ----
    const csvOpts = { quoted_string: true };
    await fse.outputFile(DOMAINS_FILE, stringify(domainsRows, csvOpts));
    await fse.outputFile(LINKS_FILE, stringify(linksRows, csvOpts));
    await fse.outputFile(
        UNCRAWLED_FILE,
        uncrawled.join("\n") + "\n"
    );

    console.log(`Domains: ${domains.size}`);
    console.log(`Linked domains: ${linkedDomains.size}`);
    console.log(`Uncrawled: ${uncrawled.length}`);
    console.log(`Done`);
}

run().catch(console.error);