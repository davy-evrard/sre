# Understanding the Git → CI/CD → BigQuery Pipeline

This document explains how code changes flow from your local machine all the way to data in BigQuery.

---

## 🔄 The Complete Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        YOUR LOCAL MACHINE                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. You write code:                                                      │
│     - TypeScript in src/index.ts                                         │
│     - Update package.json                                                │
│     - Modify Dockerfile                                                  │
│                                                                           │
│  2. You commit changes:                                                  │
│     git add .                                                            │
│     git commit -m "feat: add new feature"                                │
│                                                                           │
│  3. You push to GitHub:                                                  │
│     git push origin main                                                 │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ Push triggers GitHub Actions
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            GITHUB                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  4. GitHub receives your code:                                           │
│     - Stores it in the repository                                        │
│     - Detects that workflows should run                                  │
│                                                                           │
│  5. GitHub Actions triggers (CI/CD):                                     │
│     - Reads .github/workflows/puller-deploy.yml                          │
│     - Reads .github/workflows/trigger-deploy.yml                         │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ GitHub Actions starts deployment
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      GITHUB ACTIONS (CI/CD)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  6. Workflow: puller-deploy.yml                                          │
│     ┌─────────────────────────────────────────────────────────┐         │
│     │ Step 1: Checkout code                                   │         │
│     │ Step 2: Authenticate to GCP (via Workload Identity)     │         │
│     │ Step 3: Build Docker image (compiles TypeScript → JS)   │         │
│     │ Step 4: Push image to Artifact Registry                 │         │
│     │ Step 5: Deploy to Cloud Run Job (jsm-puller)            │         │
│     └─────────────────────────────────────────────────────────┘         │
│                                                                           │
│  7. Workflow: trigger-deploy.yml                                         │
│     ┌─────────────────────────────────────────────────────────┐         │
│     │ Step 1: Checkout code                                   │         │
│     │ Step 2: Authenticate to GCP                             │         │
│     │ Step 3: Deploy to Cloud Functions (trigger-refresh)     │         │
│     └─────────────────────────────────────────────────────────┘         │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ Deploys to Google Cloud Platform
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    GOOGLE CLOUD PLATFORM (GCP)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  8. Cloud Run Job (jsm-puller):                                          │
│     - Image stored in Artifact Registry                                  │
│     - Job is created/updated with latest code                            │
│     - Configured with environment variables:                             │
│       • GCP_PROJECT = djamo-data                                         │
│       • BQ_DATASET = sre                                                 │
│       • BQ_STAGING_TABLE = jsm_tickets_staging                           │
│                                                                           │
│  9. Cloud Function (trigger-refresh):                                    │
│     - Function deployed with latest code                                 │
│     - HTTPS endpoint created                                             │
│     - Can trigger the Cloud Run Job manually                             │
│                                                                           │
│  10. Cloud Scheduler:                                                    │
│     - Triggers jsm-puller automatically (daily at midnight)              │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ Job runs and processes data
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     RUNTIME EXECUTION FLOW                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  11. When jsm-puller runs:                                               │
│      ┌──────────────────────────────────────────────────────┐           │
│      │ a) Fetch credentials from Secret Manager             │           │
│      │    - jsm_base, jsm_user, jsm_token                   │           │
│      │                                                       │           │
│      │ b) Call Jira API                                     │           │
│      │    GET /rest/api/3/search?jql=updated >= "..."       │           │
│      │                                                       │           │
│      │ c) Transform Jira data to BigQuery format            │           │
│      │    - Convert custom fields                           │           │
│      │    - Map user objects to display names               │           │
│      │    - Parse dates and arrays                          │           │
│      │                                                       │           │
│      │ d) Insert into staging table                         │           │
│      │    INSERT INTO djamo-data.sre.jsm_tickets_staging    │           │
│      │                                                       │           │
│      │ e) Execute MERGE operation                           │           │
│      │    MERGE djamo-data.sre.jsm_tickets T                │           │
│      │    USING djamo-data.sre.jsm_tickets_staging S        │           │
│      │    ON T.key = S.key                                  │           │
│      │    WHEN MATCHED THEN UPDATE...                       │           │
│      │    WHEN NOT MATCHED THEN INSERT...                   │           │
│      │                                                       │           │
│      │ f) Clean up staging table                            │           │
│      │    DELETE FROM jsm_tickets_staging                   │           │
│      └──────────────────────────────────────────────────────┘           │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ Data is now in BigQuery
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BIGQUERY DATABASE                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  12. BigQuery Dataset: djamo-data.sre                                    │
│      ┌────────────────────────────────────────────────────┐             │
│      │ Table: jsm_tickets                                 │             │
│      │ ├─ key (ticket ID)                                 │             │
│      │ ├─ summary                                         │             │
│      │ ├─ status                                          │             │
│      │ ├─ team (ARRAY)                                    │             │
│      │ ├─ updated (partitioned by this)                   │             │
│      │ ├─ last_sync                                       │             │
│      │ └─ ... (20 columns total)                          │             │
│      └────────────────────────────────────────────────────┘             │
│                                                                           │
│  13. Data is queryable:                                                  │
│      SELECT * FROM `djamo-data.sre.jsm_tickets`                          │
│      WHERE updated >= CURRENT_DATE() - 7                                 │
│                                                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ Looker Studio connects to BigQuery
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         LOOKER STUDIO                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  14. Looker Studio Dashboard:                                            │
│      - Connects to BigQuery data source                                  │
│      - Creates visualizations (charts, tables, scorecards)               │
│      - Users see up-to-date ticket data                                  │
│      - Can manually trigger refresh via trigger-refresh function         │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Detailed Explanation by Component

### 1. **Git Repository (Version Control)**

**What it does:**
- Stores all your code history
- Tracks changes over time
- Allows collaboration (branches, pull requests)

**Your repository structure:**
```
sre/
├── .github/workflows/       ← CI/CD configuration
├── automated_reports/
│   └── looker/
│       ├── jsm-puller/     ← TypeScript code
│       ├── trigger-refresh/ ← TypeScript code
│       └── infra/          ← SQL schemas
```

**Key point:** Git is just storage. It doesn't run anything by itself.

---

### 2. **GitHub Actions (CI/CD)**

**What CI/CD means:**
- **CI** = Continuous Integration (automatically test code)
- **CD** = Continuous Deployment (automatically deploy code)

**How it works:**

1. **Trigger**: You push code to GitHub
2. **Detection**: GitHub sees files changed in specific paths:
   ```yaml
   on:
     push:
       branches: [ main ]
       paths:
         - 'automated_reports/looker/jsm-puller/**'
   ```
3. **Execution**: GitHub Actions runs the workflow steps

**Your workflows:**

#### `puller-deploy.yml`:
```yaml
# What it does:
1. Checks out your code from Git
2. Logs into GCP using Workload Identity Federation (no keys!)
3. Builds a Docker image:
   - Installs npm dependencies
   - Compiles TypeScript to JavaScript
   - Creates a container with Node.js + your code
4. Pushes image to Artifact Registry
5. Creates/updates Cloud Run Job with new image
```

#### `trigger-deploy.yml`:
```yaml
# What it does:
1. Checks out your code from Git
2. Logs into GCP
3. Deploys Cloud Function with your TypeScript code
```

**Key point:** CI/CD is the automation that takes your code from Git and deploys it to GCP.

---

### 3. **Google Cloud Platform (GCP)**

**Where your code runs:**

#### **Artifact Registry**
- Docker image storage
- Like a warehouse for container images
- Your jsm-puller image lives here

#### **Cloud Run Job**
- Runs your jsm-puller container
- Executes TypeScript code (compiled to JavaScript)
- Triggered by:
  - Cloud Scheduler (automatic, daily)
  - Cloud Function (manual, via HTTP)
  - Manual execution (gcloud command)

#### **Cloud Function**
- Runs your trigger-refresh code
- HTTP endpoint that anyone can call (with token)
- Can trigger the Cloud Run Job on-demand

#### **Secret Manager**
- Stores sensitive data:
  - Jira username
  - Jira API token
  - Jira base URL
- Your code reads secrets at runtime (not in Git!)

---

### 4. **BigQuery (Database)**

**What it stores:**
- Jira ticket data
- Historical changes (via MERGE upserts)

**How data gets there:**

1. **jsm-puller runs** (either scheduled or manually)
2. **Calls Jira API**: "Give me all tickets updated in the last hour"
3. **Transforms data**: Converts Jira format → BigQuery format
4. **Stages data**: Inserts into `jsm_tickets_staging` table
5. **Merges data**:
   - If ticket exists: UPDATE
   - If ticket is new: INSERT
6. **Cleans up**: Deletes staging data

**Tables:**
- `jsm_tickets` - Main table (production data)
- `jsm_tickets_staging` - Temporary table (current batch)

---

### 5. **Looker Studio (Visualization)**

**What it does:**
- Connects to BigQuery
- Reads data from `djamo-data.sre.jsm_tickets`
- Creates charts, graphs, dashboards
- Users see visual reports

**No code involved here** - just SQL queries and drag-drop visualization.

---

## 🔗 How They Connect

### **Connection 1: Git → GitHub Actions**
```
Push code to Git
    ↓
GitHub Actions detects push
    ↓
Workflow YAML file is read
    ↓
Steps execute (build, deploy)
```

### **Connection 2: GitHub Actions → GCP**
```
GitHub Actions authenticates
    ↓
Uses Workload Identity Federation (WIF)
    ↓
Gets temporary GCP credentials
    ↓
Deploys code to Cloud Run / Cloud Functions
```

### **Connection 3: GCP Services → BigQuery**
```
Cloud Run Job executes
    ↓
Reads code from deployed container
    ↓
Fetches Jira data
    ↓
Writes to BigQuery via SDK
    ↓
Data is stored in tables
```

### **Connection 4: BigQuery → Looker Studio**
```
Looker Studio sends SQL query
    ↓
BigQuery executes query
    ↓
Returns result rows
    ↓
Looker displays as charts
```

---

## 🎯 Example: Making a Code Change

Let's say you want to add a new Jira field to track.

**Step-by-step:**

### **Step 1: Local Development**
```bash
# Edit TypeScript code
vim automated_reports/looker/jsm-puller/src/index.ts

# Add new field to fetch
const fields = [
  "summary",
  "customfield_12345",  // ← New field!
]

# Compile locally to test
npm run build
```

### **Step 2: Commit & Push**
```bash
git add automated_reports/looker/jsm-puller/src/index.ts
git commit -m "feat: add new custom field tracking"
git push origin main
```

### **Step 3: GitHub Actions (Automatic)**
```
GitHub receives push
    ↓
Detects change in jsm-puller/**
    ↓
Runs puller-deploy.yml workflow
    ↓
Builds Docker image with new code
    ↓
Pushes to Artifact Registry
    ↓
Updates Cloud Run Job
```

**You see progress in:** GitHub Actions tab

### **Step 4: GCP Deployment (Automatic)**
```
Cloud Run Job is updated
    ↓
New container image with your code
    ↓
Next scheduled run uses new code
```

**You can verify in:** GCP Console → Cloud Run

### **Step 5: Runtime Execution**
```
Cloud Scheduler triggers at midnight
    ↓
Cloud Run Job starts
    ↓
Runs your NEW code
    ↓
Fetches NEW field from Jira
    ↓
Writes to BigQuery
```

**You can verify in:** Cloud Logging

### **Step 6: Data in BigQuery**
```sql
SELECT
  key,
  customfield_12345  -- ← New field appears!
FROM `djamo-data.sre.jsm_tickets`
LIMIT 10;
```

**You can verify in:** BigQuery Console

### **Step 7: Looker Studio**
```
Refresh your dashboard
    ↓
New field is available
    ↓
Add to visualizations
```

---

## 🔐 Authentication Flow

**How GitHub Actions can deploy to GCP without API keys:**

```
1. GitHub Actions requests token
   "I'm github.com/davy-evrard/sre, please give me access"

2. Google verifies identity via Workload Identity Federation
   "Yes, that repo is allowed to use gh-deployer service account"

3. Google issues temporary token (valid 1 hour)
   "Here's your token: eyJhbGc..."

4. GitHub Actions uses token to deploy
   "Deploy this image using my token"

5. Token expires after deployment
   "Token is now invalid, cannot be reused"
```

**Why this is secure:**
- No API keys stored in GitHub
- Tokens expire automatically
- Audit logs track all actions
- Can be revoked immediately if needed

---

## 📊 Data Flow Diagram

```
Jira Cloud
    ↓ (API call every hour)
jsm-puller code
    ↓ (Transform data)
BigQuery staging table
    ↓ (MERGE operation)
BigQuery main table
    ↓ (SQL query)
Looker Studio
    ↓ (Visual display)
End User Dashboard
```

---

## 🛠️ When Things Run

| Event | Trigger | What Happens | Frequency |
|-------|---------|--------------|-----------|
| `git push` to main | Code change | CI/CD deploys new version | Every push |
| Cloud Scheduler | Time = midnight UTC | jsm-puller runs | Daily |
| HTTP request to trigger-refresh | Manual | jsm-puller runs immediately | On-demand |
| BigQuery query | Looker Studio refresh | Data is read | On-demand |

---

## 🎓 Summary

**Git** = Where your code lives
**GitHub Actions** = Automation that deploys your code
**GCP Cloud Run/Functions** = Where your code runs
**BigQuery** = Where your data is stored
**Looker Studio** = Where users see data

**The flow:**
```
Code in Git
    → Deployed by GitHub Actions
        → Runs on GCP
            → Fetches from Jira
                → Stores in BigQuery
                    → Displayed in Looker
```

---

## ❓ Common Questions

**Q: Do I need to manually deploy after pushing code?**
A: No! GitHub Actions does it automatically when you push to `main`.

**Q: How long does deployment take?**
A: Usually 3-5 minutes (build Docker image, push, deploy).

**Q: Can I test changes before production?**
A: Yes! Create a feature branch, test locally, then merge to main.

**Q: What if deployment fails?**
A: Check GitHub Actions logs. The old version keeps running until new deployment succeeds.

**Q: How do I see what's currently running in production?**
A: Check GCP Console → Cloud Run → jsm-puller (shows current image version).

**Q: Can I rollback to an old version?**
A: Yes! Either revert Git commit or manually deploy old image from Artifact Registry.

---

## 📚 Further Reading

- **GitHub Actions**: [docs.github.com/actions](https://docs.github.com/actions)
- **Cloud Run**: [cloud.google.com/run/docs](https://cloud.google.com/run/docs)
- **BigQuery**: [cloud.google.com/bigquery/docs](https://cloud.google.com/bigquery/docs)
- **Workload Identity Federation**: [cloud.google.com/iam/docs/workload-identity-federation](https://cloud.google.com/iam/docs/workload-identity-federation)
