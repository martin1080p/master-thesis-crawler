import fs from "fs";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: "eu-north-1" });
const queueUrl = "https://sqs.eu-north-1.amazonaws.com/743206478960/crawler-input";

const MAX_TO_SEND = 100000;
const BATCH_SIZE = 10;

async function main() {
    // Load all domains
    const allDomains = fs.readFileSync("data/domains.txt", "utf8")
        .split("\n").map(x => x.trim()).filter(Boolean);

    // Load sent_domains.txt (if exists)
    let sentDomains = [];
    if (fs.existsSync("data/sent_domains.txt")) {
        sentDomains = fs.readFileSync("data/sent_domains.txt", "utf8")
            .split("\n").map(x => x.trim()).filter(Boolean);
    }

    const sentSet = new Set(sentDomains);

    // Filter remaining domains
    const remaining = allDomains.filter(d => !sentSet.has(d));
    const toSend = remaining.slice(0, MAX_TO_SEND);

    console.log(new Date().toISOString())
    console.log(`Total domains: ${allDomains.length}`);
    console.log(`Already sent: ${sentDomains.length}`);
    console.log(`Remaining: ${remaining.length}`);
    console.log(`Will send now: ${toSend.length}\n`);
    console.log('Sending...')

    for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
        const batchItems = toSend.slice(i, i + BATCH_SIZE);

        const entries = batchItems.map((domain, idx) => ({
            Id: `${i}-${idx}`,
            MessageBody: domain
        }));

        await sqs.send(new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries
        }));

        // Append only those sent now
        fs.appendFileSync("data/sent_domains.txt", batchItems.join("\n") + "\n");

        // console.log(`Sent ${i + batchItems.length}/${toSend.length}`);
    }

    console.log(new Date().toISOString())
    console.log("\nBatch complete.");
}

main();
