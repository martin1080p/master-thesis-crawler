# dp-crawler

A three-stage web crawling pipeline for Czech websites (`.cz` domains), collecting metadata and building a domain link graph.

## Pipeline

### 1. [1-enque-domains/](1-enque-domains/) — Queue domains
Reads domains from `data/domains.txt` and sends them in batches to an AWS SQS queue (`crawler-input`, region `eu-north-1`). Tracks already-sent domains in `data/sent_domains.txt` to allow resuming.

```bash
cd 1-enque-domains
node index.mjs
```

### 2. [2-lambda-crawler/](2-lambda-crawler/) — Crawl (AWS Lambda)
Deployed AWS Lambda function. Consumes SQS messages, crawls each domain, and stores results in DynamoDB (`crawled_links` table). Extracts title, meta description, keywords, language, Open Graph tags, canonical URL, and outbound domain links.

> Cannot be run locally — deployed to AWS Lambda.

### 3. [3-preprocess-json/](3-preprocess-json/) — Preprocess results
Reads gzipped DynamoDB export files from `input/`, then produces:
- `output/domains.csv` — all crawled domains with their metadata
- `output/links.csv` — source → target domain edge list
- `output/uncrawled.txt` — `.cz` domains that were linked to but not yet crawled

```bash
cd 3-preprocess-json
node index.mjs
```
