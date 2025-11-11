import fetch from "node-fetch";

// Structured logging for Cloud Logging
function log(severity, message, data = {}) {
  console.log(JSON.stringify({
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...data
  }));
}

export default async (req, res) => {
  try {
    // Validate Authorization header (Bearer token)
    const secret = process.env.SECRET;
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";

    if (!token || token !== secret) {
      log("WARNING", "Unauthorized request attempt", {
        sourceIP: req.ip,
        hasAuthHeader: !!authHeader
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const project = process.env.PROJECT;
    const region = process.env.REGION;
    const job = process.env.JOB;
    const since = req.query.since || "";

    log("INFO", "Triggering job", { job, project, region, since: since || "default" });

    // Get access token from metadata service
    const meta = await fetch("http://metadata/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } });

    if (!meta.ok) {
      throw new Error(`Failed to get access token: ${meta.status}`);
    }

    const { access_token } = await meta.json();

    // Trigger Cloud Run Job
    const url = `https://${region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${project}/jobs/${job}:run`;

    const body = since ? {
      overrides: { containerOverrides: [{ name: job, env: [{ name: "SINCE", value: since }] }] }
    } : {};

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errorText = await r.text();
      log("ERROR", "Failed to trigger job", {
        status: r.status,
        error: errorText,
        job,
        url
      });
      return res.status(500).json({
        error: "Failed to trigger job",
        details: errorText
      });
    }

    const result = await r.json();
    log("INFO", "Job triggered successfully", { job, executionId: result?.metadata?.name });

    res.json({
      status: "started",
      job,
      executionId: result?.metadata?.name
    });

  } catch (error) {
    log("ERROR", "Unexpected error in trigger function", {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: "Internal server error",
      message: error.message
    });
  }
};
