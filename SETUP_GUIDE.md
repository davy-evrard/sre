# BigQuery Setup for SRE L3 Activity Report

**Project**: JSM → BigQuery → Looker Studio Pipeline

This guide sets up an automated pipeline to sync Jira Service Management (JSM) tickets to BigQuery for reporting in Looker Studio.

---

## Prerequisites

- GCP Project: `djamo-data`
- Access to Jira Service Management
- GitHub repository: `davy-evrard/sre`
- GCP permissions: Project Editor or equivalent roles

---

## Initial Setup: Set Environment Variables

**⚠️ IMPORTANT**: Update these values before running any commands!

```bash
# GCP Configuration
export PROJECT_ID=djamo-data
export REGION=europe-west1              # ⚠️ UPDATE: Choose your region
export BQ_DATASET=sre
export BQ_LOCATION=EU                   # Multi-region for BigQuery

# Artifact Registry
export AR_REPO=containers
export IMAGE_NAME=jsm-puller
export IMAGE_URI=$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/$IMAGE_NAME:latest

# Service Accounts
export PULLER_SA=jsm-puller-sa
export SA_EMAIL=${PULLER_SA}@${PROJECT_ID}.iam.gserviceaccount.com
export DEPLOYER_SA=gh-deployer
export DEPLOYER_EMAIL=${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com
export SCHEDULER_SA=scheduler-invoker
export SCHEDULER_EMAIL=${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com

# Local paths (adjust based on where you cloned the repo)
export REPO_ROOT=/home/user/sre        # ⚠️ UPDATE: Your repo path
export ROOT_SUB=automated_reports/looker
export PULLER_PATH="$REPO_ROOT/$ROOT_SUB/jsm-puller"
export TRIGGER_PATH="$REPO_ROOT/$ROOT_SUB/trigger-refresh"

# GitHub
export GITHUB_REPO=davy-evrard/sre     # ⚠️ Your GitHub org/user and repo name

# Set default project
gcloud config set project $PROJECT_ID
```

---

## Part I: BigQuery Setup

### 1. Create the Dataset

**Option A: Using Console**
- Go to: BigQuery Console → Create dataset
- Dataset ID: `sre`
- Location: `EU`

**Option B: Using CLI**
```bash
bq mk --dataset --location=$BQ_LOCATION --project=$PROJECT_ID $BQ_DATASET
```

### 2. Create Target & Staging Tables

Run this SQL in BigQuery Console or save to a file and execute:

```sql
-- Target table (final)
CREATE TABLE IF NOT EXISTS `djamo-data.sre.jsm_tickets` (
  `key` STRING NOT NULL,

  -- Basics
  summary STRING,
  description STRING,
  issue_type STRING,
  status STRING,
  priority STRING,
  resolution STRING,
  created TIMESTAMP,
  updated TIMESTAMP,
  resolved TIMESTAMP,

  -- People
  assignee STRING,
  reporter STRING,

  -- Custom fields
  operational_categorization STRING,
  linked_intercom_conversation_ids STRING,
  team ARRAY<STRING>,
  filiale ARRAY<STRING>,
  start_date DATE,

  -- SLA objects (store raw JSON as string)
  ttr_raw_json STRING,    -- customfield_10055 (time to resolution)
  tffr_raw_json STRING,   -- customfield_10056 (time to first response)

  -- Computed / housekeeping
  sla_breached BOOL,
  last_sync TIMESTAMP
)
PARTITION BY DATE(updated)
CLUSTER BY `key`;

-- Staging table (for incremental loads before MERGE)
CREATE TABLE IF NOT EXISTS `djamo-data.sre.jsm_tickets_staging` AS
SELECT * FROM `djamo-data.sre.jsm_tickets` WHERE 1=0;
```

**Verification**:
```bash
bq ls --project_id=$PROJECT_ID $BQ_DATASET
```

### 3. Create Stored Procedure for MERGE

This procedure safely merges staged data into the target table:

```sql
CREATE OR REPLACE PROCEDURE `djamo-data.sre.sp_merge_jsm`()
BEGIN
  MERGE `djamo-data.sre.jsm_tickets` T
  USING `djamo-data.sre.jsm_tickets_staging` S
  ON T.`key` = S.`key`

  WHEN MATCHED THEN UPDATE SET
    summary                          = S.summary,
    description                      = S.description,
    issue_type                       = S.issue_type,
    status                           = S.status,
    priority                         = S.priority,
    resolution                       = S.resolution,
    created                          = S.created,
    updated                          = S.updated,
    resolved                         = S.resolved,
    assignee                         = S.assignee,
    reporter                         = S.reporter,
    operational_categorization       = S.operational_categorization,
    linked_intercom_conversation_ids = S.linked_intercom_conversation_ids,
    team                             = S.team,
    filiale                          = S.filiale,
    start_date                       = S.start_date,
    ttr_raw_json                     = S.ttr_raw_json,
    tffr_raw_json                    = S.tffr_raw_json,
    sla_breached                     = S.sla_breached,
    last_sync                        = CURRENT_TIMESTAMP()

  WHEN NOT MATCHED THEN
    INSERT ROW;

  -- Clear staging table
  DELETE FROM `djamo-data.sre.jsm_tickets_staging` WHERE TRUE;
END;
```

---

## Part II: Google Cloud Platform Setup

### 0. Enable Required APIs

```bash
gcloud services enable \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  bigquery.googleapis.com \
  cloudscheduler.googleapis.com \
  compute.googleapis.com
```

**⏱️ This may take 2-3 minutes**

---

### 1. Create Runtime Service Account (jsm-puller-sa)

This service account will be used by the Cloud Run Job to access BigQuery and Secret Manager.

```bash
gcloud iam service-accounts create $PULLER_SA \
  --display-name="JSM to BigQuery Puller Service Account" \
  2>/dev/null || echo "Service account already exists"
```

### 2. Grant Runtime Service Account Permissions

```bash
# BigQuery permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.dataEditor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/bigquery.jobUser"

# Secret Manager access
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

---

### 3. Store Jira Credentials in Secret Manager

**⚠️ IMPORTANT**: Get these values from your Jira administrator or Bitwarden

```bash
# Set these values
export JIRA_USER=evrard.davy@djamo.io
export JIRA_TOKEN=<YOUR_JIRA_API_TOKEN>    # ⚠️ UPDATE THIS
export JIRA_BASE=https://djamotechsupport.atlassian.net

# Create or update secrets
for SECRET_NAME in jsm_user jsm_token jsm_base; do
  case $SECRET_NAME in
    jsm_user)  SECRET_VALUE="$JIRA_USER" ;;
    jsm_token) SECRET_VALUE="$JIRA_TOKEN" ;;
    jsm_base)  SECRET_VALUE="$JIRA_BASE" ;;
  esac

  if gcloud secrets describe $SECRET_NAME >/dev/null 2>&1; then
    echo "Updating existing secret: $SECRET_NAME"
    echo -n "$SECRET_VALUE" | gcloud secrets versions add $SECRET_NAME --data-file=-
  else
    echo "Creating new secret: $SECRET_NAME"
    echo -n "$SECRET_VALUE" | gcloud secrets create $SECRET_NAME --data-file=-
  fi
done

# Grant service account access to secrets
for SECRET in jsm_user jsm_token jsm_base; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor"
done
```

**Verification**:
```bash
gcloud secrets list
```

---

### 4. Create Artifact Registry Repository

This stores the Docker image for the puller service:

```bash
gcloud artifacts repositories create $AR_REPO \
  --repository-format=docker \
  --location=$REGION \
  --description="Container images for JSM→BQ pipeline" \
  2>/dev/null || echo "Repository already exists"
```

**Verification**:
```bash
gcloud artifacts repositories list --location=$REGION
```

---

### 5. Create GitHub Deployer Service Account

This service account is used by GitHub Actions to deploy your services:

```bash
gcloud iam service-accounts create $DEPLOYER_SA \
  --display-name="GitHub Actions Deployer" \
  2>/dev/null || echo "Service account already exists"
```

### 6. Grant Deployer Service Account Permissions

```bash
# Artifact Registry (push images)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role="roles/artifactregistry.writer"

# Cloud Run (create/update jobs)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role="roles/run.admin"

# Cloud Functions (deploy functions)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role="roles/cloudfunctions.developer"

# Service Account User (deploy as other SAs)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role="roles/iam.serviceAccountUser"

# Allow deployer to impersonate runtime SA
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role="roles/iam.serviceAccountTokenCreator"
```

---

### 7. Setup Workload Identity Federation (WIF)

This allows GitHub Actions to authenticate to GCP without storing keys:

```bash
# Create Workload Identity Pool
gcloud iam workload-identity-pools create github-pool \
  --location="global" \
  --display-name="GitHub OIDC Pool" \
  2>/dev/null || echo "Pool already exists"

# Create OIDC Provider
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location="global" \
  --workload-identity-pool=github-pool \
  --display-name="GitHub OIDC Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  2>/dev/null || echo "Provider already exists"
```

### 8. Link GitHub Repository to Service Account

```bash
# Get project number
PROJECT_NUM=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

# Build provider resource name
POOL=github-pool
PROVIDER=github-provider
PROVIDER_RESOURCE="projects/$PROJECT_NUM/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

# Allow GitHub repo to impersonate deployer SA
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER_EMAIL \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/$PROVIDER_RESOURCE/attribute.repository/$GITHUB_REPO"

# Print values for GitHub secrets (copy these!)
echo ""
echo "=================================================="
echo "📋 SAVE THESE VALUES FOR GITHUB SECRETS:"
echo "=================================================="
echo "WORKLOAD_IDENTITY_PROVIDER = $PROVIDER_RESOURCE"
echo "SERVICE_ACCOUNT = $DEPLOYER_EMAIL"
echo "=================================================="
echo ""
```

---

### 9. Configure GitHub Repository Secrets

Go to: **GitHub → Your Repo → Settings → Secrets and variables → Actions → New repository secret**

Add these secrets:

| Secret Name | Value |
|-------------|-------|
| `GCP_PROJECT_ID` | `djamo-data` |
| `GCP_REGION` | `europe-west1` (or your chosen region) |
| `ARTIFACT_REGISTRY` | `containers` |
| `BQ_DATASET` | `sre` |
| `BQ_LOCATION` | `EU` |
| `WORKLOAD_IDENTITY_PROVIDER` | (from step 8 output) |
| `SERVICE_ACCOUNT` | `gh-deployer@djamo-data.iam.gserviceaccount.com` |
| `REFRESH_SECRET` | (generate with command below) |

**Generate REFRESH_SECRET**:
```bash
export REFRESH_SECRET=$(openssl rand -hex 24)
echo "REFRESH_SECRET = $REFRESH_SECRET"
# Copy this value to GitHub secrets!
```

---

### 10. Build and Deploy the Cloud Run Job (Puller)

**First, build and push the Docker image manually**:

```bash
cd "$PULLER_PATH"

# Configure Docker for Artifact Registry
gcloud auth configure-docker $REGION-docker.pkg.dev --quiet

# Build and push image
docker build -t $IMAGE_URI .
docker push $IMAGE_URI
```

**Create the Cloud Run Job**:

```bash
gcloud run jobs create jsm-puller \
  --image=$IMAGE_URI \
  --region=$REGION \
  --service-account=$SA_EMAIL \
  --set-env-vars="GCP_PROJECT=$PROJECT_ID,BQ_DATASET=$BQ_DATASET,BQ_STAGING_TABLE=jsm_tickets_staging,BQ_LOCATION=$BQ_LOCATION" \
  --max-retries=2 \
  --task-timeout=10m
```

**Test the job**:

```bash
# Run the job manually
gcloud run jobs execute jsm-puller --region=$REGION --wait

# Check logs
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=jsm-puller" \
  --limit 50 --format json
```

**Verify data in BigQuery**:

```sql
SELECT
  `key`,
  summary,
  status,
  updated,
  last_sync
FROM `djamo-data.sre.jsm_tickets`
ORDER BY updated DESC
LIMIT 50;
```

---

### 11. Setup Cloud Scheduler (Daily Sync)

This will run the puller job automatically every day at midnight UTC:

```bash
# Create scheduler service account
gcloud iam service-accounts create $SCHEDULER_SA \
  --display-name="Cloud Scheduler Invoker" \
  2>/dev/null || echo "Service account already exists"

# Grant permission to invoke Cloud Run jobs
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SCHEDULER_EMAIL" \
  --role="roles/run.invoker"

# Create the scheduled job
gcloud scheduler jobs create http jsm-puller-daily \
  --location=$REGION \
  --schedule="0 0 * * *" \
  --time-zone="UTC" \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/jsm-puller:run" \
  --http-method=POST \
  --oauth-service-account-email=$SCHEDULER_EMAIL \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  2>/dev/null || echo "Scheduler job already exists"
```

**Verify**:
```bash
gcloud scheduler jobs list --location=$REGION
```

**Test the scheduler immediately**:
```bash
gcloud scheduler jobs run jsm-puller-daily --location=$REGION
```

---

### 12. Deploy On-Demand Trigger (Cloud Function)

This creates an HTTPS endpoint to manually trigger the puller job:

```bash
cd "$TRIGGER_PATH"

# Deploy the function
gcloud functions deploy trigger-jsm-puller \
  --gen2 \
  --runtime=nodejs20 \
  --region=$REGION \
  --entry-point=default \
  --source=. \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars="PROJECT=$PROJECT_ID,REGION=$REGION,JOB=jsm-puller,SECRET=$REFRESH_SECRET" \
  --timeout=60s \
  --memory=256Mi

# Get the function URL
FUNC_URL=$(gcloud functions describe trigger-jsm-puller \
  --region=$REGION \
  --format='value(serviceConfig.uri)')

echo ""
echo "=================================================="
echo "🎉 TRIGGER FUNCTION DEPLOYED"
echo "=================================================="
echo "Function URL: $FUNC_URL"
echo ""
echo "Test with:"
echo "curl -H \"Authorization: Bearer $REFRESH_SECRET\" \"$FUNC_URL\""
echo ""
echo "With custom time window:"
echo "curl -H \"Authorization: Bearer $REFRESH_SECRET\" \"$FUNC_URL?since=2024-01-01T00:00:00Z\""
echo "=================================================="
echo ""
```

**Test the trigger**:
```bash
curl -H "Authorization: Bearer $REFRESH_SECRET" "$FUNC_URL"
```

Expected response:
```json
{
  "status": "started",
  "job": "jsm-puller",
  "executionId": "jsm-puller-xxxxx"
}
```

---

## Part III: GitHub Actions CI/CD

Your repository already has these workflow files configured:
- `.github/workflows/puller-deploy.yml` - Deploys the Cloud Run Job
- `.github/workflows/trigger-deploy.yml` - Deploys the Cloud Function

**These workflows will automatically deploy when you push changes to the main branch!**

**Test the CI/CD pipeline**:

1. Make a small change to a file in `automated_reports/looker/jsm-puller/`
2. Commit and push to the `main` branch
3. Go to GitHub Actions tab to see the deployment

---

## Part IV: Looker Studio Integration

### 1. Connect Looker Studio to BigQuery

1. Go to: https://lookerstudio.google.com/
2. Create → Data Source
3. Select: BigQuery
4. Choose: `djamo-data` → `sre` → `jsm_tickets`
5. Click: Connect

### 2. Create Your Dashboard

**Recommended visualizations**:

- **Ticket Volume Over Time**: Line chart (x: updated, y: count of key)
- **Status Breakdown**: Pie chart (dimension: status)
- **Priority Distribution**: Bar chart (dimension: priority)
- **Top Assignees**: Scorecard (dimension: assignee, metric: count)
- **SLA Breaches**: Scorecard with filter (sla_breached = true)
- **Team Performance**: Table (dimension: team, metrics: count, avg resolution time)

### 3. Add Manual Refresh Button (Optional)

In Looker Studio, you can add a button that links to your trigger function:

**URL to use**:
```
YOUR_FUNCTION_URL?token=YOUR_REFRESH_SECRET
```

**⚠️ Security Note**: With the new Bearer token authentication, it's safer to create a simple web page that makes the API call using JavaScript to avoid exposing the token in the URL.

---

## Monitoring & Troubleshooting

### Check Cloud Run Job Logs
```bash
gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=jsm-puller" \
  --limit=50 \
  --format=json
```

### Check Cloud Function Logs
```bash
gcloud logging read "resource.type=cloud_function AND resource.labels.function_name=trigger-jsm-puller" \
  --limit=50 \
  --format=json
```

### Query Recent Sync Status
```sql
SELECT
  COUNT(*) as total_tickets,
  MAX(last_sync) as last_sync_time,
  MAX(updated) as most_recent_update,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(last_sync), MINUTE) as minutes_since_sync
FROM `djamo-data.sre.jsm_tickets`;
```

### Common Issues

#### "Permission denied" errors
- Verify service account has correct IAM roles
- Check Secret Manager permissions
- Ensure WIF is configured correctly

#### "Secret not found" errors
- Verify secrets exist: `gcloud secrets list`
- Check secret accessor permissions

#### "No data syncing"
- Check Cloud Scheduler is enabled and running
- Manually trigger job to test: `gcloud run jobs execute jsm-puller --region=$REGION`
- Review logs for errors

#### Docker build fails
- Ensure you're in the correct directory: `cd $PULLER_PATH`
- Check Dockerfile syntax
- Verify package.json and package-lock.json exist

---

## Security Best Practices

✅ **What we've implemented**:
- Workload Identity Federation (no service account keys stored in GitHub)
- Authorization header for trigger function (not URL parameter)
- Minimal IAM permissions (principle of least privilege)
- Secrets in Secret Manager (not in code)
- Structured logging for audit trails

🔒 **Additional recommendations**:
- Regularly rotate Jira API tokens
- Review IAM permissions quarterly
- Enable Cloud Audit Logs
- Set up alerting for job failures
- Implement data retention policies in BigQuery

---

## Cost Estimation

**Expected monthly costs** (approximate):

| Service | Usage | Cost |
|---------|-------|------|
| Cloud Run Jobs | ~30 executions/month, 2-5 min each | $0.50 - $1.00 |
| Cloud Functions | ~50 invocations/month | $0.10 |
| BigQuery Storage | ~1 GB | $0.02 |
| BigQuery Queries | ~100 GB processed | $0.50 |
| Secret Manager | 3 secrets, ~100 accesses | $0.10 |
| Cloud Scheduler | 1 job | $0.10 |
| **Total** | | **~$1.50 - $2.00** |

---

## Maintenance

### Weekly
- Check Looker Studio dashboard for data freshness
- Review error logs if sync stops

### Monthly
- Review BigQuery costs and optimize queries
- Check for security updates in dependencies
- Verify scheduler is running correctly

### Quarterly
- Review and update IAM permissions
- Rotate Jira API tokens
- Update Node.js dependencies

---

## Appendix: Custom Field IDs

These Jira custom field IDs are used in the puller:

| Field ID | Description | Type |
|----------|-------------|------|
| `customfield_10061` | Operational categorization | Cascading select |
| `customfield_10065` | Linked Intercom conversation IDs | String |
| `customfield_10090` | Team | Multi-select |
| `customfield_10083` | Filiale | Multi-select |
| `customfield_10015` | Start date | Date |
| `customfield_10055` | Time to Resolution (TTR) | SLA object |
| `customfield_10056` | Time to First Response (TFFR) | SLA object |

---

## Support & Resources

- **Repository**: https://github.com/davy-evrard/sre
- **GCP Console**: https://console.cloud.google.com/
- **BigQuery Console**: https://console.cloud.google.com/bigquery
- **Looker Studio**: https://lookerstudio.google.com/

---

**Setup completed! 🎉**

If you encounter any issues, check the Troubleshooting section or review the logs using the commands provided above.
