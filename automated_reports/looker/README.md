# SRE — Looker Automated Reports

This repository hosts an automated pipeline that syncs Jira Service Management (JSM) tickets to BigQuery for reporting in Looker Studio.

**Tech Stack**: TypeScript, Node.js 20, Google Cloud Platform (Cloud Run Jobs, Cloud Functions Gen2, BigQuery)

**Project**: `djamo-data` | **Dataset**: `sre` | **Table**: `jsm_tickets`

## Architecture

```
JSM (Jira) → jsm-puller (Cloud Run Job) → BigQuery → Looker Studio
                    ↑
            trigger-refresh (Cloud Function)
```

## Repository Structure

```
automated_reports/looker/
├── infra/
│   └── bigquery_schema.sql        # BigQuery table schema & stored procedure
├── jsm-puller/                    # Main sync service (TypeScript)
│   ├── src/
│   │   └── index.ts               # TypeScript source code
│   ├── Dockerfile                 # Multi-stage build with TypeScript compilation
│   ├── package.json               # Dependencies & build scripts
│   └── tsconfig.json              # TypeScript configuration
└── trigger-refresh/               # Manual trigger service (TypeScript)
    ├── src/
    │   └── index.ts               # TypeScript source code
    ├── package.json               # Dependencies & build scripts
    └── tsconfig.json              # TypeScript configuration
```

## Services

### 1. **jsm-puller** (Cloud Run Job)
- Fetches JSM tickets updated since last sync (default: last 1 hour)
- Transforms and loads data into BigQuery staging table
- Executes MERGE operation to upsert into target table
- Runs on schedule via Cloud Scheduler (daily at midnight UTC)

**Custom Fields Synced**:
- Operational categorization
- Linked Intercom conversation IDs
- Team, Filiale (multi-select)
- Start date
- SLA metrics (TTR, TFFR)

### 2. **trigger-refresh** (Cloud Function Gen2)
- HTTP endpoint to manually trigger jsm-puller job
- Secured with Bearer token authentication
- Supports custom time window via `?since=` parameter

## Quick Start

For detailed setup instructions, see **[SETUP_GUIDE.md](../../SETUP_GUIDE.md)** in the repository root.

### Prerequisites
- GCP Project: `djamo-data`
- Node.js 20+
- Access to Jira Service Management
- GCP permissions (Project Editor or equivalent)

### Local Development

```bash
# jsm-puller
cd jsm-puller
npm install
npm run build      # Compile TypeScript
npm run dev        # Build and run

# trigger-refresh
cd trigger-refresh
npm install
npm run build      # Compile TypeScript
```

### Deployment

Both services are automatically deployed via GitHub Actions when pushing to `main`:
- **jsm-puller**: Builds Docker image and deploys to Cloud Run Job
- **trigger-refresh**: Deploys to Cloud Functions Gen2

**Required GitHub Secrets**:
- `GCP_PROJECT_ID` = `djamo-data`
- `GCP_REGION` = (e.g., `europe-west1`)
- `BQ_DATASET` = `sre`
- `BQ_LOCATION` = `EU`
- `WORKLOAD_IDENTITY_PROVIDER` = (WIF provider resource name)
- `SERVICE_ACCOUNT` = `gh-deployer@djamo-data.iam.gserviceaccount.com`
- `REFRESH_SECRET` = (random token for trigger authentication)

## Configuration

### Environment Variables

**jsm-puller**:
- `GCP_PROJECT` - GCP project ID
- `BQ_DATASET` - BigQuery dataset (default: `sre`)
- `BQ_STAGING_TABLE` - Staging table name (default: `jsm_tickets_staging`)
- `BQ_LOCATION` - BigQuery location (default: `EU`)
- `SINCE` - Optional: Override sync time window (ISO 8601 format)

**trigger-refresh**:
- `PROJECT` - GCP project ID
- `REGION` - GCP region
- `JOB` - Cloud Run Job name (`jsm-puller`)
- `SECRET` - Bearer token for authentication

### Secret Manager

The following secrets must be stored in GCP Secret Manager:
- `jsm_base` - Jira base URL (e.g., `https://djamotechsupport.atlassian.net`)
- `jsm_user` - Jira user email
- `jsm_token` - Jira API token

## Usage

### Manual Trigger

```bash
# Using curl with Bearer token
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
     "https://REGION-PROJECT_ID.cloudfunctions.net/trigger-jsm-puller"

# With custom time window
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
     "https://REGION-PROJECT_ID.cloudfunctions.net/trigger-jsm-puller?since=2024-01-01T00:00:00Z"
```

### Query Data

```sql
SELECT
  `key`,
  summary,
  status,
  team,
  updated,
  last_sync
FROM `djamo-data.sre.jsm_tickets`
ORDER BY updated DESC
LIMIT 50;
```

## Monitoring

```bash
# View jsm-puller logs
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=jsm-puller" \
  --limit=50 --format=json

# View trigger-refresh logs
gcloud logging read "resource.type=cloud_function AND resource.labels.function_name=trigger-jsm-puller" \
  --limit=50 --format=json
```

## Documentation

- **[SETUP_GUIDE.md](../../SETUP_GUIDE.md)** - Complete setup and configuration guide
- **[bigquery_schema.sql](infra/bigquery_schema.sql)** - Database schema and stored procedures

## Support

For issues or questions, check the [SETUP_GUIDE.md](../../SETUP_GUIDE.md) troubleshooting section.
