import axios from 'axios';
import https from "https";
import { parse } from 'tldts';
import { Parser } from "htmlparser2";
import { DynamoDBClient, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";

const TIMEOUT = 10000; // 10 seconds
const TABLE_NAME = 'crawled_links';
const MAX_CONCURRENCY = 20;

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = new DynamoDBClient({ region: "eu-north-1" });

async function _storeLinksToDb(items) {
    const batches = [];

    for (let i = 0; i < items.length; i += 25) {
        batches.push(items.slice(i, i + 25));
    }

    for (const batch of batches) {
        await new Promise((resolve, reject) => {
            const requestItems = {
                RequestItems: {
                    [TABLE_NAME]: batch.map(item => {
                        const dynamoItem = {
                            domain: { S: item.domain },
                            createdAt: { S: item.createdAt },
                        };

                        if (item.responseDuration) dynamoItem.responseDuration = { N: String(item.responseDuration) };
                        if (item.statusCode) dynamoItem.statusCode = { N: String(item.statusCode) };

                        if (item.title) dynamoItem.title = { S: item.title };
                        if (item.metaDescription) dynamoItem.metaDescription = { S: item.metaDescription };
                        if (item.metaKeywords) dynamoItem.metaKeywords = { S: item.metaKeywords };
                        if (item.canonicalUrl) dynamoItem.canonicalUrl = { S: item.canonicalUrl };
                        if (item.language) dynamoItem.language = { S: item.language };

                        if (item.openGraph && Object.keys(item.openGraph).length > 0) {
                            dynamoItem.openGraph = { S: JSON.stringify(item.openGraph) };
                        }

                        if (item.links && item.links.length > 0) {
                            dynamoItem.links = {
                                L: item.links.map(link => ({ S: link }))
                            };
                        }

                        if (item.error) {
                            dynamoItem.error = { S: item.error };
                        }

                        return {
                            PutRequest: { Item: dynamoItem }
                        };
                    })
                }
            };

            const command = new BatchWriteItemCommand(requestItems);
            client.send(command).then(() => resolve()).catch(reject);
        });
    }
}

function _getRegisteredDomain(url) {
    try {
        const parsed = parse(url);
        if (parsed.domain && parsed.publicSuffix) {
            return `${parsed.domain}`.toLowerCase();
        }
    } catch (err) {
        return "";
    }
    return "";
}

// With parser
async function _crawlDomain(domain) {
    const baseUrl = `https://${domain}`;
    const baseDomain = _getRegisteredDomain(baseUrl);

    const startTime = Date.now();

    let title = null;
    let metaDescription = null;
    let metaKeywords = null;
    let canonicalUrl = null;
    let language = null;
    let openGraph = {};
    const externalDomains = new Set();

    let currentTag = null;

    try {
        const response = await axios.get(baseUrl, {
            timeout: TIMEOUT,
            httpsAgent: agent,
            validateStatus: (status) => status < 600,
            responseType: "stream",
        });

        const result = {
            domain,
            statusCode: response.status,
            responseDuration: Date.now() - startTime,
            createdAt: new Date().toISOString()
        };

        if (response.status >= 400) {
            result.error = `HTTP Error ${response.status}`;
            return result;
        }

        // Streaming HTML parser
        const parser = new Parser(
            {
                onopentag(name, attribs) {
                    currentTag = name;

                    // <html lang="...">
                    if (name === "html" && attribs.lang) {
                        language = attribs.lang;
                    }

                    // <meta ...>
                    if (name === "meta") {
                        const prop = attribs.property || attribs.name;
                        const content = attribs.content;

                        if (!prop || !content) return;

                        // meta description
                        if (prop.toLowerCase() === "description") {
                            metaDescription = content;
                        }
                        // meta keywords
                        if (prop.toLowerCase() === "keywords") {
                            metaKeywords = content;
                        }
                        // og:xxx
                        if (prop.startsWith("og:")) {
                            openGraph[prop] = content;
                        }
                    }

                    // canonical link
                    if (name === "link" && attribs.rel === "canonical" && attribs.href) {
                        canonicalUrl = attribs.href;
                    }

                    // anchor links for external domains
                    if (name === "a" && attribs.href) {
                        try {
                            const absoluteUrl = new URL(attribs.href, baseUrl).href;
                            const d = _getRegisteredDomain(absoluteUrl);
                            if (d && d !== baseDomain) {
                                externalDomains.add(d);
                            }
                        } catch (_) { }
                    }
                },

                ontext(text) {
                    if (currentTag === "title" && !title) {
                        const trimmed = text.trim();
                        if (trimmed.length > 0) {
                            title = trimmed;
                        }
                    }
                },

                onclosetag() {
                    currentTag = null;
                }
            },
            { decodeEntities: true }
        );

        await new Promise((resolve, reject) => {
            response.data.on("data", chunk => parser.write(chunk.toString("utf8")));
            response.data.on("end", () => {
                parser.end();
                resolve();
            });
            response.data.on("error", reject);
        });

        // Final result
        result.title = title;
        result.metaDescription = metaDescription;
        result.metaKeywords = metaKeywords;
        result.canonicalUrl = canonicalUrl;
        result.language = language;
        result.openGraph = openGraph;
        result.links = Array.from(externalDomains);

        return result;

    } catch (error) {
        return {
            domain,
            error: error.message || String(error),
            createdAt: new Date().toISOString()
        };
    }
}


export const handler = async (event) => {
    const results = [];
    let index = 0;
    const batchItemFailures = [];

    async function _worker() {
        while (index < event.Records.length) {
            const currentIndex = index++;
            const record = event.Records[currentIndex];
            try {
                const result = await _crawlDomain(record.body);
                results.push(result);
            } catch (err) {
                batchItemFailures.push({ itemIdentifier: record.messageId });
            }
        }
    }

    // Start N workers
    const workers = Array.from({ length: MAX_CONCURRENCY }, () => _worker());
    await Promise.all(workers);

    await _storeLinksToDb(results);

    return { results, batchItemFailures };
};

