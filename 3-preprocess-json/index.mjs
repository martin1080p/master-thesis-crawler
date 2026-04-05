import fs from "fs";
import path from "path";
import zlib from "zlib";
import fse from "fs-extra";

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

// ---- CSV ESCAPE ----
function csvEscape(item, property) {
    const value = item[property];

    if (value === null || value === undefined) return '';

    if (!isNaN(value)) return value;

    return `"${value.replace(/\"/g, '\\"')}"`;
}

function itemExtract(item) {
    const domain = csvEscape(item, 'domain');
    const createdAt = csvEscape(item, 'createdAt');
    const canonicalUrl = csvEscape(item, 'canonicalUrl');
    const error = csvEscape(item, 'error');
    const title = csvEscape(item, 'title');
    const language = csvEscape(item, 'language');
    const metaDescription = csvEscape(item, 'metaDescription');
    const metaKeywords = csvEscape(item, 'metaKeywords');
    //const openGraph = csvEscape(item, 'openGraph');
    const responseDuration = csvEscape(item, 'responseDuration');
    const statusCode = csvEscape(item, 'statusCode');

    const infoStr = [domain, createdAt, canonicalUrl, error, title, language, metaDescription, metaKeywords, responseDuration, statusCode].join(',');
    let links = (item['links'] === undefined) ?
        [] :
        item['links'].map(function (l) {
            linkedDomains.add(l);
            return [domain, l].join(',')
        });

    return { info: infoStr, links }
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

    const domainsHeader = [COLUMNS.join(",")];
    const linksHeader = ["source,target"];

    const domainsLines = [];
    const linksLines = [];

    for (const file of files) {
        console.log(`Processing ${file}`);
        const data = await processGzFile(file);

        for (const item of data) {
            if (!item.domain) continue;

            domains.add(item.domain);
            const extractedItem = itemExtract(item);
            domainsLines.push(extractedItem.info)

            for (const link of extractedItem.links) {
                linksLines.push(link);
            }
        }
    }



    // ---- UNCrawled ----
    const uncrawled = [...linkedDomains].filter(
        l => !domains.has(l) && l.endsWith('.cz')
    );

    // ---- WRITE FILES ----
    await fse.outputFile(DOMAINS_FILE, [domainsHeader, ...domainsLines].join("\n"));
    await fse.outputFile(LINKS_FILE, [linksHeader, ...linksLines].join("\n"));
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